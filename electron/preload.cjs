// Gives the editor page a few desktop powers: downloads without browser restrictions, a native save dialog and links
// that open in the default browser. The page sees them as window.clipwaveDesktop.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clipwaveDesktop', {
  platform: process.platform,
  fetch: (url, opts = {}) => ipcRenderer.invoke('net:fetch', url, { headers: opts.headers || {}, timeoutMs: opts.timeoutMs || 0 }),
  saveFile: (name, data) => ipcRenderer.invoke('file:save', name, data),
  showInFolder: (filePath) => ipcRenderer.invoke('file:show', filePath),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
});
