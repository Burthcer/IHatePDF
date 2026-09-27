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
 */

const { app, BrowserWindow, Menu, ipcMain, nativeTheme, net, protocol, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const DIST = path.join(__dirname, '..', 'dist');
const HOST = 'app://ihatepdf';
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

  mainWindow.loadURL(`${HOST}/index.html`);
}

ipcMain.on('ihp:show-in-folder', (event, file) => {
  if (typeof file === 'string' && path.normalize(file).startsWith(saveDir())) shell.showItemInFolder(file);
});

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  serveApp();
  createWindow();
});

// Quit on every platform when the window closes.
app.on('window-all-closed', () => app.quit());

// Last resort: if something keeps the process alive after quitting, end it.
app.on('will-quit', () => {
  setTimeout(() => process.exit(0), 2000).unref();
});
