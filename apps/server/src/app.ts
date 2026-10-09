import { randomUUID } from "node:crypto"
import { statfsSync } from "node:fs"
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
import {
  createGoalManager,
  GOAL_DELIVERY_MARKER_KEY,
  GOAL_INTERNAL_MARKER_KEY,
  GOAL_SESSION_MARKER_KEY,
  GoalError,
  type GoalManager,
  type GoalOpencode,
} from "./goal.js"
import { createPreviewManager, previewSystemPrompt, PreviewError, type PreviewManager } from "./preview.js"
import { createOpencodeProxy, type ProxyRetryOptions } from "./proxy.js"
import { OpencodeTimeoutError, RetryExhaustedError, UpstreamStatusError, isTransientStatus, withRetry } from "./retry.js"
import {
  CustomProvidersFileError,
  createCustomProviderStore,
  fetchProviderModels,
  validateCustomProvider,
  validateDiscoverInput,
  type CustomProviderStore,
} from "./providers.js"
import {
  createRunManager,
  readRunFile,
  RunError,
  runSystemPrompt,
  validateRunConfig,
  type RunManager,
  type RunOpencode,
} from "./runs.js"
import type { IsolatedSessionRecord, Store, WorkspaceRunRecord } from "./store.js"
import { isStorageConflict, isStorageError } from "./store.js"
import {
  createWorktreeManager,
  isValidBranchName,
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
  createDir?: (path: string) => Promise<void>
  removeDir?: (path: string) => Promise<void>
  /** Overridable for tests: git worktree operations. */
  worktrees?: WorktreeManager
  /** Overridable for tests: Cloudflare quick-tunnel previews. */
  preview?: PreviewManager
  /** Overridable for tests: managed dev-server lifecycle. */
  runs?: RunManager
  /** Overridable for tests: MasterHand-managed OpenAI-compatible providers. */
  providers?: CustomProviderStore
  /** Overridable for tests: Goal Mode orchestration. */
  goals?: GoalManager
  /** Overridable for tests: proxy retry tuning (attempts/backoff/sleep). */
  proxyRetry?: ProxyRetryOptions
  /** Overridable for tests: TTL of the per-directory session aggregation cache. */
  sessionsCacheMs?: number
  /** Overridable for tests: frames an SSE client may fall behind before it is dropped. */
  sseQueueMax?: number
  /** Overridable for tests: free bytes on the data volume, or null when unknown. */
  diskFreeBytes?: (path: string) => number | null
}

const KEEPALIVE_MS = 25_000
const MAX_DEVICE_NAME_LENGTH = 64
/** Frames a single SSE client may fall behind before it is dropped. */
const MAX_SSE_QUEUE = 1024

/** Methods safe to retry outright: replaying them cannot duplicate state. */
const IDEMPOTENT_OPENCODE_METHODS = new Set(["GET", "HEAD", "PUT", "PATCH", "DELETE"])
/** Internal opencode retries for idempotent calls (transient statuses/network). */
const OPENCODE_RETRY_ATTEMPTS = 4
const OPENCODE_RETRY_BASE_MS = 250

interface OpencodeSession {
  id: string
  parentID?: string
  metadata?: Record<string, unknown>
}

type GoalRole = "critic" | "judge"

/**
 * The Goal Mode role of an internal session. The pinned opencode (v2.0.6)
 * silently drops `parentID` on create, so a critic/judge session comes back as
 * a root: it is recognized by the stable metadata role the BFF writes, or — for
 * sessions created before that key existed — by the role prefix of the unique
 * reconciliation marker (`masterhand.goal.role`).
 */
function goalRoleFromMetadata(metadata: Record<string, unknown> | undefined): GoalRole | null {
  const role = metadata?.[GOAL_INTERNAL_MARKER_KEY]
  if (role === "critic" || role === "judge") return role
  const marker = metadata?.[GOAL_SESSION_MARKER_KEY]
  if (typeof marker === "string" && /^(critic|judge)_[a-z0-9]+_\d+_\d+$/.test(marker)) {
    return marker.startsWith("critic_") ? "critic" : "judge"
  }
  return null
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

/** Free bytes on the filesystem holding `path`; null when it cannot be read. */
function defaultDiskFreeBytes(path: string): number | null {
  try {
    const stats = statfsSync(path)
    return Number(stats.bavail) * Number(stats.bsize)
  } catch {
    return null
  }
}

/**
 * Metadata key under which MasterHand persists a client's session-create
 * marker (must match `CREATE_MARKER_KEY` in `client-core`). opencode returns
 * it from the session list, so a lost create response can be reconciled.
 */
const CREATE_MARKER_KEY = "masterhand.create"

/** Opaque, bounded marker; anything else is ignored (best effort). */
function normalizeCreateMarker(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9._-]{8,128}$/.test(value) ? value : null
}

/** Session create body, with the reconciliation marker attached when present. */
function sessionCreateBody(directory: string, marker: string | null) {
  return {
    location: { directory },
    ...(marker ? { metadata: { [CREATE_MARKER_KEY]: marker } } : {}),
  }
}

/** Concatenates the text parts of a v2 assistant message (marker parsing). */
function assistantMessageText(message: { content?: unknown }): string {
  const parts = Array.isArray(message.content) ? message.content : []
  return parts
    .filter(
      (part): part is { type: string; text: string } =>
        Boolean(part) &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("\n")
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
  // One structured error path for every uncaught route/middleware failure:
  // method + path in the log, a typed JSON body for clients, and storage
  // failures mapped to an actionable 503 (issue #88/#86).
  app.onError((error, c) => {
    const storage = isStorageError(error)
    console.error(`[masterhand] ${c.req.method} ${c.req.path} failed${storage ? " (storage)" : ""}:`, error)
    if (storage) return c.json({ error: "storage_unavailable" }, 503)
    return c.json({ error: "internal_error" }, 500)
  })
  const loginLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 5 })
  const worktrees =
    deps.worktrees ??
    createWorktreeManager({
      userName: config.gitUserName,
      userEmail: config.gitUserEmail,
    })
  const preview = deps.preview ?? createPreviewManager({ config, store: deps.store })

  /**
   * Managed dev-server lifecycle over opencode's PTY API. The run process is
   * created and deleted by the BFF (never by the agent), always inside the
   * session's directory, so stopping it cannot take down anything else.
   */
  const runOpencode: RunOpencode = {
    async createPty({ directory, command, args, cwd, title, env }) {
      const response = await callOpencode("/api/pty", {
        method: "POST",
        location: directory,
        body: { command, args, cwd, title, env },
      })
      if (!response.ok) throw new Error(`opencode ${response.status}`)
      const body = (await response.json()) as { data: { id: string; pid: number; status: string; title: string } }
      return body.data
    },
    async listPtys(directory) {
      const response = await callOpencode("/api/pty", { location: directory })
      if (!response.ok) throw new Error(`opencode ${response.status}`)
      const body = (await response.json()) as {
        data: Array<{ id: string; pid: number; status: string; title: string }>
      }
      return body.data
    },
    async removePty(directory, ptyID) {
      const response = await callOpencode(`/api/pty/${encodeURIComponent(ptyID)}`, {
        method: "DELETE",
        location: directory,
      })
      if (!response.ok && response.status !== 404) throw new Error(`opencode ${response.status}`)
    },
  }
  const runs = deps.runs ?? createRunManager({ opencode: runOpencode })
  const providers = deps.providers ?? createCustomProviderStore({ file: config.customProvidersFile })

  /**
   * opencode adapter for Goal Mode. It translates HTTP outcomes into thrown
   * typed errors; the retry policy (bounded backoff, marker reconciliation for
   * non-idempotent calls) lives in the goal manager / shared retry engine.
   */
  const goalOpencode: GoalOpencode = {
    async sessionInfo(sessionID) {
      const response = await callOpencode(`/api/session/${encodeURIComponent(sessionID)}`, { retry: false })
      if (response.status === 404) return null
      if (!response.ok) throw new UpstreamStatusError(response.status, response)
      const body = (await response.json()) as {
        data?: {
          location?: { directory?: string }
          parentID?: string
          agent?: string
          model?: { id?: string; providerID?: string; variant?: string }
        }
      }
      const directory = body.data?.location?.directory
      if (!body.data || !directory) return null
      const model =
        body.data.model?.providerID && body.data.model.id
          ? {
              providerID: body.data.model.providerID,
              id: body.data.model.id,
              variant: body.data.model.variant ?? null,
            }
          : null
      return {
        directory,
        parentID: body.data.parentID,
        model,
        agent: typeof body.data.agent === "string" && body.data.agent ? body.data.agent : null,
      }
    },
    async createSession({ directory, parentID, title, marker, role }) {
      const response = await callOpencode("/api/session", {
        method: "POST",
        body: {
          location: { directory },
          parentID,
          title,
          metadata: { [GOAL_SESSION_MARKER_KEY]: marker, [GOAL_INTERNAL_MARKER_KEY]: role },
        },
      })
      if (!response.ok) throw new UpstreamStatusError(response.status, response)
      const body = (await response.json()) as { data?: { id?: string } }
      const id = body.data?.id
      if (!id) throw new Error("opencode did not return a session id")
      invalidateSessionsCache()
      return { id }
    },
    async findSessionByMarker(directory, marker) {
      // Scoped by directory, NOT by parentID: the pinned opencode silently
      // drops `parentID` on create, so the session is a root and a parentID
      // filter would always miss it — the retry would replay the create and
      // duplicate the internal session. The marker is unique per run, and the
      // just-created session is the newest (desc order), so a single page wins.
      const response = await callOpencode(
        `/api/session?directory=${encodeURIComponent(directory)}&limit=200`,
        { retry: false },
      )
      if (!response.ok) throw new UpstreamStatusError(response.status, response)
      const body = (await response.json()) as {
        data?: Array<{ id?: string; metadata?: Record<string, unknown> }>
      }
      const found = (body.data ?? []).find((session) => session.metadata?.[GOAL_SESSION_MARKER_KEY] === marker)
      return found?.id ? { id: found.id } : null
    },
    async prompt(sessionID, text, marker) {
      const response = await callOpencode(`/api/session/${encodeURIComponent(sessionID)}/prompt`, {
        method: "POST",
        body: { text, metadata: { [GOAL_DELIVERY_MARKER_KEY]: marker } },
      })
      if (!response.ok) throw new UpstreamStatusError(response.status, response)
    },
    async promptLanded(sessionID, marker) {
      const response = await callOpencode(
        `/api/session/${encodeURIComponent(sessionID)}/message?limit=20&order=desc`,
        { retry: false },
      )
      if (!response.ok) throw new UpstreamStatusError(response.status, response)
      const body = (await response.json()) as {
        data?: Array<{ type?: string; metadata?: Record<string, unknown> }>
      }
      return (body.data ?? []).some(
        (message) => message.type === "user" && message.metadata?.[GOAL_DELIVERY_MARKER_KEY] === marker,
      )
    },
    async writeInstruction(sessionID, key, value) {
      const response = await callOpencode(
        `/api/experimental/session/${encodeURIComponent(sessionID)}/instructions/entries/${encodeURIComponent(key)}`,
        { method: "PUT", body: { value }, retry: false },
      )
      if (!response.ok) throw new UpstreamStatusError(response.status, response)
    },
    async removeInstruction(sessionID, key) {
      const response = await callOpencode(
        `/api/experimental/session/${encodeURIComponent(sessionID)}/instructions/entries/${encodeURIComponent(key)}`,
        { method: "DELETE", retry: false },
      )
      if (!response.ok && response.status !== 404) throw new UpstreamStatusError(response.status, response)
    },
    async switchModel(sessionID, model) {
      const body: { id: string; providerID: string; variant?: string } = { id: model.id, providerID: model.providerID }
      if (model.variant) body.variant = model.variant
      const response = await callOpencode(`/api/session/${encodeURIComponent(sessionID)}/model`, {
        method: "POST",
        body: { model: body },
      })
      if (!response.ok) throw new UpstreamStatusError(response.status, response)
    },
    async switchAgent(sessionID, agent) {
      const response = await callOpencode(`/api/session/${encodeURIComponent(sessionID)}/agent`, {
        method: "POST",
        body: { agent },
      })
      if (!response.ok) throw new UpstreamStatusError(response.status, response)
    },
    async interrupt(sessionID) {
      const response = await callOpencode(`/api/session/${encodeURIComponent(sessionID)}/interrupt`, {
        method: "POST",
      })
      if (!response.ok) throw new UpstreamStatusError(response.status, response)
    },
    async removeSession(sessionID) {
      const response = await callOpencode(`/api/session/${encodeURIComponent(sessionID)}`, {
        method: "DELETE",
        retry: false,
      })
      if (!response.ok && response.status !== 404) throw new UpstreamStatusError(response.status, response)
    },
    async lastAssistant(sessionID) {
      const response = await callOpencode(
        `/api/session/${encodeURIComponent(sessionID)}/message?limit=10&order=desc`,
        { retry: false },
      )
      if (response.status === 404) return null
      if (!response.ok) throw new UpstreamStatusError(response.status, response)
      const body = (await response.json()) as { data?: Array<{ id?: string; type?: string; content?: unknown }> }
      for (const message of body.data ?? []) {
        if (message.type !== "assistant" || !message.id) continue
        return { id: message.id, text: assistantMessageText(message) }
      }
      return null
    },
    async activeSessions() {
      const response = await callOpencode("/api/session/active", { retry: false })
      if (!response.ok) throw new UpstreamStatusError(response.status, response)
      const body = (await response.json()) as { data?: Record<string, unknown> }
      return Object.keys(body.data ?? {})
    },
    async models() {
      const response = await callOpencode("/api/model", { retry: false })
      if (!response.ok) throw new UpstreamStatusError(response.status, response)
      const body = (await response.json()) as { data?: Array<{ id?: string; providerID?: string }> }
      return (body.data ?? [])
        .filter((model) => Boolean(model.id && model.providerID))
        .map((model) => `${model.providerID}/${model.id}`)
    },
  }

  const goals: GoalManager =
    deps.goals ??
    createGoalManager({
      store: deps.store,
      opencode: goalOpencode,
      emit: (event) => deps.hub.emit(event),
    })
  deps.hub.subscribe((event) => goals.handleEvent(event))
  // In-flight runs never auto-resume after a restart: they surface as paused
  // with a resumable reason instead (docs/past-mistakes.md).
  goals.reconcileOnBoot()

  /**
   * Drops every MasterHand-managed resource tied to a session id: its quick
   * tunnel (a leaked one would stay publicly exposed), its dev-server PTY, its
   * reserved port and its worktree record/branch. Used when a session is
   * deleted by a client and, critically, when opencode reports it deleted
   * outside MasterHand (TUI/API), where no route runs.
   */
  async function releaseSession(sessionID: string): Promise<void> {
    void goals.forget(sessionID).catch(() => {})
    preview.forget(sessionID)
    runs.forget(sessionID)
    const record = deps.store.getIsolatedSession(sessionID)
    if (!record) return
    const workspace = deps.store.getWorkspace(record.workspaceID)
    if (workspace) {
      try {
        await worktrees.remove(workspace.path, record.path, record.branch)
      } catch {
        // best effort: never block dropping the record
      }
    }
    deps.store.removeIsolatedSession(sessionID)
  }

  // Clients poll the workspace session list every 10 s and each poll walks the
  // v2 cursor pages per directory (base + worktrees). A short-lived per-directory
  // cache absorbs concurrent devices and repeated polls; session mutations clear
  // it, and opencode's own lifecycle events clear it too so out-of-band sessions
  // (e.g. subagent children) show up immediately.
  const sessionsCacheMs = deps.sessionsCacheMs ?? 5_000
  const sessionsCache = new Map<string, { at: number; sessions: OpencodeSession[] }>()
  // Advisory-write failures are logged once per app instance (issue #86).
  let warnedAuditFailure = false
  // Audit: correlate a tool call with its failure, because the failure event
  // carries the permission error but not the command it tried to run.
  const toolCommands = new Map<string, { sessionID: string; command: string }>()
  deps.hub.subscribe((event) => {
    const type = (event as { type?: unknown } | null)?.type
    if (type === "session.created" || type === "session.deleted") invalidateSessionsCache()

    const data = (event as { data?: Record<string, unknown> } | null)?.data
    if (type === "session.deleted") {
      // Out-of-band deletion: nothing else would stop the tunnel/PTY or drop
      // the worktree record (issue #85).
      const sessionID = typeof data?.sessionID === "string" ? data.sessionID : ""
      if (sessionID) {
        void releaseSession(sessionID).catch((error) => {
          console.warn(`[masterhand] could not release session ${sessionID}:`, error)
        })
      }
      return
    }
    if (!data) return

    if (type === "session.tool.called") {
      const id = typeof data.id === "string" ? data.id : ""
      const sessionID = typeof data.sessionID === "string" ? data.sessionID : ""
      const input = data.input as { command?: unknown } | undefined
      if (id && sessionID && typeof input?.command === "string") {
        toolCommands.set(id, { sessionID, command: input.command })
        // Bounded: a long-lived process must not grow this forever.
        if (toolCommands.size > 200) {
          const oldest = toolCommands.keys().next().value
          if (oldest) toolCommands.delete(oldest)
        }
      }
      return
    }

    if (type === "session.tool.success") {
      const id = typeof data.id === "string" ? data.id : ""
      if (id) toolCommands.delete(id)
      return
    }

    if (type === "session.tool.failed") {
      const id = typeof data.id === "string" ? data.id : ""
      const pending = toolCommands.get(id)
      if (id) toolCommands.delete(id)
      const error = data.error as { message?: unknown; type?: unknown } | undefined
      const message = typeof error?.message === "string" ? error.message : ""
      const denied = error?.type === "permission.rejected" || /permission denied/i.test(message)
      if (!denied) return
      const input = data.input as { command?: unknown } | undefined
      // Audit is advisory: a failed write (full/read-only disk) must not kill
      // the event subscription (issue #86). Log the first failure once.
      try {
        deps.store.recordAudit({
          at: Date.now(),
          sessionID: pending?.sessionID ?? (typeof data.sessionID === "string" ? data.sessionID : null),
          workspaceID: null,
          kind: "permission_denied",
          command: pending?.command ?? (typeof input?.command === "string" ? input.command : null),
          reason: message || "Permission denied",
          source: "opencode",
        })
      } catch (error) {
        if (!warnedAuditFailure) {
          warnedAuditFailure = true
          console.warn("[masterhand] audit write failed (continuing):", error)
        }
      }
    }
  })

  /**
   * Bounded fetch to opencode: a stalled upstream (TCP accepted, no response)
   * must never hold the route forever. The timeout is normalized so routes can
   * answer 504 `opencode_timeout` instead of an opaque 500.
   */
  async function fetchOpencode(target: URL, init: RequestInit = {}): Promise<Response> {
    try {
      return await fetchImpl(target, { ...init, signal: AbortSignal.timeout(config.opencodeTimeoutMs) })
    } catch (error) {
      if ((error as { name?: string } | null)?.name === "TimeoutError") throw new OpencodeTimeoutError()
      throw error
    }
  }

  /** 504 for a missed deadline, 502 for any other upstream failure. */
  function opencodeFailure(c: Context, error: unknown, fallback = "opencode_unreachable"): Response {
    if (error instanceof OpencodeTimeoutError) return c.json({ error: "opencode_timeout" }, 504)
    return c.json({ error: fallback }, 502)
  }

  /** Goal routes answer typed codes; unexpected failures stay 502. */
  function goalFailure(c: Context, error: unknown): Response {
    if (error instanceof GoalError) return c.json({ error: error.code, detail: error.message }, error.status)
    if (error instanceof OpencodeTimeoutError) return c.json({ error: "opencode_timeout" }, 504)
    return c.json({ error: "goal_failed", detail: error instanceof Error ? error.message : undefined }, 502)
  }

  /**
   * Calls opencode directly (injecting basic auth). The `directory` override
   * travels as a query parameter exactly like the clients' proxy calls.
   *
   * Idempotent methods inherit bounded retries (transient statuses and fast
   * network failures) from the shared retry engine; POST stays single-shot
   * because replaying it could duplicate state (callers that can reconcile,
   * like Goal Mode, wrap it themselves).
   */
  function callOpencode(
    path: string,
    options: {
      method?: string
      directory?: string | null
      location?: string | null
      body?: unknown
      /** `false` opts out of the default idempotent-method retries (the caller owns the policy). */
      retry?: boolean
    } = {},
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
    const request = (): Promise<Response> =>
      fetchOpencode(target, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      })

    if (options.retry === false || !IDEMPOTENT_OPENCODE_METHODS.has(method)) return request()

    return withRetry(
      async () => {
        const response = await request()
        // A transient status is retried inside the engine; definitive 4xx and
        // success responses pass through to the caller unchanged.
        if (isTransientStatus(response.status)) throw new UpstreamStatusError(response.status, response)
        return response
      },
      {
        attempts: OPENCODE_RETRY_ATTEMPTS,
        baseDelayMs: OPENCODE_RETRY_BASE_MS,
        onRetry: (info) => {
          console.warn(
            `[opencode] ${method} ${path} failed (${info.error instanceof Error ? info.error.message : "unknown"}) — retrying in ${info.delayMs}ms`,
          )
        },
      },
    ).catch((error: unknown) => {
      if (error instanceof RetryExhaustedError) {
        // Surface the last upstream response (routes keep answering their
        // existing status codes); network failures keep their original error.
        if (error.lastError instanceof UpstreamStatusError && error.lastError.response) return error.lastError.response
        throw error.lastError
      }
      throw error
    })
  }

  /**
   * Connects a stored key to a freshly written custom provider. opencode only
   * registers the integration after it reloads the config, and `connect/key`
   * answers `404` until then, so a bounded retry is safe (a 404 created
   * nothing). A failure never fails the create: the provider stays and the card
   * offers Connect.
   */
  async function connectCustomProviderKey(id: string, key: string, label?: string): Promise<boolean> {
    const path = `/api/integration/${encodeURIComponent(id)}/connect/key`
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        const response = await callOpencode(path, {
          method: "POST",
          body: { key, ...(label ? { label } : {}) },
        })
        if (response.ok) return true
        if (response.status !== 404) return false
      } catch {
        return false
      }
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
    return false
  }

  /** Removes every stored credential of a custom provider (best effort). */
  async function removeCustomProviderCredentials(id: string): Promise<void> {
    try {
      const response = await callOpencode(`/api/integration/${encodeURIComponent(id)}`)
      if (!response.ok) return
      const body = (await response.json()) as {
        data?: { connections?: Array<{ type?: string; id?: string }> }
      }
      for (const connection of body.data?.connections ?? []) {
        if (connection.type === "credential" && connection.id) {
          await callOpencode(`/api/credential/${encodeURIComponent(connection.id)}`, { method: "DELETE" }).catch(
            () => undefined,
          )
        }
      }
    } catch {
      // opencode unreachable: removing the config entry is enough
    }
  }

  /** Lists every session in a directory, following opencode's v2 cursor pagination. */
  async function fetchSessionsInDirectory(directory: string): Promise<OpencodeSession[]> {
    const sessions: OpencodeSession[] = []
    let cursor: string | undefined
    for (let page = 0; page < 50; page += 1) {
      const target = new URL("/api/session", config.opencodeUrl)
      target.searchParams.set("directory", directory)
      target.searchParams.set("limit", "200")
      if (cursor) target.searchParams.set("cursor", cursor)
      const response = await fetchOpencode(target, {
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
    return sessions
  }

  async function sessionsInDirectory(directory: string): Promise<OpencodeSession[]> {
    const cached = sessionsCache.get(directory)
    if (cached && Date.now() - cached.at < sessionsCacheMs) return cached.sessions

    const sessions = await fetchSessionsInDirectory(directory)
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
   * Tells the agent to declare the dev-server command in `.masterhand/run.json`
   * instead of starting or killing servers itself; MasterHand's run control
   * starts and stops that exact process.
   */
  async function ensureRunInstruction(sessionID: string): Promise<void> {
    await writeSessionInstruction(sessionID, "masterhand.run", runSystemPrompt())
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
    await ensureRunInstruction(sessionID)
    await ensureProcessInstruction(sessionID)
    await ensurePermissionGuards(sessionID)
  }

  /**
   * Makes `path` its own git root so opencode resolves its project root (and
   * `/init`) to the workspace instead of an ancestor repo such as MasterHand.
   * Best effort at session creation: the instruction and permission guards still
   * apply if git is unavailable.
   */
  async function ensureWorkspaceRepo(path: string): Promise<void> {
    try {
      await worktrees.ensureRepo(path)
    } catch (error) {
      console.warn(
        `[workspace] could not initialize a git repo at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  app.use("/api/*", requireSameOrigin(config))

  app.get("/api/health", (c) => {
    // Readiness includes storage: an unreachable/corrupt database means the
    // instance cannot serve, and Docker surfaces it as unhealthy.
    if (!deps.store.ping()) return c.json({ ok: false, error: "storage_unavailable" }, 503)
    return c.json({ ok: true })
  })

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
    // One row per device name: a login from a known device refreshes its
    // record instead of accumulating duplicates (issue #87c).
    const existing = deps.store.list().find((record) => record.name === name)
    const device = existing
      ? { ...existing, lastUsedAt: now }
      : { id: randomUUID(), name, createdAt: now, lastUsedAt: now }
    if (existing) deps.store.touch(existing.id, now)
    else deps.store.create(device)
    const token = createDeviceToken(config.sessionSecret, device.id, config.sessionTtlHours * 3600)
    return c.json({ token, device }, 201)
  })

  app.post("/api/logout", (c) => {
    clearSessionCookie(c, config)
    return c.json({ ok: true })
  })

  app.use("/api/oc/*", requireAuth(config, deps.store))
  app.all("/api/oc/*", createOpencodeProxy(config, fetchImpl, undefined, deps.proxyRetry))

  const api = new Hono()
  api.use("*", requireAuth(config, deps.store))

  api.get("/status", async (c) => {
    const previewStatus = {
      enabled: config.previewEnabled,
      available: config.previewEnabled && (await preview.available()),
      portRange: config.previewPortRange,
    }
    // Free space on the data volume: a full disk takes SQLite and git down
    // with it, so clients surface a warning before that happens (issue #78).
    const freeBytes = (deps.diskFreeBytes ?? defaultDiskFreeBytes)(config.dataDir)
    const storage = {
      ok: deps.store.ping(),
      freeBytes,
      low: freeBytes !== null && freeBytes < config.diskLowWatermarkMb * 1024 * 1024,
    }
    try {
      const health = await fetchImpl(new URL("/api/info", config.opencodeUrl), {
        headers: config.opencodeAuth ? { authorization: config.opencodeAuth } : {},
        signal: AbortSignal.timeout(3000),
      })
      if (!health.ok) {
        const error = health.status === 401 || health.status === 403 ? "unauthorized" : "unreachable"
        return c.json({ ok: true, opencode: { healthy: false, error }, preview: previewStatus, storage })
      }
      const data = (await health.json()) as { version?: string }
      return c.json({
        ok: true,
        opencode: { healthy: true, version: data.version },
        preview: previewStatus,
        storage,
      })
    } catch {
      return c.json({
        ok: true,
        opencode: { healthy: false, error: "unreachable" },
        preview: previewStatus,
        storage,
      })
    }
  })

  api.get("/events", (c) => {
    c.header("cache-control", "no-cache")
    c.header("x-accel-buffering", "no")
    const maxQueue = deps.sseQueueMax ?? MAX_SSE_QUEUE
    return streamSSE(c, async (stream) => {
      interface SseFrame {
        event?: string
        data: string
      }

      let closed = false
      let draining = false
      const queue: SseFrame[] = []
      let unsubscribe = (): void => {}

      const teardown = (): void => {
        if (closed) return
        closed = true
        unsubscribe()
      }

      // One writer per client: each frame awaits the stream, so a slow client
      // applies natural backpressure to the queue instead of forking an
      // unbounded promise chain.
      const drain = async (): Promise<void> => {
        if (draining) return
        draining = true
        try {
          while (!closed) {
            const frame = queue.shift()
            if (!frame) break
            await stream.writeSSE(frame)
          }
        } catch {
          // the client disconnected
        } finally {
          draining = false
          if (!closed && queue.length > 0) void drain()
        }
      }

      const enqueue = (frame: SseFrame): void => {
        if (closed) return
        if (queue.length >= maxQueue) {
          // Zero-window/slow client: drop it instead of buffering every event in
          // memory. It reconnects (SSE has no replay) and reconciles state.
          teardown()
          stream.abort()
          return
        }
        queue.push(frame)
        void drain()
      }

      unsubscribe = deps.hub.subscribe((event) => {
        enqueue({ data: JSON.stringify(event) })
      })
      stream.onAbort(teardown)

      try {
        enqueue({ event: "hello", data: JSON.stringify({ connected: deps.hub.connected }) })
        while (!closed) {
          await stream.sleep(KEEPALIVE_MS)
          if (closed) break
          enqueue({ event: "ping", data: "{}" })
        }
      } catch {
        // client disconnected
      } finally {
        teardown()
      }
    })
  })

  /** Blocked actions (opencode permission denials) for diagnosis. */
  api.get("/audit", (c) => {
    const requested = Number.parseInt(c.req.query("limit") ?? "", 10)
    const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 500) : 100
    return c.json({ events: deps.store.listAudit(limit) })
  })

  api.delete("/audit", (c) => {
    deps.store.clearAudit()
    return c.json({ ok: true })
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
    } catch (error) {
      return opencodeFailure(c, error)
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

  /**
   * Custom OpenAI-compatible providers. opencode has no API to
   * register a provider, so MasterHand owns a dedicated config file; the API
   * key still goes through opencode's `connect/key` endpoint from the client.
   */
  function customProvidersFailure(c: Context, error: unknown) {
    if (error instanceof CustomProvidersFileError) {
      return c.json({ error: "custom_providers_corrupt" }, 500)
    }
    const code = (error as { code?: string } | null)?.code
    console.error("[masterhand] custom providers file failure:", error)
    if (code === "EACCES" || code === "EROFS" || code === "ENOSPC") {
      return c.json({ error: "custom_providers_unwritable" }, 503)
    }
    return c.json({ error: "custom_providers_failed" }, 500)
  }

  api.get("/providers/custom", async (c) => {
    try {
      return c.json({ providers: await providers.list() })
    } catch (error) {
      return customProvidersFailure(c, error)
    }
  })

  /**
   * Discovers a provider's models from its OpenAI-compatible `/models`
   * endpoint, so the add dialog fills the list instead of demanding hand-typed
   * ids. Read-only: nothing is stored and the transient key is only forwarded
   * upstream. The URL is the same one opencode itself will call; self-hosted
   * installs commonly point it at a LAN address, so no host allowlist applies.
   */
  api.post("/providers/custom/models", async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "invalid_body" }, 400)
    }
    const result = validateDiscoverInput(body)
    if (!result.ok) return c.json({ error: result.error }, 400)

    const discovered = await fetchProviderModels(result.value, { fetchImpl })
    if (!discovered.ok) {
      return c.json({ error: discovered.error }, discovered.error === "provider_timeout" ? 504 : 502)
    }
    return c.json({ models: discovered.models })
  })

  /** Upsert by id: retrying the same body is safe (rule 4 in past-mistakes). */
  api.post("/providers/custom", async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "invalid_body" }, 400)
    }
    const result = validateCustomProvider(body)
    if (!result.ok) return c.json({ error: result.error }, 400)

    // `key`/`label` are consumed here, never part of the stored provider.
    const record = body as Record<string, unknown>
    const key = typeof record.key === "string" ? record.key.trim() : ""
    const label = typeof record.label === "string" ? record.label.trim() : ""

    let provider
    try {
      provider = await providers.upsert(result.provider)
    } catch (error) {
      return customProvidersFailure(c, error)
    }
    // The config write is the mutation; connecting the key is best effort.
    const connected = key ? await connectCustomProviderKey(provider.id, key, label || undefined) : false
    return c.json({ provider, connected }, 201)
  })

  api.delete("/providers/custom/:id", async (c) => {
    const id = c.req.param("id")
    await removeCustomProviderCredentials(id)
    try {
      await providers.remove(id)
      return c.json({ ok: true })
    } catch (error) {
      return customProvidersFailure(c, error)
    }
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

    await createDir(path)
    await ensureWorkspaceRepo(path)
    const workspace = { id: randomUUID(), name: result.slug, path, createdAt: Date.now() }
    try {
      deps.store.createWorkspace(workspace)
    } catch (error) {
      // Two concurrent creates can pass the pre-check; the UNIQUE(path)
      // violation is still a conflict, not a 500 (issue #87).
      if (isStorageConflict(error)) return c.json({ error: "already_exists" }, 409)
      throw error
    }
    return c.json({ workspace }, 201)
  })

  api.delete("/workspaces/:id", async (c) => {
    const workspace = deps.store.getWorkspace(c.req.param("id"))
    if (!workspace) return c.json({ error: "not_found" }, 404)

    // Isolated worktrees live outside the workspace folder, so they always
    // have to be cleaned up explicitly.
    for (const record of deps.store.listIsolatedSessions(workspace.id)) {
      try {
        await worktrees.remove(workspace.path, record.path, record.branch)
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
      await removeDir(workspace.path)
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

  /**
   * Branch/history access over git (opencode's VCS API is read-only). A timeout
   * means the git command may still have applied, so it is answered `504
   * git_timeout` — clients surface it as "unknown" and never auto-retry a
   * non-idempotent checkout/create (docs/past-mistakes.md rules 4 and 15).
   */
  function gitFailure(c: Context, error: unknown) {
    const detail = error instanceof Error ? error.message : "unknown"
    const status = detail.includes("timed out") ? 504 : 502
    return c.json({ error: status === 504 ? "git_timeout" : "git_failed", detail }, status)
  }

  /**
   * A branch switch under a running turn would move the files beneath it, and
   * a branch operation on a dirty tree can lose the user's work: refuse both.
   * The busy check fails closed — when it cannot confirm, the mutation is not
   * attempted.
   */
  async function branchGuard(
    c: Context,
    workspacePath: string,
    options: { requireClean: boolean },
  ): Promise<Response | null> {
    try {
      // Fresh list: a session created moments ago (not yet in the 5 s cache)
      // may already be running, and a branch switch under it would corrupt it.
      const sessions = await fetchSessionsInDirectory(workspacePath)
      if (sessions.length > 0) {
        const response = await callOpencode("/api/session/active")
        if (!response.ok) throw new Error(`opencode ${response.status}`)
        const body = (await response.json()) as { data?: Record<string, unknown> }
        const active = new Set(Object.keys(body.data ?? {}))
        if (sessions.some((session) => active.has(session.id))) {
          return c.json({ error: "workspace_busy" }, 409)
        }
      }
    } catch (error) {
      return c.json(
        { error: "busy_check_failed", detail: error instanceof Error ? error.message : "unknown" },
        502,
      )
    }
    if (options.requireClean) {
      try {
        if (await worktrees.isDirty(workspacePath)) {
          return c.json({ error: "dirty_worktree" }, 409)
        }
      } catch (error) {
        return gitFailure(c, error)
      }
    }
    return null
  }

  api.get("/workspaces/:id/branches", async (c) => {
    const workspace = deps.store.getWorkspace(c.req.param("id"))
    if (!workspace) return c.json({ error: "not_found" }, 404)
    try {
      return c.json(await worktrees.branches(workspace.path))
    } catch (error) {
      return gitFailure(c, error)
    }
  })

  api.post("/workspaces/:id/branches", async (c) => {
    const workspace = deps.store.getWorkspace(c.req.param("id"))
    if (!workspace) return c.json({ error: "not_found" }, 404)

    let body: { name?: unknown; base?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "bad_request" }, 400)
    }
    if (typeof body.name !== "string" || !isValidBranchName(body.name)) {
      return c.json({ error: "invalid_branch_name" }, 400)
    }
    if (body.base !== undefined && (typeof body.base !== "string" || !isValidBranchName(body.base))) {
      return c.json({ error: "invalid_branch_name" }, 400)
    }

    // Creating from a dirty tree is safe (the changes travel with you), but a
    // running turn must never have its files swapped underneath it.
    const guard = await branchGuard(c, workspace.path, { requireClean: false })
    if (guard) return guard

    try {
      const info = await worktrees.branches(workspace.path)
      if (info.branches.includes(body.name)) return c.json({ error: "branch_exists" }, 409)
      if (body.base && !info.branches.includes(body.base)) {
        return c.json({ error: "branch_not_found" }, 404)
      }
      await worktrees.createBranch(workspace.path, body.name, body.base)
      invalidateSessionsCache()
      return c.json(await worktrees.branches(workspace.path), 201)
    } catch (error) {
      return gitFailure(c, error)
    }
  })

  api.post("/workspaces/:id/checkout", async (c) => {
    const workspace = deps.store.getWorkspace(c.req.param("id"))
    if (!workspace) return c.json({ error: "not_found" }, 404)

    let body: { name?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "bad_request" }, 400)
    }
    if (typeof body.name !== "string" || !isValidBranchName(body.name)) {
      return c.json({ error: "invalid_branch_name" }, 400)
    }

    // Switching branches is destructive for uncommitted work: dirty trees are
    // rejected before any git mutation runs.
    const guard = await branchGuard(c, workspace.path, { requireClean: true })
    if (guard) return guard

    try {
      const info = await worktrees.branches(workspace.path)
      if (info.current === body.name) return c.json(info)
      if (!info.branches.includes(body.name)) return c.json({ error: "branch_not_found" }, 404)
      await worktrees.checkout(workspace.path, body.name)
      return c.json(await worktrees.branches(workspace.path))
    } catch (error) {
      return gitFailure(c, error)
    }
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
    } catch (error) {
      return opencodeFailure(c, error)
    }

    // Goal Mode's internal critic/judge sessions are never listed: they are
    // annotated with `goalRole` so clients keep them out of the sidebar while
    // still reaching them from the main session's review cards. The run store
    // wins over the metadata marker because opencode may return sessions
    // created before the stable role key existed.
    const goalRoles = new Map<string, GoalRole>()
    for (const run of deps.store.listGoalRuns()) {
      if (run.criticSessionID) goalRoles.set(run.criticSessionID, "critic")
      if (run.judgeSessionID) goalRoles.set(run.judgeSessionID, "judge")
    }

    const byID = new Map(records.map((record) => [record.sessionID, record]))
    type MergedSession = OpencodeSession & {
      isolation?: ReturnType<typeof isolationOf>
      goalRole?: GoalRole
    }
    const merged = new Map<string, MergedSession>()
    for (const session of lists.flat()) {
      const goalRole = goalRoles.get(session.id) ?? goalRoleFromMetadata(session.metadata)
      const annotated: MergedSession = goalRole ? { ...session, goalRole } : session
      // Child (subagent) sessions inherit their parent's worktree annotation.
      const record = byID.get(session.id) ?? (session.parentID ? byID.get(session.parentID) : undefined)
      merged.set(session.id, record ? { ...annotated, isolation: isolationOf(record) } : annotated)
    }
    return c.json({ sessions: [...merged.values()] })
  })

  api.post("/workspaces/:id/sessions", async (c) => {
    const workspace = deps.store.getWorkspace(c.req.param("id"))
    if (!workspace) return c.json({ error: "not_found" }, 404)

    let body: { isolated?: unknown; marker?: unknown } = {}
    try {
      body = await c.req.json()
    } catch {
      // an empty body means a standard (non-isolated) session
    }
    const marker = normalizeCreateMarker(body.marker)

    if (body.isolated !== true) {
      await ensureWorkspaceRepo(workspace.path)
      let response: Response
      try {
        response = await callOpencode("/api/session", {
          method: "POST",
          body: sessionCreateBody(workspace.path, marker),
        })
      } catch (error) {
        return opencodeFailure(c, error)
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
      await worktrees.ensureRepo(workspace.path)
      baseRef = await worktrees.headBranch(workspace.path)
      await worktrees.create(workspace.path, path, branch, baseRef)

      const response = await callOpencode("/api/session", {
        method: "POST",
        body: sessionCreateBody(path, marker),
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
        await worktrees.remove(workspace.path, path, branch)
      } catch {
        // the worktree may not exist if creation failed early
      }
      // A deadline means the session may still have been created upstream; the
      // client reconciles against the list (see #66) instead of blind retrying.
      if (error instanceof OpencodeTimeoutError) return c.json({ error: "opencode_timeout" }, 504)
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

    let response: Response
    try {
      response = await callOpencode(`/api/session/${encodeURIComponent(sessionID)}`, { method: "DELETE" })
    } catch (error) {
      return opencodeFailure(c, error)
    }
    if (!response.ok && response.status !== 404) return c.json({ error: "opencode_error" }, 502)
    invalidateSessionsCache()

    await releaseSession(sessionID)
    return c.json({ ok: true })
  })

  api.post("/isolated-sessions/:sessionID/finish", async (c) => {
    const record = deps.store.getIsolatedSession(c.req.param("sessionID"))
    if (!record) return c.json({ error: "not_found" }, 404)
    const workspace = deps.store.getWorkspace(record.workspaceID)
    if (!workspace) return c.json({ error: "not_found" }, 404)

    let committed = false
    try {
      committed = await worktrees.commitAll(record.path, `MasterHand session ${record.sessionID}`)
    } catch (error) {
      return c.json(
        { error: "commit_failed", detail: error instanceof Error ? error.message : "unknown" },
        500,
      )
    }

    let pushed = false
    let pushError: string | null = null
    let prUrl = record.prUrl
    const remoteUrl = await worktrees.remoteUrl(record.path)
    if (remoteUrl) {
      try {
        await worktrees.push(record.path, record.branch)
        pushed = true
      } catch (error) {
        pushError = error instanceof Error ? error.message : "push_failed"
      }
      if (pushed) {
        // Prefer the provider CLI when authenticated; otherwise hand back a
        // ready-to-open compare URL. A retry after a lost response must never
        // create a second PR: the recorded URL wins.
        prUrl =
          record.prUrl ??
          (await worktrees.pullRequest(record.path, remoteUrl, record.branch, record.baseRef)) ??
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

  api.get("/workspaces/:id/run", (c) => {
    const workspace = deps.store.getWorkspace(c.req.param("id"))
    if (!workspace) return c.json({ error: "not_found" }, 404)
    return c.json({ run: deps.store.getWorkspaceRun(workspace.id) })
  })

  api.put("/workspaces/:id/run", async (c) => {
    const workspace = deps.store.getWorkspace(c.req.param("id"))
    if (!workspace) return c.json({ error: "not_found" }, 404)

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "invalid_config" }, 400)
    }
    const result = validateRunConfig(body, workspace.path)
    if (!result.ok) return c.json({ error: result.error }, 400)

    const record: WorkspaceRunRecord = {
      workspaceID: workspace.id,
      command: result.config.command,
      args: result.config.args,
      cwd: result.config.cwd,
      source: "user",
      updatedAt: Date.now(),
    }
    deps.store.saveWorkspaceRun(record)
    return c.json({ run: record })
  })

  api.post("/workspaces/:id/run/detect", (c) => {
    const workspace = deps.store.getWorkspace(c.req.param("id"))
    if (!workspace) return c.json({ error: "not_found" }, 404)
    const detected = readRunFile(workspace.path)
    if (!detected) return c.json({ error: "run_not_found" }, 404)
    if ("error" in detected) return c.json({ error: detected.error }, 400)
    return c.json({ run: { ...detected.config, source: "agent" } })
  })

  /**
   * Resolves the session's directory and the workspace it belongs to. The
   * workspace id travels as a query param because a session id alone does not
   * tell the BFF which workspace (and worktree) it belongs to.
   */
  function sessionRunContext(c: Context): { workspaceID: string; sessionID: string; directory: string } | null {
    const workspace = deps.store.getWorkspace(c.req.query("workspace") ?? "")
    if (!workspace) return null
    const sessionID = c.req.param("sessionID") ?? ""
    const record = sessionID ? deps.store.getIsolatedSession(sessionID) : null
    const directory = record && record.workspaceID === workspace.id ? record.path : workspace.path
    return { workspaceID: workspace.id, sessionID, directory }
  }

  api.get("/sessions/:sessionID/run", async (c) => {
    const context = sessionRunContext(c)
    if (!context) return c.json({ error: "workspace_required" }, 400)
    const config = deps.store.getWorkspaceRun(context.workspaceID)
    try {
      const port = preview.portFor(context.sessionID)
      const run = await runs.status(context.sessionID, context.directory, port)
      return c.json({
        run: {
          ...run,
          command: run.command ?? config?.command ?? null,
          args: run.args.length > 0 ? run.args : (config?.args ?? []),
        },
      })
    } catch (error) {
      if (error instanceof PreviewError) return c.json({ error: error.code }, 503)
      return c.json({ error: "opencode_unreachable" }, 502)
    }
  })

  api.post("/sessions/:sessionID/run", async (c) => {
    const context = sessionRunContext(c)
    if (!context) return c.json({ error: "workspace_required" }, 400)
    const config = deps.store.getWorkspaceRun(context.workspaceID)
    if (!config) return c.json({ error: "run_not_configured" }, 404)
    try {
      const port = preview.portFor(context.sessionID)
      return c.json({ run: await runs.start(context.sessionID, context.directory, config, port) })
    } catch (error) {
      const code = error instanceof RunError ? error.code : error instanceof PreviewError ? error.code : "run_failed"
      const status = code === "run_spawn_failed" ? 502 : code === "preview_ports_exhausted" ? 503 : 500
      return c.json({ error: code, detail: error instanceof Error ? error.message : undefined }, status)
    }
  })

  api.delete("/sessions/:sessionID/run", async (c) => {
    const context = sessionRunContext(c)
    if (!context) return c.json({ error: "workspace_required" }, 400)
    await runs.stop(context.sessionID, context.directory).catch(() => {})
    return c.json({ ok: true })
  })

  api.get("/sessions/:sessionID/preview", (c) => {
    if (!config.previewEnabled) return c.json({ error: "preview_disabled" }, 404)
    return c.json({ preview: preview.status(c.req.param("sessionID")) })
  })

  api.post("/sessions/:sessionID/preview", async (c) => {
    if (!config.previewEnabled) return c.json({ error: "preview_disabled" }, 404)
    if (!(await preview.available())) return c.json({ error: "preview_unavailable" }, 503)
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

  /** Goal Mode: start a run, read its state, pause/resume/cancel it. */
  api.get("/sessions/:sessionID/goal", (c) => {
    return c.json({ goal: goals.status(c.req.param("sessionID")) })
  })

  api.post("/sessions/:sessionID/goal", async (c) => {
    let body: { goal?: unknown; model?: unknown; agent?: unknown } = {}
    try {
      body = (await c.req.json()) as typeof body
    } catch {
      // an empty body fails goal validation below
    }
    const goal = typeof body.goal === "string" ? body.goal : ""
    const agent = typeof body.agent === "string" && body.agent.trim() ? body.agent.trim() : null
    try {
      return c.json(
        { goal: await goals.start({ sessionID: c.req.param("sessionID"), goal, model: body.model ?? null, agent }) },
        201,
      )
    } catch (error) {
      return goalFailure(c, error)
    }
  })

  api.post("/sessions/:sessionID/goal/pause", async (c) => {
    try {
      return c.json({ goal: await goals.pause(c.req.param("sessionID")) })
    } catch (error) {
      return goalFailure(c, error)
    }
  })

  api.post("/sessions/:sessionID/goal/resume", async (c) => {
    try {
      return c.json({ goal: await goals.resume(c.req.param("sessionID")) })
    } catch (error) {
      return goalFailure(c, error)
    }
  })

  api.post("/sessions/:sessionID/goal/cancel", async (c) => {
    try {
      return c.json({ goal: await goals.cancel(c.req.param("sessionID")) })
    } catch (error) {
      return goalFailure(c, error)
    }
  })

  /** Goal review settings (critic/judge models, round budget). */
  api.get("/goal/settings", (c) => c.json({ settings: goals.getSettings() }))

  api.put("/goal/settings", async (c) => {
    let body: { maxRounds?: unknown; criticModel?: unknown; judgeModel?: unknown } = {}
    try {
      body = (await c.req.json()) as typeof body
    } catch {
      // an empty patch is valid: it returns the current settings
    }
    const patch: { maxRounds?: number; criticModel?: string | null; judgeModel?: string | null } = {}
    if (body.maxRounds !== undefined) {
      patch.maxRounds = typeof body.maxRounds === "number" ? body.maxRounds : Number.NaN
    }
    if (body.criticModel !== undefined) {
      patch.criticModel = body.criticModel === null ? null : typeof body.criticModel === "string" ? body.criticModel : ""
    }
    if (body.judgeModel !== undefined) {
      patch.judgeModel = body.judgeModel === null ? null : typeof body.judgeModel === "string" ? body.judgeModel : ""
    }
    try {
      return c.json({ settings: await goals.saveSettings(patch) })
    } catch (error) {
      return goalFailure(c, error)
    }
  })

  app.route("/api", api)

  return app
}

export { SESSION_COOKIE }
