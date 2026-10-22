// Bridge for the hover card window.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deskpetCard', {
  onModel: (fn) => ipcRenderer.on('card', (_e, model) => fn(model)),
  size: (width, height) => ipcRenderer.send('card-size', { width, height }),
  jump: (pid) => ipcRenderer.send('card-jump', pid),
});
