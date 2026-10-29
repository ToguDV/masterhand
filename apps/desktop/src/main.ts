import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type MenuItemConstructorOptions } from "electron"
import electronUpdater from "electron-updater"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { normalizeDesktopServerUrl } from "./server-url.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const CONFIG_FILE = "config.json"
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const FIRST_UPDATE_CHECK_DELAY_MS = 10_000

// electron-updater is CommonJS; Node's ESM named-export detection does not
// see `autoUpdater` through its re-export chain.
const { autoUpdater } = electronUpdater

app.setName("MasterHand")

let mainWindow: BrowserWindow | null = null
let connectWindow: BrowserWindow | null = null
let quitting = false
/** True while `connectToServer` swaps the connect window for a main window. */
let switchingServer = false

interface StoredConfig {
  serverUrl?: unknown
}

function configPath(): string {
  return join(app.getPath("userData"), CONFIG_FILE)
}

async function readStoredServerUrl(): Promise<string | null> {
  try {
    const raw = await readFile(configPath(), "utf8")
    const parsed = JSON.parse(raw) as StoredConfig
    const normalized = normalizeDesktopServerUrl(parsed.serverUrl)
    return normalized.ok ? normalized.url : null
  } catch {
    return null
  }
}

async function writeStoredServerUrl(url: string): Promise<void> {
  const target = configPath()
  await mkdir(dirname(target), { recursive: true })
  const temporary = `${target}.tmp`
  await writeFile(temporary, `${JSON.stringify({ serverUrl: url }, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, target)
}

/** Explicit env override for development; the persisted choice wins otherwise. */
function envServerUrl(): string | null {
  const raw = process.env.MASTERHAND_URL
  if (!raw) return null
  const normalized = normalizeDesktopServerUrl(raw)
  if (!normalized.ok) {
    console.warn(`[masterhand] ignoring MASTERHAND_URL: ${normalized.error}`)
    return null
  }
  return normalized.url
}

function openExternal(url: string): void {
  if (/^https?:/i.test(url)) void shell.openExternal(url)
}

function installNavigationGuards(window: BrowserWindow, origin: string): void {
  window.webContents.on("will-navigate", (event, url) => {
    try {
      if (new URL(url).origin === origin) return
    } catch {
      // Malformed URLs are denied below.
    }
    event.preventDefault()
    openExternal(url)
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: "deny" }
  })
}

function createMainWindow(serverUrl: string): BrowserWindow {
  const origin = new URL(serverUrl).origin
  const window = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 380,
    title: "MasterHand",
    backgroundColor: "#09090b",
    show: false,
    webPreferences: {
      // No preload here: the remote web app must never get an IPC surface.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  })

  mainWindow = window
  installNavigationGuards(window, origin)

  window.once("ready-to-show", () => window.show())
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null
  })

  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    // -3 is ERR_ABORTED (a superseded navigation), not a connectivity error.
    if (!isMainFrame || errorCode === -3) return
    void dialog
      .showMessageBox(window, {
        type: "error",
        title: "MasterHand",
        message: "Could not reach the MasterHand server.",
        detail: `${validatedURL || serverUrl}\n${errorDescription} (${errorCode})`,
        buttons: ["Change server…", "Retry", "Quit"],
        defaultId: 1,
        cancelId: 2,
      })
      .then(({ response }) => {
        if (response === 0) {
          window.close()
          void showConnectWindow(serverUrl)
        } else if (response === 1) {
          void window.loadURL(serverUrl)
        } else {
          app.quit()
        }
      })
  })

  void window.loadURL(serverUrl)
  return window
}

async function showConnectWindow(prefill?: string): Promise<void> {
  if (connectWindow) {
    connectWindow.focus()
    return
  }

  const window = new BrowserWindow({
    width: 520,
    height: 560,
    minWidth: 420,
    minHeight: 480,
    title: "Connect to MasterHand",
    backgroundColor: "#fafaf7",
    show: false,
    parent: mainWindow ?? undefined,
    modal: mainWindow !== null,
    webPreferences: {
      preload: join(__dirname, "..", "static", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  })

  connectWindow = window
  window.once("ready-to-show", () => window.show())
  window.on("closed", () => {
    if (connectWindow === window) connectWindow = null
    if (!mainWindow && !switchingServer && !quitting && process.platform !== "darwin") app.quit()
  })

  const initial =
    prefill ??
    (await readStoredServerUrl()) ??
    envServerUrl() ??
    (app.isPackaged ? "" : "http://localhost:8787")
  await window.loadFile(join(__dirname, "..", "static", "connect.html"), {
    query: initial ? { url: initial } : {},
  })
}

async function connectToServer(rawUrl: string): Promise<{ ok: boolean; error?: string }> {
  const normalized = normalizeDesktopServerUrl(rawUrl)
  if (!normalized.ok) return { ok: false, error: normalized.error }

  try {
    await writeStoredServerUrl(normalized.url)
  } catch (error) {
    console.error("[masterhand] could not persist the server URL:", error)
    return { ok: false, error: "Could not save the server URL. Check the app data directory." }
  }

  switchingServer = true
  try {
    const previousMain = mainWindow
    mainWindow = null
    previousMain?.close()
    connectWindow?.close()
    connectWindow = null
    createMainWindow(normalized.url)
  } finally {
    switchingServer = false
  }
  return { ok: true }
}

function showAbout(): void {
  void dialog.showMessageBox({
    type: "info",
    title: "About MasterHand",
    message: `MasterHand ${app.getVersion()}`,
    detail: `Electron ${process.versions.electron}\nChromium ${process.versions.chrome}\nNode ${process.versions.node}`,
    buttons: ["OK"],
  })
}

async function checkForUpdatesInteractive(): Promise<void> {
  if (!app.isPackaged) {
    await dialog.showMessageBox({
      type: "info",
      title: "Check for updates",
      message: "Updates are only available in packaged builds.",
      buttons: ["OK"],
    })
    return
  }

  try {
    const result = await autoUpdater.checkForUpdates()
    if (!result) {
      await dialog.showMessageBox({
        type: "info",
        title: "Check for updates",
        message: "No update information is available.",
        buttons: ["OK"],
      })
      return
    }
    if (autoUpdater.currentVersion.compare(result.updateInfo.version) >= 0) {
      await dialog.showMessageBox({
        type: "info",
        title: "Check for updates",
        message: `MasterHand ${app.getVersion()} is up to date.`,
        buttons: ["OK"],
      })
    }
    // Otherwise the download starts and `update-downloaded` prompts to restart.
  } catch (error) {
    await dialog.showMessageBox({
      type: "error",
      title: "Check for updates",
      message: "Could not check for updates.",
      detail: error instanceof Error ? error.message : String(error),
      buttons: ["OK"],
    })
  }
}

function setupAutoUpdate(): void {
  if (!app.isPackaged) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on("error", (error) => {
    // Background checks stay silent: an offline laptop or an unsigned macOS
    // build must never interrupt the user with a modal.
    console.warn("[masterhand] update check failed:", error instanceof Error ? error.message : error)
  })
  autoUpdater.on("update-downloaded", (info) => {
    void dialog
      .showMessageBox({
        type: "info",
        title: "Update ready",
        message: `MasterHand ${info.version} is ready to install.`,
        detail: "Restart now to use the new version, or later — it installs when you quit.",
        buttons: ["Restart now", "Later"],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) {
          quitting = true
          autoUpdater.quitAndInstall()
        }
      })
  })

  setTimeout(() => void autoUpdater.checkForUpdates().catch(() => {}), FIRST_UPDATE_CHECK_DELAY_MS).unref()
  setInterval(
    () => void autoUpdater.checkForUpdates().catch(() => {}),
    UPDATE_CHECK_INTERVAL_MS,
  ).unref()
}

function buildMenu(): void {
  const isMac = process.platform === "darwin"
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { label: "About MasterHand", click: showAbout },
              { label: "Check for updates…", click: () => void checkForUpdatesInteractive() },
              { label: "Change server…", click: () => void showConnectWindow() },
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        ...(isMac
          ? []
          : [
              { label: "Change server…", click: () => void showConnectWindow() },
              { label: "Check for updates…", click: () => void checkForUpdatesInteractive() },
              { type: "separator" as const },
            ]),
        isMac ? { role: "close" as const } : { role: "quit" as const },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    ...(isMac
      ? []
      : [
          {
            label: "Help",
            submenu: [{ label: "About MasterHand", click: showAbout }],
          },
        ]),
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

async function boot(): Promise<void> {
  ipcMain.handle("masterhand:connect", (_event, url: unknown) => connectToServer(String(url ?? "")))

  buildMenu()
  setupAutoUpdate()

  const serverUrl = envServerUrl() ?? (await readStoredServerUrl())
  if (serverUrl) {
    createMainWindow(serverUrl)
  } else {
    await showConnectWindow()
  }
}

const smokeTest = process.argv.includes("--smoke-test")
if (smokeTest) {
  void app.whenReady().then(() => {
    console.log(`MasterHand ${app.getVersion()}`)
    app.quit()
  })
} else if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on("second-instance", () => {
    const window = mainWindow ?? connectWindow
    if (!window) return
    if (window.isMinimized()) window.restore()
    window.focus()
  })

  void app.whenReady().then(() => void boot())

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length > 0) return
    void (async () => {
      const serverUrl = envServerUrl() ?? (await readStoredServerUrl())
      if (serverUrl) createMainWindow(serverUrl)
      else await showConnectWindow()
    })()
  })

  app.on("before-quit", () => {
    quitting = true
  })

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit()
  })
}
