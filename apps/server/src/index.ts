import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { serve } from "@hono/node-server"
import { serveStatic } from "@hono/node-server/serve-static"
import { createApp } from "./app.js"
import { loadConfig } from "./config.js"
import { createEventHub } from "./events.js"
import { cleanupOrphanTunnels, createPreviewManager, tunnelPidFile } from "./preview.js"
import { createSqliteStore } from "./store.js"
import { createWorktreeManager, reconcileWorktrees } from "./worktrees.js"

const config = loadConfig()
mkdirSync(config.dataDir, { recursive: true })

// A hard crash (SIGKILL, power loss) can leave cloudflared running with its
// tunnel publicly exposed; reap only PIDs still confirmed to be cloudflared.
const orphanTunnels = cleanupOrphanTunnels({ pidFile: tunnelPidFile(config.dataDir) })
if (orphanTunnels.length > 0) {
  console.log(`[masterhand] stopped ${orphanTunnels.length} orphaned preview tunnel(s)`)
}

const store = createSqliteStore(join(config.dataDir, "masterhand.sqlite"))

const hub = createEventHub({
  url: new URL("/api/event", config.opencodeUrl).toString(),
  authHeader: config.opencodeAuth,
})

const worktrees = createWorktreeManager({
  userName: config.gitUserName,
  userEmail: config.gitUserEmail,
})

const preview = createPreviewManager({ config, store })

try {
  const reconciled = reconcileWorktrees(store, worktrees, config.worktreesRoot)
  if (reconciled.skipped) {
    console.warn(
      `[masterhand] worktree reconciliation skipped (${reconciled.skipped}): no worktree data was touched`,
    )
  } else if (reconciled.droppedRecords.length || reconciled.quarantinedWorktrees.length) {
    console.log(
      `[masterhand] worktrees reconciled: ${reconciled.droppedRecords.length} stale record(s), ${reconciled.quarantinedWorktrees.length} orphan(s) quarantined`,
    )
  }
} catch (error) {
  console.warn("[masterhand] worktree reconciliation skipped:", error)
}

const app = createApp({ config, store, hub, worktrees, preview })

if (config.webDist && existsSync(config.webDist)) {
  const webDist = config.webDist
  app.use("*", serveStatic({ root: webDist }))
  app.get("*", (c) => {
    if (c.req.path.startsWith("/api/")) {
      return c.json({ error: "not_found" }, 404)
    }
    return c.html(readFileSync(join(webDist, "index.html"), "utf8"))
  })
}

hub.start()

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`[masterhand] listening on :${info.port} → opencode ${config.opencodeUrl}`)
})

function shutdown(): void {
  preview.stopAll()
  hub.stop()
  store.close()
  server.close(() => process.exit(0))
  // `server.close` waits for open connections, and the SSE stream to every
  // connected client is long-lived; never hang a SIGTERM (docker stop, tests).
  setTimeout(() => process.exit(0), 3000).unref()
}

let shuttingDown = false
function handleSignal(): void {
  if (shuttingDown) return
  shuttingDown = true
  shutdown()
}

process.on("SIGTERM", handleSignal)
process.on("SIGINT", handleSignal)
