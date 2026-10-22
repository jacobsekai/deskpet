// The only bridge between the sandboxed renderer and the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deskpet', {
  onPose: (fn) => ipcRenderer.on('pose', (_e, pose) => fn(pose)),
  onPack: (fn) => ipcRenderer.on('pack', (_e, source) => fn(source)),
  onSnapshot: (fn) => ipcRenderer.on('snapshot', (_e, request) => fn(request)),
  send: (channel, payload) => {
    const allowed = ['press', 'release', 'resize-start', 'resize-finish', 'menu', 'geometry', 'pack-loaded', 'theme-result', 'snapshot-done'];
    if (allowed.includes(channel)) ipcRenderer.send(channel, payload);
  },
});
