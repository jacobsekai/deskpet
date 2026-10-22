// The only bridge between the sandboxed renderer and the main process.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('deskpet', {
  onPose: (fn) => ipcRenderer.on('pose', (_e, pose) => fn(pose)),
  onPack: (fn) => ipcRenderer.on('pack', (_e, source) => fn(source)),
  onSnapshot: (fn) => ipcRenderer.on('snapshot', (_e, request) => fn(request)),
  onSound: (fn) => ipcRenderer.on('sound', (_e, event) => fn(event)),
  /** Dropped files -> filesystem paths (File.path no longer exists in Electron). */
  dropFiles: (files) => ipcRenderer.send('drop-files', files.map((f) => webUtils.getPathForFile(f)).filter(Boolean)),
  send: (channel, payload) => {
    const allowed = ['press', 'release', 'resize-start', 'resize-finish', 'menu', 'geometry', 'pack-loaded', 'theme-result', 'snapshot-done', 'drag-hover'];
    if (allowed.includes(channel)) ipcRenderer.send(channel, payload);
  },
});
