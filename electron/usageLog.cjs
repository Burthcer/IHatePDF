/**
 * Local usage log: one JSON object per line, written to a file on this PC and
 * never sent anywhere. It records what the app did (tool, sizes, time, success
 * or error, memory and CPU, temp files), never what the documents contain:
 * no file names, no text, no paths of user files.
 *
 * Where: <userData>/logs/usage-<pc>.log, or the folder in IHP_LOG_DIR / the
 * machine-wide config (%ProgramData%\IHatePDF\config.json, "logDir"), so a lab
 * can point every PC at a shared drive (each PC writes its own file, and a
 * Deep Freeze restart can't wipe it).
 * Size: the log rotates at 5 MB and keeps 3 files, 15 MB at most per PC.
 * Off: IHP_LOG=off, "logging": false in the config, or the switch in the app.
 *
 * Config (all optional): { "logging": true, "logDir": "\\\\server\\share\\ihatepdf",
 *   "salt": "any text" }. "salt" makes the anonymous user ids the same on every
 * PC and after a Deep Freeze restart.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MB = 1024 * 1024;
const MAX_FILE_BYTES = Number(process.env.IHP_LOG_MAX_BYTES) || 5 * MB;
const KEEP_FILES = 3;
const SAMPLE_MS = 500;

/** File names are never logged: anything that looks like one is replaced. */
const FILE_LIKE = /[^\\/:*?"<>|\r\n]{1,120}\.(pdf|docx?|xlsx?|pptx?|jpe?g|png|gif|bmp|tiff?|webp|html?|zip|md|txt|csv)\b/gi;
const PATH_LIKE = /\b[a-z]:\\[^\s"']*/gi;

const ERROR_CLASSES = [
  [/stopped to protect this pc|memory/i, 'memory'],
  [/password|encrypt/i, 'password'],
  [/damaged|corrupt|invalid pdf|not a pdf|repair|xref|unexpected end/i, 'damaged-file'],
  [/cancel/i, 'cancelled'],
  [/time(d)? ?out/i, 'timeout'],
  [/unsupported|not supported|can.t read|cannot read/i, 'unsupported'],
  [/no space|enospc|disk/i, 'disk'],
];

/** A short, file-name-free class and message for an error. */
function describeError(message) {
  const text = String(message ?? '');
  const cls = (ERROR_CLASSES.find(([re]) => re.test(text)) || [null, 'other'])[1];
  return { errorClass: cls, errorText: text.replace(PATH_LIKE, '<path>').replace(FILE_LIKE, '<file>').slice(0, 120) };
}

function create({ app, getContents, env = process.env, platform = process.platform } = {}) {
  const userData = app?.getPath?.('userData') || path.join(os.homedir(), '.ihatepdf');
  const settingsFile = path.join(userData, 'log-settings.json');
  const readJson = (file) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return {};
    }
  };
  const machineConfigFile = platform === 'win32' && env.ProgramData ? path.join(env.ProgramData, 'IHatePDF', 'config.json') : null;
  const machine = machineConfigFile ? readJson(machineConfigFile) : {};
  const user = readJson(settingsFile);

  let enabled = String(env.IHP_LOG || '').toLowerCase() !== 'off' && machine.logging !== false && user.logging !== false;
  const wantedDir = env.IHP_LOG_DIR || machine.logDir || path.join(userData, 'logs');

  const hostname = os.hostname();
  const pcId = crypto.createHash('sha256').update(`pc|${hostname}`).digest('hex').slice(0, 8);
  const salt = machine.salt || user.salt || (user.salt = crypto.randomBytes(8).toString('hex'));
  if (!machine.salt && !fs.existsSync(settingsFile)) {
    try {
      fs.mkdirSync(userData, { recursive: true });
      fs.writeFileSync(settingsFile, JSON.stringify(user));
    } catch {
      // the salt just stays for this session
    }
  }
  const username = (() => {
    try {
      return os.userInfo().username;
    } catch {
      return 'unknown';
    }
  })();
  const userId = crypto.createHash('sha256').update(`${salt}|${username}`).digest('hex').slice(0, 10);
  const sessionId = crypto.randomUUID().slice(0, 8);

  // Pick a folder we can write to; fall back to the local one.
  let dir = wantedDir;
  const ensureDir = (d) => {
    fs.mkdirSync(d, { recursive: true });
    fs.accessSync(d, fs.constants.W_OK);
    return d;
  };
  try {
    ensureDir(dir);
  } catch {
    dir = path.join(userData, 'logs');
    try {
      ensureDir(dir);
    } catch {
      enabled = false;
    }
  }
  const file = path.join(dir, `usage-${pcId}.log`);
  const fileAt = (n) => (n === 0 ? file : `${file}.${n}`);
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    size = 0;
  }

  const startedAt = Date.now();
  const totals = { jobs: 0, ok: 0, errors: 0 };

  function rotate() {
    try {
      fs.rmSync(fileAt(KEEP_FILES - 1), { force: true });
      for (let n = KEEP_FILES - 2; n >= 0; n--) if (fs.existsSync(fileAt(n))) fs.renameSync(fileAt(n), fileAt(n + 1));
      size = 0;
    } catch {
      // another PC on a shared drive has it open; try again next time
    }
  }

  /** Appends one event. Logging must never break the app, so every failure is swallowed. */
  function log(event, data = {}) {
    if (!enabled) return;
    try {
      const line = JSON.stringify({ ts: new Date().toISOString(), event, pc: pcId, user: userId, session: sessionId, ...data }) + '\n';
      if (size + line.length > MAX_FILE_BYTES) rotate();
      fs.appendFileSync(file, line);
      size += line.length;
    } catch {
      // disk full, share offline, file locked: drop the line
    }
  }

  // ---- Resource sampling while jobs run ----
  const active = new Map(); // job id -> { tool, t0, inBytes, ... samples }
  let timer = null;
  let lastCpu = cpuTimes();

  function cpuTimes() {
    const c = os.cpus();
    return c.reduce((a, x) => ({ idle: a.idle + x.times.idle, total: a.total + x.times.user + x.times.nice + x.times.sys + x.times.idle + x.times.irq }), { idle: 0, total: 0 });
  }

  function sample() {
    const nowCpu = cpuTimes();
    const dTotal = nowCpu.total - lastCpu.total;
    const sysCpu = dTotal > 0 ? Math.round((1 - (nowCpu.idle - lastCpu.idle) / dTotal) * 100) : 0;
    lastCpu = nowCpu;
    let ramMB = 0;
    let appCpu = 0;
    try {
      for (const m of app.getAppMetrics()) {
        ramMB += (m.memory?.workingSetSize ?? 0) / 1024;
        appCpu += m.cpu?.percentCPUUsage ?? 0;
      }
    } catch {
      // metrics unavailable
    }
    appCpu = Math.min(100, Math.round(appCpu / os.cpus().length)); // of all cores
    const freeMB = Math.round(os.freemem() / MB);
    for (const j of active.values()) {
      j.n++;
      j.ramMax = Math.max(j.ramMax, ramMB);
      j.appCpuMax = Math.max(j.appCpuMax, appCpu);
      j.appCpuSum += appCpu;
      j.sysCpuMax = Math.max(j.sysCpuMax, sysCpu);
      j.sysCpuSum += sysCpu;
      j.freeMin = Math.min(j.freeMin, freeMB);
    }
  }

  function jobStart(id, info = {}) {
    if (!enabled || !id) return;
    active.set(id, { tool: String(info.tool || '').slice(0, 40), t0: Date.now(), inBytes: Number(info.inputBytes) || 0, inFiles: Number(info.inputFiles) || 0, ramMax: 0, appCpuMax: 0, appCpuSum: 0, sysCpuMax: 0, sysCpuSum: 0, freeMin: Infinity, n: 0, ramStart: appRamMB(), temp0: tempCount() });
    if (!timer) {
      lastCpu = cpuTimes();
      timer = setInterval(sample, SAMPLE_MS);
      timer.unref?.();
    }
    sample();
  }

  function appRamMB() {
    try {
      return Math.round(app.getAppMetrics().reduce((n, m) => n + (m.memory?.workingSetSize ?? 0), 0) / 1024);
    } catch {
      return 0;
    }
  }

  function jobEnd(id, result = {}) {
    const j = active.get(id);
    if (!j) return;
    sample();
    active.delete(id);
    if (!active.size && timer) {
      clearInterval(timer);
      timer = null;
    }
    const ok = result.outcome === 'ok';
    totals.jobs++;
    if (ok) totals.ok++;
    else totals.errors++;
    const err = ok ? {} : describeError(result.error);
    log('job', {
      tool: j.tool,
      outcome: ['ok', 'error', 'stopped', 'cancelled'].includes(result.outcome) ? result.outcome : 'error',
      ms: Date.now() - j.t0,
      inBytes: j.inBytes,
      inFiles: j.inFiles,
      outBytes: Number(result.outputBytes) || 0,
      ramStartMB: j.ramStart,
      ramPeakMB: Math.round(j.ramMax),
      appCpuAvg: j.n ? Math.round(j.appCpuSum / j.n) : 0,
      appCpuPeak: j.appCpuMax,
      sysCpuAvg: j.n ? Math.round(j.sysCpuSum / j.n) : 0,
      sysCpuPeak: j.sysCpuMax,
      freeRamMinMB: j.freeMin === Infinity ? null : j.freeMin,
      tempFilesAtEnd: tempCount(),
      ...err,
    });
  }

  // ---- Temp files (the work folder the main process owns) ----
  let tempDir = null;
  let tempCreated = 0;
  let tempDeleted = 0;
  let tempBytes = 0;
  const tempCount = () => {
    try {
      return tempDir ? fs.readdirSync(tempDir).length : 0;
    } catch {
      return 0;
    }
  };
  const tempState = () => {
    let files = 0;
    let bytes = 0;
    try {
      for (const f of fs.readdirSync(tempDir)) {
        files++;
        bytes += fs.statSync(path.join(tempDir, f)).size;
      }
    } catch {
      // folder doesn't exist: nothing left
    }
    return { files, bytes };
  };

  const dirSize = (d) => {
    let n = 0;
    try {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) n += e.isDirectory() ? dirSize(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size;
    } catch {
      // unreadable
    }
    return n;
  };
  const logBytes = () => {
    let n = 0;
    for (let i = 0; i < KEEP_FILES; i++) {
      try {
        n += fs.statSync(fileAt(i)).size;
      } catch {
        // absent
      }
    }
    return n;
  };

  return {
    enabled: () => enabled,
    file,
    dir,
    ids: { pc: pcId, user: userId, session: sessionId },
    log,
    jobStart,
    jobEnd,
    setEnabled(on) {
      enabled = !!on;
      try {
        fs.mkdirSync(userData, { recursive: true });
        fs.writeFileSync(settingsFile, JSON.stringify({ ...readJson(settingsFile), logging: enabled, salt }));
      } catch {
        // kept for this session only
      }
      return enabled;
    },
    /** App start: what ran before left on the disk, and what this PC is. */
    start({ version, budgetMB, workDir, leftover }) {
      tempDir = workDir;
      log('app_start', {
        version,
        os: `${os.type()} ${os.release()}`,
        ramGB: +(os.totalmem() / 1024 ** 3).toFixed(1),
        cores: os.cpus().length,
        budgetMB,
        userDataMB: Math.round(dirSize(userData) / MB),
        logBytes: logBytes(),
        tempLeftoverFiles: leftover?.files ?? 0,
        tempLeftoverBytes: leftover?.bytes ?? 0,
      });
    },
    tool(tool) {
      log('tool_open', { tool: String(tool || '').slice(0, 40) });
    },
    tempCreated() {
      tempCreated++;
    },
    tempClosed(bytes) {
      tempBytes += bytes || 0;
    },
    tempDeleted() {
      tempDeleted++;
    },
    saved({ bytes, ext }) {
      log('file_saved', { bytes: Number(bytes) || 0, ext: String(ext || '').slice(0, 8).toLowerCase() });
    },
    /** App quit: the temp folder before it is cleaned (it should hold nothing but unsaved results). */
    quit({ before, after }) {
      log('app_quit', {
        seconds: Math.round((Date.now() - startedAt) / 1000),
        jobs: totals.jobs,
        ok: totals.ok,
        errors: totals.errors,
        tempCreated,
        tempDeleted,
        tempBytesWritten: tempBytes,
        tempFilesBeforeCleanup: before?.files ?? 0,
        tempFilesAfterCleanup: after?.files ?? 0,
        userDataMB: Math.round(dirSize(userData) / MB),
        logBytes: logBytes(),
      });
    },
    tempState,
    describeError,
  };
}

module.exports = { create, describeError };
