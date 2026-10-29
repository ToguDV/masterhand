// CommonJS on purpose: a sandboxed preload cannot be an ESM module. This
// bridge exists only for the local connect page; the main window (the remote
// web app) is created without a preload.
const { contextBridge, ipcRenderer } = require("electron")

contextBridge.exposeInMainWorld("masterhand", {
  connect: (url) => ipcRenderer.invoke("masterhand:connect", url),
})
