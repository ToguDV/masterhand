// CommonJS on purpose: a sandboxed preload cannot be an ESM module.
//
// The window only ever loads our own bundled web build (or the Vite dev
// server), so this bridge carries a single platform flag and exposes no IPC.
// The web app uses it to skip the same-origin probe on first run, keep plain
// http LAN servers available, suppress the stale-bundle notice (the shell
// updates the UI through electron-updater) and label its device registration
// "Desktop app".
const { contextBridge } = require("electron")

contextBridge.exposeInMainWorld("masterhandDesktop", true)
