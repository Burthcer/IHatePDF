const { app, BrowserWindow, shell } = require('electron');
const path = require('path');

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 900,
    minHeight: 600,
    title: 'IHatePDF',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // Web Workers, Blob URLs, and ArrayBuffer transfers are standard
      // Chromium features available by default under these settings —
      // no extra preload/IPC bridge is needed since IHatePDF never talks
      // to the Node/main process; everything stays in the renderer.
    },
  });

  mainWindow.setMenuBarVisibility(false);

  const LEVELS = ['log', 'warn', 'error', 'debug'];
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    console.log(`[renderer:${LEVELS[level] || level}] ${message} (${sourceId}:${line})`);
  });

  // Keep the app 100% offline: any attempt to navigate to or open an
  // external URL (e.g. the GitHub link in the header) goes to the user's
  // default browser instead of loading inside this window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
