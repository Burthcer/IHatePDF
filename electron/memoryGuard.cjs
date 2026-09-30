/**
 * Memory fail-safe. IHatePDF gets a RAM budget sized to this PC and a
 * watchdog keeps jobs inside it, so no file — however big, and whoever
 * picked it — can make the computer run out of memory.
 *
 * Budget: half of the installed RAM, but always leaving at least 3 GB for
 * Windows and other programs, never less than 1 GB, never more than 16 GB.
 *   4 GB PC → 1 GB   ·   8 GB → 4 GB   ·   16 GB → 8 GB   ·   32 GB+ → 16 GB
 *
 * The budget is for the work a job does, not for the app itself: what the
 * app uses while idle (0.5–0.9 GB, depending on Windows) doesn't count. And it
 * shrinks while Windows itself is short of memory: a job may then only use
 * what keeps a reserve (10% of RAM, at least 1 GB) free for Windows, so the
 * steps below start earlier on a busy PC. The
 * watchdog (twice a second) adds up the physical memory (working set) of
 * every IHatePDF process and measures how much it has grown since the job
 * started (or, with no job running, since the last minute's low point):
 *   normal    under 70% of the budget
 *   high      70% or more, or Windows is getting low: tools work in smaller
 *             pieces, and the app says "Low on memory: taking longer"
 *   over      over the budget: jobs pause at their next piece, drop what
 *             they can, and carry on when memory comes down
 *   critical  the last resort — the job is stopped, with a message saying
 *             why, and the app stays usable:
 *             · Windows itself is nearly out of memory (under 5% / 400 MB
 *               free) while the job holds a real share of it, or
 *             · pausing didn't help (still over the budget after 8 s): one
 *               piece of the job needs more than the budget, or
 *             · a runaway: twice the budget.
 * The page answers each report. A page that stops answering (stuck) while
 * over the budget is ended and reloaded after 1 s; one that answers but
 * can't free its memory, after a few seconds.
 */

const fs = require('fs');
const os = require('os');

const MB = 1024 * 1024;
const GB = 1024 * MB;

function budgetFor(total) {
  return Math.round(Math.max(1 * GB, Math.min(total * 0.5, total - 3 * GB, 16 * GB)));
}

const TOTAL = os.totalmem();
const BUDGET = Number(process.env.IHP_MEMORY_BUDGET_MB) > 0 ? Number(process.env.IHP_MEMORY_BUDGET_MB) * MB : budgetFor(TOTAL);
const CHECK_MS = 500;
const HIGH = 0.7;
/**
 * Memory always left to Windows and other programs: 10% of RAM, at least 1 GB.
 * When Windows itself is busy, a job's limit shrinks so this stays free.
 */
const RESERVE = Math.max(1 * GB, TOTAL * 0.1);
/** A job's limit never shrinks below this (small jobs always get room to run). */
const MIN_LIMIT = Math.min(BUDGET, 256 * MB);
/** Over the budget for this long while paused: the job can't be made to fit. */
const OVER_LIMIT_MS = 8000;
const RUNAWAY = 2;
/** Windows being low only counts against a job that holds at least this much. */
const LOW_SHARE = 128 * MB;
/** With no job running, growth is measured from the lowest use in this window. */
const IDLE_WINDOW_MS = 60_000;
/** After the page (re)loads, give it this long to settle before measuring. */
const WARMUP_MS = 5000;
/** Checks before the page is reloaded: stuck (not answering) or answering but unable to free memory. */
const LIMITS = { stuck: 2, answering: 6 };
const ANSWER_MS = 1500;

/** Physical memory currently used by all of the app's processes, in bytes. */
function appMemory(app) {
  // workingSetSize is in KB: RAM actually in use (untouched reservations don't count).
  return app.getAppMetrics().reduce((n, m) => n + (m.memory?.workingSetSize ?? 0) * 1024, 0);
}

/**
 * Memory Windows has available. For tests only, IHP_SIMULATE_FREE_FILE names a
 * file holding a number of MB to report instead (to stage "Windows is nearly
 * out of memory" without starving the test machine).
 */
function freeMemory() {
  const file = process.env.IHP_SIMULATE_FREE_FILE;
  if (file) {
    try {
      const mb = Number(fs.readFileSync(file, 'utf8'));
      if (mb > 0) return mb * MB;
    } catch {
      /* no override right now */
    }
  }
  return os.freemem();
}

function systemLow(free = freeMemory()) {
  return free < Math.max(400 * MB, TOTAL * 0.05);
}

/**
 * How much a job may use right now (pure, for tests): its budget, or less when
 * Windows is short — what it already holds plus Windows' free memory, minus the
 * reserve — but never below MIN_LIMIT.
 */
function limitFor({ growth, free, budget = BUDGET }) {
  return Math.min(budget, Math.max(Math.min(budget, MIN_LIMIT), growth + free - RESERVE));
}

/**
 * The level for `growth` bytes of job memory (pure, for tests). `limit` is the
 * job's current limit (the budget, or less while Windows is short, see
 * limitFor); `overFor` how long growth has been over it; `low` whether Windows
 * is nearly out.
 */
function levelFor({ growth, budget = BUDGET, limit = budget, low = false, overFor = 0 }) {
  const reason = limit < budget ? 'system' : 'too-big';
  if (low && growth > LOW_SHARE) return { level: 'critical', reason: 'system' };
  if (growth > budget * RUNAWAY) return { level: 'critical', reason: 'too-big' };
  if (growth > limit) return overFor >= OVER_LIMIT_MS ? { level: 'critical', reason } : { level: 'over' };
  if (growth > limit * HIGH || low) return { level: 'high' };
  return { level: 'normal' };
}

function info(extra = {}) {
  return {
    level: 'normal',
    usedMB: 0,
    jobMB: 0,
    budgetMB: Math.round(BUDGET / MB),
    limitMB: Math.round(BUDGET / MB),
    totalMB: Math.round(TOTAL / MB),
    availableMB: Math.round(freeMemory() / MB),
    ...extra,
  };
}

/**
 * Starts watching. `getContents()` returns the window's webContents (or null);
 * `onEscalate(state)` runs when the page has to be ended.
 */
function startWatchdog(app, getContents, onEscalate) {
  let level = 'normal';
  let jobs = 0;
  let jobBase = null;
  let loadedAt = Date.now();
  /** App memory when the page loaded: the reference until idle samples exist. */
  let loadBase = null;
  /** [time, bytes] samples taken while no job ran. */
  let idle = [];
  let overSince = 0;
  let criticalFor = 0;
  let answeredAt = 0;
  let sentLimit = BUDGET;
  let last = info();

  const tick = () => {
    const contents = getContents();
    if (!contents || contents.isDestroyed()) return;
    const now = Date.now();
    const used = appMemory(app);
    const free = freeMemory();
    const low = systemLow(free);
    loadBase ??= used;
    let base = jobBase;
    if (jobs === 0) {
      if (now - loadedAt >= WARMUP_MS) idle.push([now, used]);
      idle = idle.filter(([t]) => now - t <= IDLE_WINDOW_MS);
      // Measure from the lowest point of the last minute; within a minute of a (re)load that
      // includes the level at load time, so a runaway that starts right away can't raise
      // its own reference point.
      const lows = idle.map(([, b]) => b);
      if (now - loadedAt < IDLE_WINDOW_MS) lows.push(loadBase);
      base = Math.min(...lows);
    }
    if (base === null) {
      // Still starting up: nothing to measure against yet.
      last = info({ usedMB: Math.round(used / MB), availableMB: Math.round(free / MB) });
      return;
    }
    const growth = Math.max(0, used - base);
    const limit = limitFor({ growth, free });
    if (growth > limit) overSince ||= now;
    else overSince = 0;
    // With no job there's nothing to stop: previews pause while over, and only a
    // runaway, Windows running low or a page that stops answering count.
    const next = levelFor({ growth, limit, low, overFor: overSince && jobs > 0 ? now - overSince : 0 });
    last = info({
      ...next,
      usedMB: Math.round(used / MB),
      jobMB: Math.round(growth / MB),
      limitMB: Math.round(limit / MB),
      availableMB: Math.round(free / MB),
    });
    // Tell the page on every change (of level, or of the limit by a tenth), and
    // keep reminding it while over or critical.
    const limitMoved = Math.abs(limit - sentLimit) > BUDGET * 0.1;
    if (next.level !== level || limitMoved || next.level === 'over' || next.level === 'critical') {
      contents.send('ihp:mem', last);
      sentLimit = limit;
    }
    level = next.level;

    // Last resort: a page that doesn't free memory (stuck, or unable to) is ended.
    const pressing = next.level === 'critical' || (next.level === 'over' && now - answeredAt >= ANSWER_MS);
    criticalFor = pressing ? criticalFor + 1 : 0;
    const checks = now - answeredAt < ANSWER_MS ? LIMITS.answering : LIMITS.stuck;
    if (criticalFor >= checks) {
      criticalFor = 0;
      overSince = 0;
      onEscalate(last);
    }
  };
  const timer = setInterval(tick, CHECK_MS);
  timer.unref();

  return {
    state: () => last,
    /** The page answered a report (it's responsive, and has acted on it). */
    ack: () => (answeredAt = Date.now()),
    /** How many jobs the page is running; growth is measured from when the first started. */
    setJobs: (n) => {
      if (n > 0 && jobs === 0) jobBase = appMemory(app);
      if (n === 0) {
        jobBase = null;
        overSince = 0;
      }
      jobs = n;
    },
    /** The page (re)loaded: start measuring afresh. */
    pageLoaded: () => {
      loadedAt = Date.now();
      // Measured now, as the page finishes loading: before anything on it can have grown.
      loadBase = appMemory(app);
      idle = [];
      jobs = 0;
      jobBase = null;
      overSince = 0;
      criticalFor = 0;
      level = 'normal';
    },
    stop: () => clearInterval(timer),
  };
}

module.exports = { budgetFor, limitFor, levelFor, startWatchdog, info, BUDGET, TOTAL, RESERVE, OVER_LIMIT_MS };
