import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { serve } from "@hono/node-server"
import { serveStatic } from "@hono/node-server/serve-static"
import { bootstrapApp } from "./bootstrap.js"
import { loadConfig } from "./config.js"
import { createEventHub } from "./events.js"
import { cleanupOrphanTunnels, createPreviewManager, tunnelPidFile } from "./preview.js"
import { DEFAULT_WEBSEARCH_PROVIDER, createCustomProviderStore, ensureWebsearchDefault } from "./providers.js"
import { shutdownServer } from "./shutdown.js"
import { acquireDataDirLock, createSqliteStore, ensureDataDir, type DataDirLock } from "./store.js"
import { createWorktreeManager, launchBackgroundReconcile } from "./worktrees.js"

const config = loadConfig()
ensureDataDir(config.dataDir)

// One BFF instance over one data directory (ARCHITECTURE.md ADR-26): a
// second process would own its own tunnels/PTYs while sharing the SQLite
// file. Refuse loudly instead of corrupting in-process state (issue #208).
let dataDirLock: DataDirLock
try {
  dataDirLock = await acquireDataDirLock(config.dataDir)
} catch (error) {
  console.error("[masterhand] refusing to boot:", error instanceof Error ? error.message : error)
  process.exit(1)
}

let store: ReturnType<typeof createSqliteStore>
try {
  store = createSqliteStore(join(config.dataDir, "masterhand.sqlite"))
} catch (error) {
  // Corrupt database, unreadable volume, …: fail loudly with the restore
  // pointer instead of serving broken requests (issue #80/#88).
  console.error("[masterhand] storage unavailable at boot:", error)
  process.exit(1)
}

// A hard crash (SIGKILL, power loss) can leave cloudflared running with its
// tunnel publicly exposed; reap only PIDs still confirmed to be cloudflared.
// Asynchronous (issue #200): even `/proc` reads must not block the loop.
const orphanTunnels = await cleanupOrphanTunnels({ pidFile: tunnelPidFile(config.dataDir) })
if (orphanTunnels.length > 0) {
  console.log(`[masterhand] stopped ${orphanTunnels.length} orphaned preview tunnel(s)`)
}

const hub = createEventHub({
  url: new URL("/api/event", config.opencodeUrl).toString(),
  authHeader: config.opencodeAuth,
})

const worktrees = createWorktreeManager({
  userName: config.gitUserName,
  userEmail: config.gitUserEmail,
})

const preview = createPreviewManager({ config, store })

// MasterHand owns opencode's `websearch` selection through the same config
// file that holds custom providers. When the key is absent it seeds the
// keyless source, so agent web searches work without an API key and without
// opencode's own provider prompt (which MasterHand clients do not render).
const providers = createCustomProviderStore({ file: config.customProvidersFile })
try {
  if (await ensureWebsearchDefault(providers)) {
    console.log(`[masterhand] web search default set to ${DEFAULT_WEBSEARCH_PROVIDER}`)
  }
} catch (error) {
  console.warn("[masterhand] web search default skipped:", error)
}

// `/api/health` readiness (issue #199): false until the background worktree
// pass settles. Liveness answers immediately; only readiness waits.
let worktreesReady = false

const built = bootstrapApp({
  config,
  store,
  hub,
  worktrees,
  preview,
  providers,
  proxyBodyLimitBytes: config.proxyBodyLimitMb * 1024 * 1024,
  isReady: () => worktreesReady,
})
const app = built.app
// Scheduled tasks (issue #147): the manager starts its loop with the app;
// `bootstrapApp` already ran the single boot pass settling what a restart
// orphaned (firing → interrupted, queued → skipped) and recomputed every
// pending slot. Goal runs never auto-resume after a restart either; both
// managers stop and drain on shutdown (issue #192).
const scheduler = built.scheduler
const goals = built.goals
// In-flight finishes/releases settle against a live store while shutting down.
const drainInFlight = built.drainInFlight

if (config.webDist && existsSync(config.webDist)) {
  const webDist = config.webDist
  // Read once at boot (issue #200): the catch-all served it synchronously on
  // every SPA navigation, freezing the event loop each time. A missing asset
  // must degrade to API-only, never crash the boot (rule 14): before this
  // change only the SPA fallback answered 500 while the API stayed healthy.
  let indexHtml: string | null = null
  try {
    indexHtml = readFileSync(join(webDist, "index.html"), "utf8")
  } catch (error) {
    console.warn("[masterhand] web index.html unreadable, serving API only:", error)
  }
  app.use("*", serveStatic({ root: webDist }))
  app.get("*", (c) => {
    if (c.req.path.startsWith("/api/")) {
      return c.json({ error: "not_found" }, 404)
    }
    if (indexHtml === null) {
      return c.json({ error: "web_unavailable" }, 500)
    }
    return c.html(indexHtml)
  })
}

hub.start()

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`[masterhand] listening on :${info.port} → opencode ${config.opencodeUrl}`)
})

// Worktree reconciliation (issue #199) settles AFTER the server listens: the
// pass can cost N×2×60 s of git, and awaiting it before `serve()` held the
// compose healthcheck (`GET /api/health`) past its start period until Docker
// restart-looped the container. The volume-health gate and quarantine
// semantics are unchanged (rule 11); only the waiting moved. Readiness flips
// when the pass settles, liveness answers immediately.
const worktreeReconcile = launchBackgroundReconcile({
  store,
  manager: worktrees,
  root: config.worktreesRoot,
  onSettled: (reconciled) => {
    // Settles success and failure alike: a warned failure still serves (as
    // before), so readiness must flip either way — otherwise one bad git
    // pass would pin the container unhealthy forever.
    worktreesReady = true
    if (!reconciled) return
    if (reconciled.skipped) {
      console.warn(
        `[masterhand] worktree reconciliation skipped (${reconciled.skipped}): no worktree data was touched`,
      )
    } else if (reconciled.droppedRecords.length || reconciled.quarantinedWorktrees.length) {
      console.log(
        `[masterhand] worktrees reconciled: ${reconciled.droppedRecords.length} stale record(s), ${reconciled.quarantinedWorktrees.length} orphan(s) quarantined`,
      )
    }
  },
})
// `settled` never rejects (failures are warned inside), so there is nothing
// to await or catch here; the handle stays for shutdown ordering if needed.
void worktreeReconcile.settled

async function shutdown(code = 0): Promise<void> {
  // Ordered, bounded (issue #192): HTTP first (long-lived SSE streams would
  // otherwise hold `server.close` open), then the managers drain against a
  // live store, and the store closes last. The forced-exit backstop installs
  // first so a stalled step can never hang a SIGTERM.
  await shutdownServer({ scheduler, goals, preview, hub, store, server, lock: dataDirLock, drainInFlight })
}

let shuttingDown = false
function handleSignal(): void {
  if (shuttingDown) return
  shuttingDown = true
  void shutdown()
}

/**
 * Unexpected failures get a structured diagnostic and a deliberate exit;
 * `restart: unless-stopped` brings the container back (issue #88). Logging
 * beats a silent drop, and exiting beats serving requests in an unknown state.
 */
function handleFatal(kind: "uncaughtException" | "unhandledRejection", error: unknown): void {
  console.error(`[masterhand] fatal ${kind}:`, error)
  if (shuttingDown) return
  shuttingDown = true
  void shutdown(1)
}

process.on("SIGTERM", handleSignal)
process.on("SIGINT", handleSignal)
process.on("uncaughtException", (error) => handleFatal("uncaughtException", error))
process.on("unhandledRejection", (reason) => handleFatal("unhandledRejection", reason))
