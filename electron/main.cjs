/**
 * IHatePDF desktop shell.
 *
 * - Serves the built app from dist/ over a privileged app:// scheme, so
 *   fetch(), module workers and WASM behave exactly as on a web server.
 * - Shows the window only once the first frame is painted (no white flash)
 *   and caches compiled JS so later launches start faster.
 * - Closing the window quits the app — nothing stays running in the
 *   background — even if the page is busy or tries to block unloading.
 * - Downloads are saved straight to Downloads/IHatePDF (no dialog), with
 *   a numbered name when one already exists; the page is told where.
 * - "Share to phone": a QR download page over Wi-Fi or this PC's own hotspot
 *   (share.cjs, hotspot.cjs), or Bluetooth (bluetooth.cjs).
 * - Memory fail-safe (memoryGuard.cjs): a RAM budget sized to this PC; jobs
 *   near it work in smaller pieces and pause, and are stopped cleanly only
 *   as a last resort, instead of freezing Windows.
 * - If the page's process dies, the window reloads and says what happened.
 */

const { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, net, protocol, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const share = require('./share.cjs');
const { createZip } = require('./zip.cjs');
const memoryGuard = require('./memoryGuard.cjs');

// Hotspot and Bluetooth call Windows through a native FFI; load them only when used.
const natives = {};
const native = (name) => (natives[name] ??= require(`./${name}.cjs`));

const DIST = path.join(__dirname, '..', 'dist');
const HOST = 'app://ihatepdf';

// Memory fail-safe: lets the page and workers collect garbage on demand when a
// job nears its budget (big results pass through the page in chunks that would
// otherwise linger until the engine gets round to them).
app.commandLine.appendSwitch('js-flags', '--expose-gc');
const DEBUG = !!process.env.IHP_DEBUG;

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } },
]);

// One running copy: launching again focuses the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.wasm': 'application/wasm',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pfb': 'application/octet-stream',
  '.bcmap': 'application/octet-stream',
  '.icc': 'application/vnd.iccprofile',
};

function serveApp() {
  protocol.handle('app', async (request) => {
    const { pathname } = new URL(request.url);
    const rel = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.normalize(path.join(DIST, rel));
    if (!file.startsWith(DIST)) return new Response('Forbidden', { status: 403 });
    try {
      const res = await net.fetch(pathToFileURL(file).toString());
      const type = MIME[path.extname(file).toLowerCase()];
      if (!type) return res;
      return new Response(res.body, { status: res.status, headers: { 'content-type': type } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

function saveDir() {
  // Some Linux setups report the home folder when there's no XDG Downloads dir.
  const downloads = app.getPath('downloads');
  const base = downloads === app.getPath('home') ? path.join(downloads, 'Downloads') : downloads;
  const dir = path.join(base, 'IHatePDF');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function uniquePath(dir, name) {
  const safe = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim() || 'document';
  const ext = path.extname(safe);
  const base = safe.slice(0, safe.length - ext.length);
  let candidate = path.join(dir, safe);
  for (let n = 2; fs.existsSync(candidate); n++) candidate = path.join(dir, `${base} (${n})${ext}`);
  return candidate;
}

let mainWindow = null;

function createWindow() {
  const dark = nativeTheme.shouldUseDarkColors;
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 900,
    minHeight: 600,
    title: 'IHatePDF',
    show: false,
    backgroundColor: dark ? '#121210' : '#f6f5f1',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      // Cache compiled code on first run instead of after several runs.
      v8CacheOptions: 'bypassHeatCheck',
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  // Never leave the user staring at nothing if the first paint is slow.
  const fallback = setTimeout(() => mainWindow && !mainWindow.isDestroyed() && mainWindow.show(), 4000);
  mainWindow.once('show', () => clearTimeout(fallback));

  if (DEBUG) {
    mainWindow.webContents.on('console-message', (event) => console.log(`[renderer:${event.level}] ${event.message}`));
  }

  // The X button always closes: ignore any page attempt to block unloading.
  mainWindow.webContents.on('will-prevent-unload', (event) => event.preventDefault());
  mainWindow.on('closed', () => {
    mainWindow = null;
    app.quit();
  });

  // Everything stays offline: external links open in the user's browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(HOST)) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  mainWindow.webContents.session.on('will-download', (event, item) => {
    const target = uniquePath(saveDir(), item.getFilename());
    item.setSavePath(target);
    item.once('done', (e, state) => {
      if (state === 'completed' && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('ihp:saved', { name: path.basename(target), path: target });
      }
    });
  });

  // The page's process can die (a crash, or ended by the memory fail-safe):
  // reload it with a note saying what happened instead of leaving a blank window.
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    if (details.reason === 'clean-exit' || !mainWindow || mainWindow.isDestroyed()) return;
    const now = Date.now();
    recentCrashes = recentCrashes.filter((t) => now - t < 60_000).concat(now);
    if (recentCrashes.length > 3) {
      dialog.showErrorBox('IHatePDF stopped', 'IHatePDF closed unexpectedly several times in a row. Please restart it.');
      app.quit();
      return;
    }
    const why = endedForMemory || details.reason === 'oom' ? 'memory' : 'crash';
    endedForMemory = false;
    mainWindow.loadURL(`${HOST}/index.html?recovered=${why}`);
  });

  // A fresh page has no jobs; the fail-safe measures from there.
  mainWindow.webContents.on('did-finish-load', () => watchdog?.pageLoaded());

  mainWindow.loadURL(`${HOST}/index.html`);
}

let recentCrashes = [];
let endedForMemory = false;
let watchdog = null;

ipcMain.handle('ihp:mem-info', () => (watchdog ? watchdog.state() : memoryGuard.info()));
ipcMain.on('ihp:mem-ack', () => watchdog?.ack());
ipcMain.on('ihp:mem-jobs', (event, n) => watchdog?.setJobs(Math.max(0, Number(n) || 0)));

ipcMain.on('ihp:show-in-folder', (event, file) => {
  if (typeof file === 'string' && path.normalize(file).startsWith(saveDir())) shell.showItemInFolder(file);
});

// ---- Tool output files ----
// Big results are streamed from the page into temp files here (never held in
// memory whole); "Save" copies the temp file into Downloads/IHatePDF.

const WORK_DIR = path.join(os.tmpdir(), 'IHatePDF-work');
const outputs = new Map(); // handle -> { fd, path, size }
const inWorkDir = (p) => typeof p === 'string' && path.normalize(p).startsWith(WORK_DIR + path.sep);

function cleanWorkDir() {
  try {
    fs.rmSync(WORK_DIR, { recursive: true, force: true });
  } catch {
    // files still open elsewhere; they'll be removed next time
  }
}

ipcMain.handle('ihp:out-create', () => {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  const handle = require('crypto').randomUUID();
  const file = path.join(WORK_DIR, `${handle}.tmp`);
  outputs.set(handle, { fd: fs.openSync(file, 'w'), path: file, size: 0 });
  return handle;
});
ipcMain.handle('ihp:out-write', (event, handle, chunk) => {
  const o = outputs.get(handle);
  if (!o) throw new Error('Unknown output.');
  const buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  let written = 0;
  while (written < buf.length) written += fs.writeSync(o.fd, buf, written, buf.length - written);
  o.size += buf.length;
});
ipcMain.handle('ihp:out-close', (event, handle, discard) => {
  const o = outputs.get(handle);
  if (!o) throw new Error('Unknown output.');
  outputs.delete(handle);
  fs.closeSync(o.fd);
  if (discard) fs.rmSync(o.path, { force: true });
  return { path: o.path, size: o.size };
});
ipcMain.handle('ihp:out-save', (event, file, name) => {
  if (!inWorkDir(file)) throw new Error('Not an output file.');
  const target = uniquePath(saveDir(), String(name));
  fs.copyFileSync(file, target);
  if (!event.sender.isDestroyed()) event.sender.send('ihp:saved', { name: path.basename(target), path: target });
  return target;
});
ipcMain.handle('ihp:out-discard', (event, file) => {
  if (inWorkDir(file)) fs.rmSync(file, { force: true });
});
ipcMain.handle('ihp:out-read', (event, file) => {
  if (!inWorkDir(file)) throw new Error('Not an output file.');
  return new Uint8Array(fs.readFileSync(file));
});

// ---- Share to phone ----

ipcMain.handle('ihp:share-pick', async (event, kind) => {
  const res = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
    title: kind === 'folder' ? 'Choose folders to share' : 'Choose files to share',
    properties: [kind === 'folder' ? 'openDirectory' : 'openFile', 'multiSelections'],
  });
  return res.canceled ? [] : res.filePaths;
});
ipcMain.handle('ihp:share-describe', (event, paths) => share.describe(paths));

async function stopHotspot() {
  if (natives.hotspot) await natives.hotspot.stop();
}

ipcMain.handle('ihp:share-start', async (event, { paths, minutes, mode }) => {
  const onEnd = (reason) => {
    if (reason === 'replaced') return;
    void stopHotspot();
    if (!event.sender.isDestroyed()) event.sender.send('ihp:share-ended', reason);
  };
  let wifi = null;
  let preferred;
  if (mode === 'hotspot') {
    const hs = await native('hotspot').start();
    wifi = { ssid: hs.ssid, password: hs.password };
    preferred = hs.address;
  } else await stopHotspot();
  try {
    return { ...(await share.start(paths, minutes, onEnd, preferred)), wifi };
  } catch (e) {
    await stopHotspot();
    throw e;
  }
});
ipcMain.handle('ihp:share-minutes', (event, minutes) => share.setMinutes(minutes));
ipcMain.handle('ihp:share-stop', () => share.stop());

ipcMain.handle('ihp:bt-scan', () => native('bluetooth').scan());
ipcMain.handle('ihp:bt-send', async (event, { deviceId, paths }) => {
  const emit = (ev) => !event.sender.isDestroyed() && event.sender.send('ihp:bt-event', ev);
  const items = share.describe(paths);
  if (items.reduce((n, i) => n + i.size, 0) >= 2 ** 32) throw new Error('Bluetooth can’t send more than 4 GB at once. Use Same Wi-Fi or PC hotspot instead.');
  // One plain file goes as it is; several files or a folder go as one .zip (one "Accept" on the phone).
  if (items.length === 1 && !items[0].isDir) return native('bluetooth').sendFile(deviceId, items[0].path, items[0].name, emit);
  const name = items.length === 1 ? `${items[0].name}.zip` : 'IHatePDF files.zip';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ihatepdf-'));
  try {
    emit({ type: 'zipping' });
    const file = path.join(dir, name);
    const out = fs.createWriteStream(file);
    await createZip(paths).pipe(out);
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    await native('bluetooth').sendFile(deviceId, file, name, emit);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
ipcMain.handle('ihp:bt-cancel', () => natives.bluetooth?.cancel());
ipcMain.on('ihp:bt-settings', () => shell.openExternal('ms-settings:bluetooth'));

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.whenReady().then(() => {
  cleanWorkDir();
  Menu.setApplicationMenu(null);
  serveApp();
  createWindow();
  // Last resort of the memory fail-safe: the page didn't free memory itself.
  watchdog = memoryGuard.startWatchdog(app, () => mainWindow?.webContents ?? null, () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    endedForMemory = true;
    mainWindow.webContents.forcefullyCrashRenderer();
  });
});

// Quit on every platform when the window closes.
app.on('window-all-closed', () => app.quit());

// Last resort: if something keeps the process alive after quitting, end it.
app.on('will-quit', () => {
  for (const o of outputs.values()) {
    try {
      fs.closeSync(o.fd);
    } catch {
      // already closed
    }
  }
  cleanWorkDir();
  share.stop();
  natives.bluetooth?.cancel();
  void stopHotspot();
  setTimeout(() => process.exit(0), 2000).unref();
});
