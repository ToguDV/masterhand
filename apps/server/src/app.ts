import { randomUUID } from "node:crypto"
import { getConnInfo } from "@hono/node-server/conninfo"
import { Hono } from "hono"
import type { Context } from "hono"
import { streamSSE } from "hono/streaming"
import {
  SESSION_COOKIE,
  clearSessionCookie,
  createDeviceToken,
  createRateLimiter,
  createSessionToken,
  passwordsMatch,
  requireAuth,
  requireSameOrigin,
  setSessionCookie,
} from "./auth.js"
import {
  deriveCommandArguments,
  mergeCommandTemplates,
  type SlashCommand,
} from "./commands.js"
import type { Config } from "./config.js"
import type { EventHub } from "./events.js"
import { createPreviewManager, previewSystemPrompt, PreviewError, type PreviewManager } from "./preview.js"
import { createOpencodeProxy } from "./proxy.js"
import type { IsolatedSessionRecord, Store } from "./store.js"
import {
  createWorktreeManager,
  pullRequestUrl,
  worktreeBranch,
  worktreeDir,
  type WorktreeManager,
} from "./worktrees.js"
import {
  createWorkspaceDir,
  externalWriteGuardRules,
  isInsideRoot,
  normalizeWorkspaceSlug,
  processGuardRules,
  processSystemPrompt,
  removeWorkspaceDir,
  workspacePath,
  workspaceSystemPrompt,
} from "./workspaces.js"

export interface AppDeps {
  config: Config
  store: Store
  hub: EventHub
  fetchImpl?: typeof fetch
  /** Overridable for tests: create/delete workspace folders. */
  createDir?: (path: string) => void
  removeDir?: (path: string) => void
  /** Overridable for tests: git worktree operations. */
  worktrees?: WorktreeManager
  /** Overridable for tests: Cloudflare quick-tunnel previews. */
  preview?: PreviewManager
  /** Overridable for tests: TTL of the per-directory session aggregation cache. */
  sessionsCacheMs?: number
}

const KEEPALIVE_MS = 25_000
const MAX_DEVICE_NAME_LENGTH = 64

interface OpencodeSession {
  id: string
  parentID?: string
}

function clientIp(c: Context): string {
  try {
    // The socket peer address cannot be spoofed by the client, unlike
    // X-Forwarded-For (which would let attackers rotate the rate-limit key).
    return getConnInfo(c).remote.address ?? "unknown"
  } catch {
    return "unknown"
  }
}

/** Fields MasterHand adds to an isolated session for the clients. */
function isolationOf(record: IsolatedSessionRecord) {
  return {
    isolated: true as const,
    worktreePath: record.path,
    branch: record.branch,
    baseRef: record.baseRef,
    pushed: record.pushed,
    prUrl: record.prUrl,
  }
}

export function createApp(deps: AppDeps): Hono {
  const { config } = deps
  const fetchImpl = deps.fetchImpl ?? fetch
  const createDir = deps.createDir ?? createWorkspaceDir
  const removeDir = deps.removeDir ?? removeWorkspaceDir
  const app = new Hono()
  const loginLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 5 })
  const worktrees =
    deps.worktrees ??
    createWorktreeManager({
      userName: config.gitUserName,
      userEmail: config.gitUserEmail,
    })
  const preview = deps.preview ?? createPreviewManager({ config, store: deps.store })

  // Clients poll the workspace session list every 10 s and each poll walks the
  // v2 cursor pages per directory (base + worktrees). A short-lived per-directory
  // cache absorbs concurrent devices and repeated polls; session mutations clear
  // it, and opencode's own lifecycle events clear it too so out-of-band sessions
  // (e.g. subagent children) show up immediately.
  const sessionsCacheMs = deps.sessionsCacheMs ?? 5_000
  const sessionsCache = new Map<string, { at: number; sessions: OpencodeSession[] }>()
  deps.hub.subscribe((event) => {
    const type = (event as { type?: unknown } | null)?.type
    if (type === "session.created" || type === "session.deleted") invalidateSessionsCache()
  })

  /**
   * Calls opencode directly (injecting basic auth). The `directory` override
   * travels as a query parameter exactly like the clients' proxy calls.
   */
  function callOpencode(
    path: string,
    options: { method?: string; directory?: string | null; location?: string | null; body?: unknown } = {},
  ): Promise<Response> {
    const method = options.method ?? "GET"
    const headers = new Headers()
    if (config.opencodeAuth) headers.set("authorization", config.opencodeAuth)
    if (options.body !== undefined) headers.set("content-type", "application/json")
    const target = new URL(path, config.opencodeUrl)
    if (options.directory) {
      target.searchParams.set("directory", options.directory)
    }
    if (options.location) {
      // Location-scoped routes (`/api/command`, `/api/config`, …) take the
      // nested `location[directory]` query, unlike the flat `/api/session`.
      target.searchParams.set("location[directory]", options.location)
    }
    return fetchImpl(target, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })
  }

  /** Lists every session in a directory, following opencode's v2 cursor pagination. */
  async function sessionsInDirectory(directory: string): Promise<OpencodeSession[]> {
    const cached = sessionsCache.get(directory)
    if (cached && Date.now() - cached.at < sessionsCacheMs) return cached.sessions

    const sessions: OpencodeSession[] = []
    let cursor: string | undefined
    for (let page = 0; page < 50; page += 1) {
      const target = new URL("/api/session", config.opencodeUrl)
      target.searchParams.set("directory", directory)
      target.searchParams.set("limit", "200")
      if (cursor) target.searchParams.set("cursor", cursor)
      const response = await fetchImpl(target, {
        headers: config.opencodeAuth ? { authorization: config.opencodeAuth } : {},
      })
      if (!response.ok) throw new Error(`opencode ${response.status}`)
      const body = (await response.json()) as {
        data?: OpencodeSession[]
        cursor?: { next?: string | null }
      }
      sessions.push(...(body.data ?? []))
      const next = body.cursor?.next
      if (!next) break
      cursor = next
    }
    sessionsCache.set(directory, { at: Date.now(), sessions })
    return sessions
  }

  /** Session and worktree mutations make the aggregation cache stale. */
  function invalidateSessionsCache(): void {
    sessionsCache.clear()
  }

  /**
   * Writes a session instruction entry: opencode includes it in the model's
   * system context on every turn. Best effort — a failure must never block
   * session creation or prompting.
   */
  async function writeSessionInstruction(sessionID: string, key: string, value: string): Promise<void> {
    try {
      const response = await callOpencode(
        `/api/experimental/session/${encodeURIComponent(sessionID)}/instructions/entries/${encodeURIComponent(key)}`,
        { method: "PUT", body: { value } },
      )
      if (!response.ok) {
        console.warn(`[instructions] could not store ${key} for ${sessionID} (HTTP ${response.status})`)
      }
    } catch {
      // opencode unreachable: the session works, just without the instruction
    }
  }

  /**
   * Records the reserved preview port as a session instruction entry so the
   * agent binds its web server to it. Best effort: previews must never block
   * session creation or prompting.
   */
  async function ensurePreviewInstruction(sessionID: string): Promise<void> {
    if (!config.previewEnabled) return
    let port: number
    try {
      port = preview.portFor(sessionID)
    } catch {
      return
    }
    await writeSessionInstruction(sessionID, "masterhand.preview", previewSystemPrompt(port))
  }

  /**
   * Pins the session to the exact directory MasterHand assigned it (its own
   * project root), so the agent never mistakes the MasterHand server repo — or
   * a sibling workspace — for its own. A distinct instruction key keeps it
   * independent from `masterhand.preview`.
   */
  async function ensureWorkspaceInstruction(sessionID: string, directory: string): Promise<void> {
    await writeSessionInstruction(sessionID, "masterhand.workspace", workspaceSystemPrompt(directory))
  }

  /**
   * Sets the session permission guards in one PATCH (the field replaces the
   * whole ruleset): writes outside the session directory are blocked while
   * reads stay allowed, and dangerous process-killing shell commands are
   * denied so a broad kill cannot take down the agent engine. Best effort: it
   * must never block session creation.
   */
  async function ensurePermissionGuards(sessionID: string): Promise<void> {
    try {
      const response = await callOpencode(`/api/session/${encodeURIComponent(sessionID)}`, {
        method: "PATCH",
        body: { permissions: [...externalWriteGuardRules(), ...processGuardRules()] },
      })
      if (!response.ok) {
        console.warn(`[workspace] could not set the session permission guards for ${sessionID} (HTTP ${response.status})`)
      }
    } catch {
      // opencode unreachable: the workspace instruction still applies
    }
  }

  /**
   * Process-safety instruction, independent from `masterhand.workspace`: steers
   * the model away from broad kills and toward the supported lifecycle. The
   * permission guard is the enforcement; this is the guidance.
   */
  async function ensureProcessInstruction(sessionID: string): Promise<void> {
    await writeSessionInstruction(sessionID, "masterhand.process", processSystemPrompt())
  }

  /** Applies the workspace guardrails to a freshly created session. */
  async function ensureWorkspaceGuard(sessionID: string, directory: string): Promise<void> {
    await ensureWorkspaceInstruction(sessionID, directory)
    await ensureProcessInstruction(sessionID)
    await ensurePermissionGuards(sessionID)
  }

  /**
   * Makes `path` its own git root so opencode resolves its project root (and
   * `/init`) to the workspace instead of an ancestor repo such as MasterHand.
   * Best effort at session creation: the instruction and permission guards still
   * apply if git is unavailable.
   */
  function ensureWorkspaceRepo(path: string): void {
    try {
      worktrees.ensureRepo(path)
    } catch (error) {
      console.warn(
        `[workspace] could not initialize a git repo at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  app.use("/api/*", requireSameOrigin(config))

  app.get("/api/health", (c) => c.json({ ok: true }))

  app.post("/api/login", async (c) => {
    const ip = clientIp(c)
    if (!loginLimiter.check(ip)) {
      return c.json({ error: "too_many_attempts" }, 429)
    }

    let password: unknown
    try {
      password = (await c.req.json<{ password?: unknown }>()).password
    } catch {
      password = undefined
    }
    if (typeof password !== "string" || password.length === 0) {
      return c.json({ error: "bad_request" }, 400)
    }
    if (!passwordsMatch(password, config.masterhandPassword)) {
      return c.json({ error: "invalid_password" }, 401)
    }

    loginLimiter.reset(ip)
    const token = createSessionToken(config.sessionSecret, config.sessionTtlHours * 3600)
    setSessionCookie(c, token, config)
    return c.json({ ok: true })
  })

  app.post("/api/devices", async (c) => {
    const ip = clientIp(c)
    if (!loginLimiter.check(ip)) {
      return c.json({ error: "too_many_attempts" }, 429)
    }

    let body: { password?: unknown; name?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "bad_request" }, 400)
    }
    if (typeof body.password !== "string" || body.password.length === 0) {
      return c.json({ error: "bad_request" }, 400)
    }
    if (!passwordsMatch(body.password, config.masterhandPassword)) {
      return c.json({ error: "invalid_password" }, 401)
    }

    loginLimiter.reset(ip)
    const now = Date.now()
    const name =
      typeof body.name === "string" && body.name.trim()
        ? body.name.trim().slice(0, MAX_DEVICE_NAME_LENGTH)
        : "Device"
    const device = { id: randomUUID(), name, createdAt: now, lastUsedAt: now }
    deps.store.create(device)
    const token = createDeviceToken(config.sessionSecret, device.id, config.sessionTtlHours * 3600)
    return c.json({ token, device }, 201)
  })

  app.post("/api/logout", (c) => {
    clearSessionCookie(c, config)
    return c.json({ ok: true })
  })

  app.use("/api/oc/*", requireAuth(config, deps.store))
  app.all("/api/oc/*", createOpencodeProxy(config, fetchImpl))

  const api = new Hono()
  api.use("*", requireAuth(config, deps.store))

  api.get("/status", async (c) => {
    const previewStatus = {
      enabled: config.previewEnabled,
      available: config.previewEnabled && preview.available(),
      portRange: config.previewPortRange,
    }
    try {
      const health = await fetchImpl(new URL("/api/info", config.opencodeUrl), {
        headers: config.opencodeAuth ? { authorization: config.opencodeAuth } : {},
        signal: AbortSignal.timeout(3000),
      })
      if (!health.ok) {
        const error = health.status === 401 || health.status === 403 ? "unauthorized" : "unreachable"
        return c.json({ ok: true, opencode: { healthy: false, error }, preview: previewStatus })
      }
      const data = (await health.json()) as { version?: string }
      return c.json({
        ok: true,
        opencode: { healthy: true, version: data.version },
        preview: previewStatus,
      })
    } catch {
      return c.json({ ok: true, opencode: { healthy: false, error: "unreachable" }, preview: previewStatus })
    }
  })

  api.get("/events", (c) => {
    c.header("cache-control", "no-cache")
    c.header("x-accel-buffering", "no")
    return streamSSE(c, async (stream) => {
      let closed = false
      const unsubscribe = deps.hub.subscribe((event) => {
        if (closed) return
        // A rejected write means the client disconnected mid-frame; drop the
        // subscription instead of leaking an unhandled rejection.
        stream.writeSSE({ data: JSON.stringify(event) }).catch(() => {
          closed = true
          unsubscribe()
        })
      })
      stream.onAbort(() => {
        closed = true
        unsubscribe()
      })

      try {
        await stream.writeSSE({
          event: "hello",
          data: JSON.stringify({ connected: deps.hub.connected }),
        })
        while (!closed) {
          await stream.sleep(KEEPALIVE_MS)
          if (!closed) await stream.writeSSE({ event: "ping", data: "{}" })
        }
      } catch {
        // client disconnected
      } finally {
        closed = true
        unsubscribe()
      }
    })
  })

  api.get("/devices", (c) => c.json({ devices: deps.store.list() }))

  api.delete("/devices/:id", (c) => {
    deps.store.remove(c.req.param("id"))
    return c.json({ ok: true })
  })

  /**
   * Slash commands for a location, with deterministic argument hints. Composes
   * opencode's `command` catalog with the templates only its config exposes, so
   * raw config (which may hold secrets) never reaches the clients.
   */
  api.get("/commands", async (c) => {
    const directory = c.req.query("directory") ?? null

    let commandResponse: Response
    try {
      commandResponse = await callOpencode("/api/command", { location: directory })
    } catch {
      return c.json({ error: "opencode_unreachable" }, 502)
    }
    if (!commandResponse.ok) return c.json({ error: "opencode_error" }, 502)

    // Argument hints are best-effort: a broken config must not hide commands.
    let templates = new Map<string, string>()
    try {
      const configResponse = await callOpencode("/api/config", { location: directory })
      if (configResponse.ok) templates = mergeCommandTemplates(await configResponse.json())
    } catch {
      // keep the commands without templates
    }

    const body = (await commandResponse.json()) as { data?: unknown }
    const commands: SlashCommand[] = []
    for (const raw of Array.isArray(body.data) ? body.data : []) {
      const entry = raw as { name?: unknown; description?: unknown }
      if (typeof entry?.name !== "string" || entry.name.length === 0) continue
      const description = typeof entry.description === "string" ? entry.description : undefined
      commands.push({
        name: entry.name,
        ...(description ? { description } : {}),
        arguments: deriveCommandArguments(description, templates.get(entry.name)),
      })
    }
    return c.json({ commands })
  })

  api.get("/workspaces", (c) => c.json({ workspaces: deps.store.listWorkspaces() }))

  api.post("/workspaces", async (c) => {
    let body: { name?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "bad_request" }, 400)
    }

    const result = normalizeWorkspaceSlug(body.name)
    if (!result.ok) return c.json({ error: "invalid_name" }, 400)

    const path = workspacePath(config.workspacesRoot, result.slug)
    if (deps.store.getWorkspaceByPath(path)) {
      return c.json({ error: "already_exists" }, 409)
    }

    createDir(path)
    ensureWorkspaceRepo(path)
    const workspace = { id: randomUUID(), name: result.slug, path, createdAt: Date.now() }
    deps.store.createWorkspace(workspace)
    return c.json({ workspace }, 201)
  })

  api.delete("/workspaces/:id", (c) => {
    const workspace = deps.store.getWorkspace(c.req.param("id"))
    if (!workspace) return c.json({ error: "not_found" }, 404)

    // Isolated worktrees live outside the workspace folder, so they always
    // have to be cleaned up explicitly.
    for (const record of deps.store.listIsolatedSessions(workspace.id)) {
      try {
        worktrees.remove(workspace.path, record.path, record.branch)
      } catch {
        // best effort: the folder may already be gone
      }
      deps.store.removeIsolatedSession(record.sessionID)
      preview.forget(record.sessionID)
    }

    if (c.req.query("deleteFiles") === "1") {
      if (!isInsideRoot(config.workspacesRoot, workspace.path)) {
        return c.json({ error: "outside_root" }, 403)
      }
      removeDir(workspace.path)
    }

    deps.store.removeWorkspace(workspace.id)
    invalidateSessionsCache()
    return c.json({ ok: true })
  })

  api.get("/workspaces/:id/directories", (c) => {
    const workspace = deps.store.getWorkspace(c.req.param("id"))
    if (!workspace) return c.json({ error: "not_found" }, 404)
    const directories = [
      workspace.path,
      ...deps.store.listIsolatedSessions(workspace.id).map((record) => record.path),
    ]
    return c.json({ directories })
  })

  api.get("/workspaces/:id/sessions", async (c) => {
    const workspace = deps.store.getWorkspace(c.req.param("id"))
    if (!workspace) return c.json({ error: "not_found" }, 404)

    const records = deps.store.listIsolatedSessions(workspace.id)
    let lists: OpencodeSession[][]
    try {
      // The base folder must answer (502 otherwise); a missing/broken worktree
      // only drops its own sessions.
      lists = await Promise.all([
        sessionsInDirectory(workspace.path),
        ...records.map((record) => sessionsInDirectory(record.path).catch(() => [])),
      ])
    } catch {
      return c.json({ error: "opencode_unreachable" }, 502)
    }

    const byID = new Map(records.map((record) => [record.sessionID, record]))
    const merged = new Map<string, OpencodeSession & { isolation?: ReturnType<typeof isolationOf> }>()
    for (const session of lists.flat()) {
      // Child (subagent) sessions inherit their parent's worktree annotation.
      const record = byID.get(session.id) ?? (session.parentID ? byID.get(session.parentID) : undefined)
      merged.set(session.id, record ? { ...session, isolation: isolationOf(record) } : session)
    }
    return c.json({ sessions: [...merged.values()] })
  })

  api.post("/workspaces/:id/sessions", async (c) => {
    const workspace = deps.store.getWorkspace(c.req.param("id"))
    if (!workspace) return c.json({ error: "not_found" }, 404)

    let body: { isolated?: unknown } = {}
    try {
      body = await c.req.json()
    } catch {
      // an empty body means a standard (non-isolated) session
    }

    if (body.isolated !== true) {
      ensureWorkspaceRepo(workspace.path)
      let response: Response
      try {
        response = await callOpencode("/api/session", {
          method: "POST",
          body: { location: { directory: workspace.path } },
        })
      } catch {
        return c.json({ error: "opencode_unreachable" }, 502)
      }
      if (!response.ok) return c.json({ error: "opencode_error" }, 502)
      const session = ((await response.json()) as { data: OpencodeSession }).data
      invalidateSessionsCache()
      await ensurePreviewInstruction(session.id)
      await ensureWorkspaceGuard(session.id, workspace.path)
      return c.json({ session, isolation: null }, 201)
    }

    const token = randomUUID().replace(/-/g, "").slice(0, 10)
    let path: string
    let branch: string
    let baseRef: string
    try {
      branch = worktreeBranch(workspace.name, token)
      path = worktreeDir(config.worktreesRoot, workspace.name, token)
    } catch {
      return c.json({ error: "invalid_isolation" }, 400)
    }

    let sessionID: string | null = null
    try {
      worktrees.ensureRepo(workspace.path)
      baseRef = worktrees.headBranch(workspace.path)
      worktrees.create(workspace.path, path, branch, baseRef)

      const response = await callOpencode("/api/session", {
        method: "POST",
        body: { location: { directory: path } },
      })
      if (!response.ok) throw new Error("opencode_error")
      const session = ((await response.json()) as { data: OpencodeSession }).data
      sessionID = session.id
      invalidateSessionsCache()
      await ensurePreviewInstruction(session.id)
      await ensureWorkspaceGuard(session.id, path)

      const record: IsolatedSessionRecord = {
        sessionID: session.id,
        workspaceID: workspace.id,
        path,
        branch,
        baseRef,
        pushed: false,
        prUrl: null,
        createdAt: Date.now(),
      }
      deps.store.createIsolatedSession(record)
      return c.json({ session: { ...session, isolation: isolationOf(record) }, isolation: isolationOf(record) }, 201)
    } catch (error) {
      if (sessionID) {
        void callOpencode(`/api/session/${encodeURIComponent(sessionID)}`, { method: "DELETE" }).catch(() => {})
      }
      try {
        worktrees.remove(workspace.path, path, branch)
      } catch {
        // the worktree may not exist if creation failed early
      }
      return c.json(
        { error: "isolation_failed", detail: error instanceof Error ? error.message : "unknown" },
        500,
      )
    }
  })

  api.delete("/workspaces/:id/sessions/:sessionID", async (c) => {
    const workspace = deps.store.getWorkspace(c.req.param("id"))
    if (!workspace) return c.json({ error: "not_found" }, 404)
    const sessionID = c.req.param("sessionID")
    const record = deps.store.getIsolatedSession(sessionID)
    const isolated = record && record.workspaceID === workspace.id

    let response: Response
    try {
      response = await callOpencode(`/api/session/${encodeURIComponent(sessionID)}`, { method: "DELETE" })
    } catch {
      return c.json({ error: "opencode_unreachable" }, 502)
    }
    if (!response.ok && response.status !== 404) return c.json({ error: "opencode_error" }, 502)
    invalidateSessionsCache()

    if (isolated) {
      try {
        worktrees.remove(workspace.path, record.path, record.branch)
      } catch {
        // best effort: never block deleting the session record
      }
      deps.store.removeIsolatedSession(sessionID)
    }
    preview.forget(sessionID)
    return c.json({ ok: true })
  })

  api.post("/isolated-sessions/:sessionID/finish", async (c) => {
    const record = deps.store.getIsolatedSession(c.req.param("sessionID"))
    if (!record) return c.json({ error: "not_found" }, 404)
    const workspace = deps.store.getWorkspace(record.workspaceID)
    if (!workspace) return c.json({ error: "not_found" }, 404)

    let committed = false
    try {
      committed = worktrees.commitAll(record.path, `MasterHand session ${record.sessionID}`)
    } catch (error) {
      return c.json(
        { error: "commit_failed", detail: error instanceof Error ? error.message : "unknown" },
        500,
      )
    }

    let pushed = false
    let pushError: string | null = null
    let prUrl = record.prUrl
    const remoteUrl = worktrees.remoteUrl(record.path)
    if (remoteUrl) {
      try {
        worktrees.push(record.path, record.branch)
        pushed = true
      } catch (error) {
        pushError = error instanceof Error ? error.message : "push_failed"
      }
      if (pushed) {
        // Prefer the provider CLI when authenticated; otherwise hand back a
        // ready-to-open compare URL.
        prUrl =
          worktrees.pullRequest(record.path, remoteUrl, record.branch, record.baseRef) ??
          pullRequestUrl(remoteUrl, record.branch, record.baseRef)
      }
    }

    deps.store.updateIsolatedSession(record.sessionID, { pushed, prUrl })
    return c.json({
      committed,
      pushed,
      prUrl,
      branch: record.branch,
      path: record.path,
      error: pushError,
    })
  })

  api.get("/sessions/:sessionID/preview", (c) => {
    if (!config.previewEnabled) return c.json({ error: "preview_disabled" }, 404)
    return c.json({ preview: preview.status(c.req.param("sessionID")) })
  })

  api.post("/sessions/:sessionID/preview", async (c) => {
    if (!config.previewEnabled) return c.json({ error: "preview_disabled" }, 404)
    if (!preview.available()) return c.json({ error: "preview_unavailable" }, 503)
    await ensurePreviewInstruction(c.req.param("sessionID"))
    try {
      return c.json({ preview: await preview.start(c.req.param("sessionID")) })
    } catch (error) {
      const code = error instanceof PreviewError ? error.code : "preview_failed"
      const status = code === "preview_not_running" ? 409 : code === "preview_ports_exhausted" ? 503 : 502
      return c.json({ error: code, detail: error instanceof Error ? error.message : undefined }, status)
    }
  })

  api.delete("/sessions/:sessionID/preview", (c) => {
    if (!config.previewEnabled) return c.json({ error: "preview_disabled" }, 404)
    preview.stop(c.req.param("sessionID"))
    return c.json({ ok: true })
  })

  app.route("/api", api)

  return app
}

export { SESSION_COOKIE }
