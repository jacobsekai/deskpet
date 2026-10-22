// Bridge for small dialog windows (blocklist editor, transfer key).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deskpetDialog', {
  call: (action, payload) => ipcRenderer.invoke('dialog', action, payload),
});
