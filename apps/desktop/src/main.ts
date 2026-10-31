import { app, BrowserWindow, dialog, Menu, protocol, shell, type MenuItemConstructorOptions } from "electron"
import electronUpdater from "electron-updater"
import { access, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { APP_SCHEME, APP_URL, isAppUrl, resolveAppAsset } from "./protocol.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const FIRST_UPDATE_CHECK_DELAY_MS = 10_000

/**
 * Vite dev server used by `npm run dev:desktop`. Development keeps the
 * hot-reloading UI; packaged builds serve the web build bundled by
 * `build:renderer` through the `masterhand://app` protocol.
 */
const DEV_WEB_URL = "http://localhost:5173"

// electron-updater is CommonJS; Node's ESM named-export detection does not
// see `autoUpdater` through its re-export chain.
const { autoUpdater } = electronUpdater

// Must run before `app.ready`. A standard + secure scheme gets an origin
// (`masterhand://app`), so localStorage, the Clipboard API and notifications
// behave like a normal page without trusting any remote origin.
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
])

app.setName("MasterHand")

let mainWindow: BrowserWindow | null = null

function appUrl(): string {
  return app.isPackaged ? APP_URL : DEV_WEB_URL
}

function notFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  })
}

/** Serves the bundled web build from the privileged local origin. */
function serveBundledApp(): void {
  const root = join(__dirname, "renderer")
  protocol.handle(APP_SCHEME, async (request) => {
    const asset = resolveAppAsset(root, request.url)
    if (!asset) return notFound()
    try {
      const body = await readFile(asset.file)
      return new Response(body, { headers: { "content-type": asset.mime } })
    } catch (error) {
      console.error(`[masterhand] could not read the bundled asset ${asset.file}:`, error)
      return notFound()
    }
  })
}

/** A missing renderer would load a bare "Not found" page with no way back. */
async function bundledAppIsComplete(): Promise<boolean> {
  try {
    await access(join(__dirname, "renderer", "index.html"))
    return true
  } catch (error) {
    console.error("[masterhand] the bundled web build is missing:", error)
    return false
  }
}

function openExternal(url: string): void {
  if (/^https?:/i.test(url)) void shell.openExternal(url)
}

function installNavigationGuards(window: BrowserWindow, isAllowed: (url: string) => boolean): void {
  window.webContents.on("will-navigate", (event, url) => {
    if (isAllowed(url)) return
    event.preventDefault()
    openExternal(url)
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: "deny" }
  })
}

function isAllowedNavigation(url: string): boolean {
  if (app.isPackaged) return isAppUrl(url)
  try {
    return new URL(url).origin === new URL(DEV_WEB_URL).origin
  } catch {
    return false
  }
}

function createMainWindow(): BrowserWindow {
  const url = appUrl()
  const window = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 380,
    title: "MasterHand",
    backgroundColor: "#09090b",
    show: false,
    webPreferences: {
      // The window only ever loads our own bundle (or the Vite dev server),
      // so the preload carries a single platform flag and no IPC surface.
      preload: join(__dirname, "..", "static", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  })

  mainWindow = window
  installNavigationGuards(window, isAllowedNavigation)

  window.once("ready-to-show", () => window.show())
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null
  })

  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    // -3 is ERR_ABORTED (a superseded navigation), not a load failure.
    if (!isMainFrame || errorCode === -3) return
    void dialog
      .showMessageBox(window, {
        type: "error",
        title: "MasterHand",
        message: "Could not start the MasterHand interface.",
        detail: `${validatedURL || url}\n${errorDescription} (${errorCode})`,
        buttons: ["Retry", "Quit"],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) {
          void window.loadURL(url)
        } else {
          app.quit()
        }
      })
  })

  void window.loadURL(url)
  return window
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
  buildMenu()
  setupAutoUpdate()
  if (app.isPackaged) {
    if (!(await bundledAppIsComplete())) {
      await dialog.showMessageBox({
        type: "error",
        title: "MasterHand",
        message: "The MasterHand interface is missing from this installation.",
        detail: "Reinstall the desktop app.",
        buttons: ["Quit"],
      })
      app.quit()
      return
    }
    serveBundledApp()
  }
  createMainWindow()
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
    const window = mainWindow
    if (!window) return
    if (window.isMinimized()) window.restore()
    window.focus()
  })

  void app.whenReady().then(() => void boot())

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length > 0) return
    createMainWindow()
  })

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit()
  })
}
