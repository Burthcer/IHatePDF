// Minimal bridge for the page: where saved files landed, and "Show in folder".
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ihpDesktop', {
  onSaved(cb) {
    const handler = (_event, info) => cb(info);
    ipcRenderer.on('ihp:saved', handler);
    return () => ipcRenderer.removeListener('ihp:saved', handler);
  },
  showInFolder(file) {
    ipcRenderer.send('ihp:show-in-folder', file);
  },
});
