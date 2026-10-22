// Bridge for the setup wizard window (the macOS app provides the same `call` via WKWebView).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deskpetWizard', {
  call: (action, payload) => ipcRenderer.invoke('wizard', action, payload),
});
