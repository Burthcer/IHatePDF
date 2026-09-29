// Minimal bridge for the page: where saved files landed, "Show in folder", and
// "Share to phone" (QR over Wi-Fi / this PC's hotspot, or Bluetooth).
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const listen = (channel) => (cb) => {
  const handler = (_event, value) => cb(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('ihpDesktop', {
  onSaved: listen('ihp:saved'),
  memory: {
    info: () => ipcRenderer.invoke('ihp:mem-info'),
    onChange: listen('ihp:mem'),
  },
  showInFolder(file) {
    ipcRenderer.send('ihp:show-in-folder', file);
  },
  output: {
    create: () => ipcRenderer.invoke('ihp:out-create'),
    write: (handle, chunk) => ipcRenderer.invoke('ihp:out-write', handle, chunk),
    close: (handle, discard) => ipcRenderer.invoke('ihp:out-close', handle, !!discard),
    save: (file, name) => ipcRenderer.invoke('ihp:out-save', file, name),
    discard: (file) => ipcRenderer.invoke('ihp:out-discard', file),
    read: (file) => ipcRenderer.invoke('ihp:out-read', file),
  },
  share: {
    pick: (kind) => ipcRenderer.invoke('ihp:share-pick', kind),
    pathsOf: (files) => files.map((f) => webUtils.getPathForFile(f)).filter(Boolean),
    describe: (paths) => ipcRenderer.invoke('ihp:share-describe', paths),
    start: (paths, minutes, mode) => ipcRenderer.invoke('ihp:share-start', { paths, minutes, mode }),
    setMinutes: (minutes) => ipcRenderer.invoke('ihp:share-minutes', minutes),
    stop: () => ipcRenderer.invoke('ihp:share-stop'),
    onEnded: listen('ihp:share-ended'),
  },
  bluetooth: {
    scan: () => ipcRenderer.invoke('ihp:bt-scan'),
    send: (deviceId, paths) => ipcRenderer.invoke('ihp:bt-send', { deviceId, paths }),
    cancel: () => ipcRenderer.invoke('ihp:bt-cancel'),
    onEvent: listen('ihp:bt-event'),
    openSettings: () => ipcRenderer.send('ihp:bt-settings'),
  },
});
