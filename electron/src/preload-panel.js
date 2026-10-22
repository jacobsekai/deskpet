// Bridge for the control center window (the macOS app provides the same `call` via WKWebView).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deskpetPanel', {
  call: (action, payload) => ipcRenderer.invoke('panel', action, payload),
});
