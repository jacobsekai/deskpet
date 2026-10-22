// Bridge for the talk window (the macOS app provides the same `call` via WKWebView).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deskpetTalk', {
  call: (action, payload) => ipcRenderer.invoke('talk', action, payload),
});
