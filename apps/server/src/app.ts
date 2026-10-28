import { randomUUID } from "node:crypto"
import { statfsSync } from "node:fs"
import { getConnInfo } from "@hono/node-server/conninfo"
import { Hono } from "hono"
import type { Context } from "hono"
import { bodyLimit } from "hono/body-limit"
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
  DEFAULT_WEBSEARCH_PROVIDER,
  createCustomProviderStore,
  fetchProviderModels,
  validateCustomProvider,
  validateDiscoverInput,
  validateWebsearchSelection,
  type CustomProviderStore,
  type WebsearchSelection,
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
import {
  createScheduler,
  nextScheduledRunAt,
  SCHEDULER_MARKER_KEY,
  SchedulerError,
  validateScheduleSpec,
  validateTaskInput,
  type SchedulerManager,
  type SchedulerOpencode,
  type SchedulerTaskPatch,
} from "./scheduler.js"
import type {
  DeviceRecord,
  IsolatedSessionRecord,
  ScheduleSpec,
  ScheduledTask,
  Store,
  WorkspaceRunRecord,
} from "./store.js"
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
  engineReadGuardRules,
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
  /** Overridable for tests: task scheduler (issue #147). */
  scheduler?: SchedulerManager
  /** Overridable for tests: proxy retry tuning (attempts/backoff/sleep). */
  proxyRetry?: ProxyRetryOptions
  /** Overridable for tests: whole-loop budget of the custom-provider key connect. */
  connectKeyBudgetMs?: number
  /** Overridable for tests: per-operation budget of finish (commit + push + PR). */
  finishBudgetMs?: number
  /** Overridable for tests: whole-request budget of workspace deletion. */
  workspaceDeleteBudgetMs?: number
  /** Overridable for tests: TTL of the per-directory session aggregation cache. */
  sessionsCacheMs?: number
  /** Overridable for tests: frames an SSE client may fall behind before it is dropped. */
  sseQueueMax?: number
  /** Overridable for tests: free bytes on the data volume, or null when unknown. */
  diskFreeBytes?: (path: string) => number | null
  /** Cap on proxied opencode request bodies (default 10 MiB). */
  proxyBodyLimitBytes?: number
}

/**
 * `createApp` exposes the managers it built (or received) so `index.ts` can
 * run the boot reconciliation and stop them on shutdown without widening the
 * return shape beyond Hono (tests inject managers like `goals`).
 */
export interface AppWithScheduler extends Hono {
  scheduler?: SchedulerManager
  goals?: GoalManager
}

const KEEPALIVE_MS = 25_000
const MAX_DEVICE_NAME_LENGTH = 64
/** A UUID fits comfortably; the cap only stops client-controlled bloat. */
const MAX_INSTALL_ID_LENGTH = 128
/** Login/device bodies are tiny JSON documents; anything larger is abusive. */
const AUTH_BODY_LIMIT_BYTES = 64 * 1024
/** Proxied prompts can be large, but must still be bounded. */
const DEFAULT_PROXY_BODY_LIMIT_BYTES = 10 * 1024 * 1024
/** Hashing more than this buys an attacker nothing and costs CPU. */
const MAX_PASSWORD_LENGTH = 1024
/** Frames a single SSE client may fall behind before it is dropped. */
const MAX_SSE_QUEUE = 1024

/** Methods safe to retry outright: replaying them cannot duplicate state. */
const IDEMPOTENT_OPENCODE_METHODS = new Set(["GET", "HEAD", "PUT", "PATCH", "DELETE"])
/** Internal opencode retries for idempotent calls (transient statuses/network). */
const OPENCODE_RETRY_ATTEMPTS = 4
const OPENCODE_RETRY_BASE_MS = 250
/**
 * Whole-loop deadline for connecting a custom provider key (issue #194): 10
 * attempts × the per-call upstream timeout could otherwise stack past 100 s
 * against the client's 30 s deadline. Expiry answers `connected: false`
 * (best effort); the provider write already landed.
 */
const CONNECT_KEY_BUDGET_MS = 8_000
/** Delay between key-connect attempts while opencode reloads the config. */
const CONNECT_KEY_RETRY_MS = 400
/**
 * Per-operation budget for finish (commit + push + PR, issue #204): each git
 * step can take up to the 60 s child deadline, so an unlucky run outlives the
 * client's 240 s `FINISH_TIMEOUT_MS`. Expiry aborts the in-flight children
 * and answers ambiguous `504 finish_timeout` — the client reconciles against
 * the isolated-session record and retries only after checking the branch.
 */
const FINISH_BUDGET_MS = 225_000
/**
 * Whole-request budget for workspace deletion (issue #204): child releases
 * are individually bounded, but their sum is not. Expiry aborts the in-flight
 * git/file work, lets the remaining releases continue in the background (the
 * row is already gone) and answers ambiguous `504 delete_timeout` — the
 * client reconciles by refetching the workspace list.
 */
const WORKSPACE_DELETE_BUDGET_MS = 30_000
/** Parallel worktree releases on workspace delete: faster without an unbounded git burst. */
const DELETE_RELEASE_CONCURRENCY = 4

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

/** The record persisted for a freshly created isolated session. */
function isolatedSessionRecord(
  sessionID: string,
  workspaceID: string,
  path: string,
  branch: string,
  baseRef: string,
): IsolatedSessionRecord {
  return {
    sessionID,
    workspaceID,
    path,
    branch,
    baseRef,
    pushed: false,
    prUrl: null,
    createdAt: Date.now(),
  }
}

/** Result of one coalesced finish operation (commit + push + PR). */
type FinishOutcome =
  | { ok: false; error: "not_found" }
  | { ok: false; error: "commit_failed"; detail: string }
  | { ok: false; error: "timed_out" }
  | {
      ok: true
      committed: boolean
      pushed: boolean
      prUrl: string | null
      branch: string
      path: string
      error: string | null
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

/**
 * Runs `task` over `items` with at most `limit` in flight (issue #204):
 * workspace deletion releases worktrees in parallel instead of one by one,
 * without fanning out to an unbounded burst of git children. Order of
 * completion is not guaranteed; a rejection rejects the whole pass.
 */
async function eachLimit<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const item = items[next] as T
      next += 1
      await task(item)
    }
  })
  await Promise.all(workers)
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
  const proxyBodyLimitBytes = Math.max(1, deps.proxyBodyLimitBytes ?? DEFAULT_PROXY_BODY_LIMIT_BYTES)
  const rejectOversizedBody = (c: Context): Response => c.json({ error: "payload_too_large" }, 413)
  const authBodyLimit = bodyLimit({ maxSize: AUTH_BODY_LIMIT_BYTES, onError: rejectOversizedBody })

  /**
   * Wrong credentials: count the failure, log it without the secret, and
   * answer 429 only once the window's budget is exhausted (issue #181).
   */
  const rejectPassword = (c: Context, ip: string): Response => {
    const now = Date.now()
    const blocked = loginLimiter.isBlocked(ip, now)
    if (!blocked) loginLimiter.recordFailure(ip, now)
    console.warn(`[masterhand] login failed from ${ip} at ${new Date(now).toISOString()}`)
    if (blocked) return c.json({ error: "too_many_attempts" }, 429)
    return c.json({ error: "invalid_password" }, 401)
  }
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
  const runs = deps.runs ?? createRunManager({ opencode: runOpencode, launcher: config.managedRunLauncher })
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

  /**
   * opencode adapter for the Scheduler (issue #147): mirrors `goalOpencode`
   * with the scheduler's own marker key. Creates and prompts carry
   * `masterhand.scheduler` metadata so a lost response is reconciled against
   * the persisted marker instead of a blind replay; the create lookup is
   * scoped by DIRECTORY because the pinned opencode drops `parentID`.
   */
  const schedulerOpencode: SchedulerOpencode = {
    async createSession(directory, marker, title) {
      const response = await callOpencode("/api/session", {
        method: "POST",
        body: { location: { directory }, title, metadata: { [SCHEDULER_MARKER_KEY]: marker } },
      })
      if (!response.ok) throw new UpstreamStatusError(response.status, response)
      const body = (await response.json()) as { data?: { id?: string } }
      const id = body.data?.id
      if (!id) throw new Error("opencode did not return a session id")
      invalidateSessionsCache()
      return { id }
    },
    async findSessionByMarker(directory, marker) {
      // The marker is unique per run and the just-created session is the
      // newest (desc order), so a single page wins — same page as goals.
      const response = await callOpencode(
        `/api/session?directory=${encodeURIComponent(directory)}&limit=200`,
        { retry: false },
      )
      if (!response.ok) throw new UpstreamStatusError(response.status, response)
      const body = (await response.json()) as {
        data?: Array<{ id?: string; metadata?: Record<string, unknown> }>
      }
      const found = (body.data ?? []).find((session) => session.metadata?.[SCHEDULER_MARKER_KEY] === marker)
      return found?.id ? { id: found.id } : null
    },
    async prompt(sessionID, text, marker) {
      const response = await callOpencode(`/api/session/${encodeURIComponent(sessionID)}/prompt`, {
        method: "POST",
        body: { text, metadata: { [SCHEDULER_MARKER_KEY]: marker } },
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
        (message) => message.type === "user" && message.metadata?.[SCHEDULER_MARKER_KEY] === marker,
      )
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
    async activeSessions() {
      // Same upstream call the goal watchdog uses to reconcile lost idle.
      const response = await callOpencode("/api/session/active", { retry: false })
      if (!response.ok) throw new UpstreamStatusError(response.status, response)
      const body = (await response.json()) as { data?: Record<string, unknown> }
      return Object.keys(body.data ?? {})
    },
    async modelExists(model) {
      // Same catalog check the goal settings route's model list uses.
      const response = await callOpencode("/api/model", { retry: false })
      if (!response.ok) throw new UpstreamStatusError(response.status, response)
      const body = (await response.json()) as { data?: Array<{ id?: string; providerID?: string }> }
      return (body.data ?? []).some((entry) => entry.providerID === model.providerID && entry.id === model.id)
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
   * Task scheduler (issue #147): the manager owns the loop and every fire
   * body; the routes only validate and persist. It watches the same opencode
   * lifecycle frames the goal runs do and filters them internally. No
   * double-emit: its own `scheduler.updated` frames go out through `emit`
   * and are ignored by `handleEvent` on the way back. `reconcileTasks()` is
   * NOT called here — `index.ts` runs the single boot pass (next to the
   * worktree reconciliation).
   */
  const scheduler: SchedulerManager =
    deps.scheduler ??
    createScheduler({
      store: deps.store,
      opencode: schedulerOpencode,
      emit: (event) => deps.hub.emit(event),
    })
  deps.hub.subscribe((event) => scheduler.handleEvent(event))

  interface SessionRelease {
    promise: Promise<void>
    /** Directory supplied by the caller (or a later overlapping call). */
    directory: string | null
    /** Repo path supplied by a workspace delete, which removed the row first. */
    repoPath: string | null
    /**
     * First storage failure a best-effort cleanup swallowed. A strict caller
     * that joins the shared release must still surface it (503), even though
     * the release that started first had nothing to retry.
     */
    storageError: unknown | null
  }

  interface ReleaseOptions {
    /** Directory supplied by the caller (or a later overlapping call). */
    directory?: string
    /**
     * Repo path supplied by a workspace delete: the workspace row is gone, so
     * the usual lookup cannot resolve it.
     */
    repoPath?: string
    /** Aborts the in-flight git removal when the delete budget expires. */
    signal?: AbortSignal
    /**
     * Log a cleanup failure and keep releasing the remaining children
     * (workspace deletion, the out-of-band `session.deleted` event: once the
     * row is gone nothing can retry it). The session DELETE passes `false`: the
     * upstream session is already gone, so a storage failure leaves the
     * record/port row behind and the same request can still clean it — it
     * rethrows to `app.onError` (`503 storage_unavailable`) instead of
     * pretending the cleanup succeeded.
     */
    bestEffort?: boolean
  }

  /**
   * Handles one cleanup failure. A best-effort release logs it, records a
   * storage failure on the shared entry (a strict joiner still answers `503`)
   * and continues; a strict one rethrows storage failures so the route answers
   * `503` with the row still there for a retry (docs/past-mistakes.md rules
   * 14/27).
   */
  function cleanupFailure(
    what: string,
    sessionID: string,
    error: unknown,
    bestEffort: boolean,
    entry?: SessionRelease,
  ): void {
    if (isStorageError(error)) {
      if (!bestEffort) throw error
      if (entry && entry.storageError === null) entry.storageError = error
    }
    console.warn(`[masterhand] could not ${what} for ${sessionID}:`, error)
  }

  /**
   * Sessions whose release is in progress, one single-flight entry per id.
   * Registered synchronously at the top of `releaseSession`, before it awaits
   * the in-flight finish map: a finish that starts while the worktree is being
   * removed must not register (#187/#188). Overlapping releases (the DELETE
   * route plus opencode's `session.deleted`, or two clients) share the same
   * promise: a second caller must never clear the marker while the first is
   * still removing the worktree.
   */
  const releasing = new Map<string, SessionRelease>()

  /**
   * Drops every MasterHand-managed resource tied to a session id: its quick
   * tunnel (a leaked one would stay publicly exposed), its dev-server PTY, its
   * reserved port and its worktree record/branch. Used when a session is
   * deleted by a client and, critically, when opencode reports it deleted
   * outside MasterHand (TUI/API), where no route runs.
   *
   * Cleanup is best effort by default (workspace deletion and the out-of-band
   * event): once the workspace row is gone a caller has nothing left to retry,
   * so a failure while dropping one child is logged and the remaining children
   * are still released instead of turning the whole delete into a `503`
   * (docs/past-mistakes.md rule 14/27). The session DELETE passes
   * `bestEffort: false`: its upstream session is already gone, so a storage
   * failure must not answer `200` while the record/port row survives — it is
   * rethrown to the shared `503` mapping and a retry can still clean it.
   */
  function releaseSession(sessionID: string, options: ReleaseOptions = {}): Promise<void> {
    const { directory, repoPath, signal } = options
    const bestEffort = options.bestEffort ?? true
    const existing = releasing.get(sessionID)
    if (existing) {
      const hadDirectory = existing.directory !== null
      if (directory && !existing.directory) existing.directory = directory
      if (repoPath && !existing.repoPath) existing.repoPath = repoPath
      // Each caller owns its policy for the shared outcome: a strict release
      // rethrows (including a storage failure a best-effort owner swallowed and
      // recorded), a best-effort one swallows.
      const shared = existing.promise.then(
        () => {
          if (!bestEffort && existing.storageError !== null) throw existing.storageError
        },
        (error) => {
          if (!bestEffort) throw error
        },
      )
      if (!directory || hadDirectory) return shared
      // This caller supplied the directory the first release lacked. The shared
      // cleanup reads `entry.directory` after its awaits, but it may already be
      // past the run step: re-run the (idempotent) stop once it settles.
      return shared.then(async () => {
        try {
          await runs.stop(sessionID, directory)
        } catch (error) {
          cleanupFailure("stop run", sessionID, error, bestEffort, existing)
        }
      })
    }

    const entry: SessionRelease = {
      promise: Promise.resolve(),
      directory: directory ?? null,
      repoPath: repoPath ?? null,
      storageError: null,
    }
    const task = (async () => {
      // A finish still needs the worktree to commit/push: deleting the branch
      // under it would turn a successful finish into a lost push (#187/#188).
      await awaitFinish(sessionID)
      try {
        await goals.forget(sessionID)
      } catch (error) {
        cleanupFailure("forget goal", sessionID, error, bestEffort, entry)
      }
      try {
        await preview.forget(sessionID)
      } catch (error) {
        cleanupFailure("forget preview", sessionID, error, bestEffort, entry)
      }
      let record: IsolatedSessionRecord | null = null
      try {
        record = deps.store.getIsolatedSession(sessionID)
      } catch (error) {
        cleanupFailure("read isolated record", sessionID, error, bestEffort, entry)
      }
      // `stop` (not `forget`) waits for an in-flight start and adopts an orphan
      // PTY by title, so no dev server survives the session's directory.
      const runDirectory = record?.path ?? entry.directory
      if (runDirectory) {
        try {
          await runs.stop(sessionID, runDirectory)
        } catch (error) {
          cleanupFailure("stop run", sessionID, error, bestEffort, entry)
        }
      } else {
        // No directory known (out-of-band event without a record): best effort.
        try {
          runs.forget(sessionID)
        } catch (error) {
          cleanupFailure("forget run", sessionID, error, bestEffort, entry)
        }
      }
      if (!record) return
      // Workspace deletion removes the row before its children; the caller then
      // supplies the repo path so the worktree/branch still goes away.
      let repo: string | undefined = entry.repoPath ?? undefined
      try {
        repo = deps.store.getWorkspace(record.workspaceID)?.path ?? repo
      } catch (error) {
        cleanupFailure("resolve the repo", sessionID, error, bestEffort, entry)
      }
      if (repo) {
        try {
          await worktrees.remove(repo, record.path, record.branch, { signal })
        } catch (error) {
          // best effort: never block dropping the record
          console.warn(`[masterhand] could not remove the worktree for ${sessionID}:`, error)
        }
      }
      try {
        deps.store.removeIsolatedSession(sessionID)
      } catch (error) {
        cleanupFailure("drop the isolated record", sessionID, error, bestEffort, entry)
      }
    })()
    entry.promise = task.finally(() => {
      // Only the entry that registered the slot may clear it: a later release
      // of a re-created session must not be removed by this one's `finally`.
      if (releasing.get(sessionID) === entry) releasing.delete(sessionID)
    })
    releasing.set(sessionID, entry)
    return entry.promise
  }

  /**
   * Rolls back an isolated create's worktree. Git cannot remove a worktree when
   * the repository folder disappeared with its workspace (`deleteFiles=1`
   * during the create), and startup reconciliation only walks existing
   * workspace rows, so such a worktree would leak forever. When the row is
   * confirmed gone, delete the directory directly (its path came from
   * `worktreeDir`, inside `WORKTREES_ROOT`).
   */
  async function removeIsolatedWorktree(
    workspaceID: string,
    repoPath: string,
    path: string,
    branch: string,
  ): Promise<void> {
    try {
      await worktrees.remove(repoPath, path, branch)
    } catch (error) {
      // the worktree or its repo may already be gone
      console.warn(`[masterhand] could not remove the worktree at ${path}:`, error)
    }
    let workspaceGone = false
    try {
      workspaceGone = deps.store.getWorkspace(workspaceID) === null
    } catch (error) {
      // An unreadable store is not proof the workspace is gone: leave the
      // directory for reconciliation rather than deleting it blind.
      console.warn(`[masterhand] could not check workspace ${workspaceID} during rollback:`, error)
    }
    if (!workspaceGone) return
    try {
      await removeDir(path)
    } catch (error) {
      console.warn(`[masterhand] could not remove the worktree directory at ${path}:`, error)
    }
  }

  /**
   * Deletes an upstream session created for a request whose local outcome
   * failed (rollback). Awaited and bounded (`OPENCODE_TIMEOUT_MS`): answering
   * before it settles would lose the cleanup if the process stopped right
   * after the response. A `404` means it is already gone; anything else is
   * logged, never turned into a second error that hides the original failure.
   */
  async function rollbackUpstreamSession(sessionID: string): Promise<void> {
    try {
      const response = await callOpencode(`/api/session/${encodeURIComponent(sessionID)}`, { method: "DELETE" })
      if (!response.ok && response.status !== 404) {
        console.warn(`[masterhand] could not delete rolled-back session ${sessionID}: opencode ${response.status}`)
      }
    } catch (error) {
      console.warn(`[masterhand] could not delete rolled-back session ${sessionID}:`, error)
    }
  }

  /**
   * Moves an unconfirmed worktree out of the way when its workspace row is
   * gone: startup reconciliation only walks existing workspaces, so nobody
   * would ever quarantine it. Keeps the data (rename, branch kept); when the
   * directory is already gone there is nothing to preserve and the failure is
   * only logged. Never deletes unknown work.
   */
  async function quarantineUnknownWorktree(repoPath: string, path: string): Promise<void> {
    try {
      const target = await worktrees.quarantine(repoPath, path)
      console.warn(
        `[masterhand] quarantined unconfirmed worktree ${path} (workspace gone) at ${target}; its session is unknown`,
      )
    } catch (error) {
      console.warn(`[masterhand] could not quarantine the unconfirmed worktree at ${path}:`, error)
    }
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
   * answer 504 `opencode_timeout` instead of an opaque 500. An outer signal
   * (e.g. a whole-operation budget) joins the per-call timeout: whichever
   * fires first aborts the fetch.
   */
  async function fetchOpencode(target: URL, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(config.opencodeTimeoutMs)
    try {
      return await fetchImpl(target, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
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
    // Infrastructure failures are not a goal failure: let app.onError answer
    // the shared 503 storage_unavailable instead of a misleading 502
    // (docs/past-mistakes.md rule 14).
    if (isStorageError(error)) throw error
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
      /** Aborts the fetch (e.g. a whole-operation budget owns the deadline). */
      signal?: AbortSignal
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
      fetchOpencode(
        target,
        {
          method,
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
        },
        options.signal,
      )

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
   * nothing). The whole loop owns one budget (issue #194): attempts stack
   * per-call timeouts otherwise, and the route must answer inside the
   * client's deadline. A failure never fails the create: the provider stays
   * and the card offers Connect. The key travels only in the request body and
   * is never logged.
   */
  async function connectCustomProviderKey(id: string, key: string, label?: string): Promise<boolean> {
    const path = `/api/integration/${encodeURIComponent(id)}/connect/key`
    const budget = AbortSignal.timeout(deps.connectKeyBudgetMs ?? CONNECT_KEY_BUDGET_MS)
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (budget.aborted) return false
      try {
        const response = await callOpencode(path, {
          method: "POST",
          body: { key, ...(label ? { label } : {}) },
          signal: budget,
        })
        if (response.ok) return true
        if (response.status !== 404) return false
      } catch {
        return false
      }
      await sleepUnlessAborted(CONNECT_KEY_RETRY_MS, budget)
    }
    return false
  }

  /** Settles early when the operation budget expires instead of oversleeping it. */
  function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(cleanup, ms)
      function cleanup(): void {
        clearTimeout(timer)
        signal.removeEventListener("abort", cleanup)
        resolve()
      }
      signal.addEventListener("abort", cleanup, { once: true })
    })
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

  /**
   * Finds the session a create whose response was lost may have produced. The
   * lookup is a fresh list of the created directory (never the 5 s aggregation
   * cache) and matches only the client's persisted `masterhand.create` marker,
   * so a session from another directory or device can never be adopted (#185).
   */
  async function findSessionByCreateMarker(
    directory: string,
    marker: string,
  ): Promise<OpencodeSession | null> {
    const sessions = await fetchSessionsInDirectory(directory)
    return sessions.find((session) => session.metadata?.[CREATE_MARKER_KEY] === marker) ?? null
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
   * denied so a broad kill cannot take down the agent engine. The engine read
   * denies come last: opencode evaluates last-match-wins, so they must stay
   * after the `external_directory: allow *` entry to confine engine-side reads
   * of /proc and the credential store (#219). Best effort: it must never block
   * session creation.
   */
  async function ensurePermissionGuards(sessionID: string): Promise<void> {
    try {
      const response = await callOpencode(`/api/session/${encodeURIComponent(sessionID)}`, {
        method: "PATCH",
        body: { permissions: [...externalWriteGuardRules(), ...processGuardRules(), ...engineReadGuardRules()] },
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

  app.post("/api/login", authBodyLimit, async (c) => {
    const ip = clientIp(c)
    let password: unknown
    try {
      password = (await c.req.json<{ password?: unknown }>()).password
    } catch {
      password = undefined
    }
    if (typeof password !== "string" || password.length === 0 || password.length > MAX_PASSWORD_LENGTH) {
      return c.json({ error: "bad_request" }, 400)
    }
    // The correct password always wins, even when the failure budget is spent:
    // only failures are counted, so a locked-out user is never locked out.
    if (!passwordsMatch(password, config.masterhandPassword)) {
      return rejectPassword(c, ip)
    }

    loginLimiter.reset(ip)
    const token = createSessionToken(config.sessionSecret, config.sessionTtlHours * 3600)
    setSessionCookie(c, token, config)
    return c.json({ ok: true })
  })

  app.post("/api/devices", authBodyLimit, async (c) => {
    const ip = clientIp(c)
    let body: { password?: unknown; name?: unknown; installID?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "bad_request" }, 400)
    }
    if (
      typeof body.password !== "string" ||
      body.password.length === 0 ||
      body.password.length > MAX_PASSWORD_LENGTH
    ) {
      return c.json({ error: "bad_request" }, 400)
    }
    if (!passwordsMatch(body.password, config.masterhandPassword)) {
      return rejectPassword(c, ip)
    }

    loginLimiter.reset(ip)
    const now = Date.now()
    const name =
      typeof body.name === "string" && body.name.trim()
        ? body.name.trim().slice(0, MAX_DEVICE_NAME_LENGTH)
        : "Device"
    const installID =
      typeof body.installID === "string" && body.installID.trim()
        ? body.installID.trim().slice(0, MAX_INSTALL_ID_LENGTH)
        : null
    // Identity is the stable install id, never the mutable display label
    // (issue #193). Clients without one keep the pre-#87c behavior: a new row
    // per login. A known install id keeps its existing label.
    const existing = installID === null ? null : deps.store.getByInstallID(installID)
    let device: DeviceRecord
    if (existing) {
      deps.store.touch(existing.id, now)
      device = { ...existing, lastUsedAt: now }
    } else {
      device = { id: randomUUID(), name, installID, createdAt: now, lastUsedAt: now }
      try {
        deps.store.create(device)
      } catch (error) {
        // Two concurrent logins can race past the lookup; the unique index
        // rejects the loser, which then re-reads the winner (idempotent).
        const raced = installID !== null && isStorageConflict(error) ? deps.store.getByInstallID(installID) : null
        if (!raced) throw error
        deps.store.touch(raced.id, now)
        device = { ...raced, lastUsedAt: now }
      }
    }
    const token = createDeviceToken(config.sessionSecret, device.id, config.sessionTtlHours * 3600)
    return c.json({ token, device }, 201)
  })

  app.post("/api/logout", (c) => {
    clearSessionCookie(c, config)
    return c.json({ ok: true })
  })

  app.use("/api/oc/*", requireAuth(config, deps.store))
  app.use("/api/oc/*", bodyLimit({ maxSize: proxyBodyLimitBytes, onError: rejectOversizedBody }))
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

    const discovered = await fetchProviderModels(result.value, {
      fetchImpl,
      allowLoopback: config.providersAllowLoopback,
    })
    if (!discovered.ok) {
      // A blocked target (loopback/link-local/metadata) is invalid caller input,
      // not an upstream failure; timeouts keep their own mapping.
      const status =
        discovered.error === "provider_timeout" ? 504 : discovered.error === "invalid_base_url" ? 400 : 502
      return c.json({ error: discovered.error }, status)
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

  /**
   * Web search source selection: opencode reads the `websearch` key from its
   * config, so MasterHand stores it in the same owned file (hot-reloaded) and
   * the API keys still go through opencode's own `connect/key` per source.
   */
  function websearchFailure(c: Context, error: unknown) {
    if (error instanceof CustomProvidersFileError) {
      return c.json({ error: "websearch_corrupt" }, 500)
    }
    const code = (error as { code?: string } | null)?.code
    console.error("[masterhand] websearch config failure:", error)
    if (code === "EACCES" || code === "EROFS" || code === "ENOSPC") {
      return c.json({ error: "websearch_unwritable" }, 503)
    }
    return c.json({ error: "websearch_failed" }, 500)
  }

  api.get("/websearch", async (c) => {
    try {
      return c.json({ provider: await readWebsearchSelection(providers) })
    } catch (error) {
      return websearchFailure(c, error)
    }
  })

  /**
   * Reads the stored selection, seeding the keyless default when the key is
   * absent. The boot-time seed covers installs that never open settings; this
   * lazy pass keeps it true when the owned file is recreated under a running
   * server (the E2E harness wipes its scratch dir after boot). A present but
   * unrecognized value is never overwritten.
   */
  async function readWebsearchSelection(store: CustomProviderStore): Promise<WebsearchSelection | null> {
    const current = await store.getWebsearch()
    if (current !== null) return current
    if (await store.hasWebsearch()) return null
    await store.setWebsearch(DEFAULT_WEBSEARCH_PROVIDER)
    return DEFAULT_WEBSEARCH_PROVIDER
  }

  /** Full-state replacement: retrying the same body is safe (rule 4). */
  api.put("/websearch", async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "invalid_body" }, 400)
    }
    const result = validateWebsearchSelection(body)
    if (!result.ok) return c.json({ error: result.error }, 400)
    try {
      await providers.setWebsearch(result.value)
      return c.json({ provider: result.value })
    } catch (error) {
      return websearchFailure(c, error)
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
    const deleteFiles = c.req.query("deleteFiles") === "1"

    // A refused destructive delete must never have touched a child resource.
    if (deleteFiles && !isInsideRoot(config.workspacesRoot, workspace.path)) {
      return c.json({ error: "outside_root" }, 403)
    }

    // Pause every task aimed at this folder through its serialized chain
    // (#188) BEFORE the active-session guard: `pauseTask` waits for a fire in
    // flight, so its session is then visible to the guard. With the guard
    // first, a fire starting in that window would be paused afterwards and the
    // folder could be removed under the session it just created. One bad task
    // never blocks the delete.
    const tasksPausedHere: string[] = []
    for (const task of deps.store.listScheduledTasks()) {
      if (task.directory !== workspace.path) continue
      if (!task.paused) tasksPausedHere.push(task.id)
      try {
        await scheduler.pauseTask(task.id)
      } catch (error) {
        console.warn(`[masterhand] could not pause scheduled task ${task.id}:`, error)
      }
    }

    /**
     * A refused delete never removes the folder, so the tasks this request
     * paused must be resumed (`resumeTask` recomputes a strictly future slot).
     * Resuming a task another request paused too is harmless: the workspace is
     * still there only because this delete was refused.
     */
    async function resumeTasksPausedHere(): Promise<void> {
      for (const taskID of tasksPausedHere) {
        try {
          await scheduler.resumeTask(taskID)
        } catch (error) {
          console.warn(`[masterhand] could not resume scheduled task ${taskID}:`, error)
        }
      }
      tasksPausedHere.length = 0
    }

    // Read the isolated records after the pause waits: a record created during
    // an in-flight fire belongs to the guard too.
    let records: IsolatedSessionRecord[]
    let busy: Response | null = null
    try {
      records = deps.store.listIsolatedSessions(workspace.id)

      // Deleting the folder under a running turn is destructive: refuse it while
      // any session of the base folder or an isolated worktree is active. The
      // guard fails closed (see `activeSessionGuard`).
      if (deleteFiles) {
        busy = await activeSessionGuard(c, [
          workspace.path,
          ...records.map((record) => record.path),
        ])
      }
    } catch (error) {
      // Any refusal before the row removal (including a storage failure) must
      // leave the workspace's schedules as they were.
      await resumeTasksPausedHere()
      throw error
    }
    if (busy) {
      await resumeTasksPausedHere()
      return busy
    }

    // Remove the parent row before releasing children (synchronous, so it
    // cannot interleave): a create that already passed its workspace lookup
    // can no longer land a record that references a deleted workspace, because
    // its pre-insert re-check now fails and rolls the worktree/session back.
    // The row goes before the folder: if the folder delete fails, the files
    // remain for inspection, but MasterHand no longer registers them.
    try {
      deps.store.removeWorkspace(workspace.id)
    } catch (error) {
      // The delete did not happen: the folder and row are still there, so the
      // paused schedules must stay active.
      await resumeTasksPausedHere()
      throw error
    }

    // Isolated worktrees live outside the workspace folder, and each session
    // owns lifecycles that outlive the folder (an in-flight finish, a managed
    // PTY, a goal run, a preview). Wait/release them before removing the
    // worktree and its record. Re-list after the row removal: a create that
    // inserted its record during the guard/pause awaits is still reachable
    // here (its own pre-insert re-check now fails), so no record is stranded.
    // The repo path is passed explicitly because the workspace row (the usual
    // lookup) is already gone. Releases run with bounded concurrency under one
    // budget (issue #204): sequentially they outlive the client's deadline,
    // and unbounded they fan out to a burst of git children.
    const deleteBudget = new AbortController()
    const deleteBudgetMs = deps.workspaceDeleteBudgetMs ?? WORKSPACE_DELETE_BUDGET_MS
    const releaseWork: Promise<void> = (async () => {
      await eachLimit(deps.store.listIsolatedSessions(workspace.id), DELETE_RELEASE_CONCURRENCY, (record) =>
        releaseSession(record.sessionID, {
          directory: record.path,
          repoPath: workspace.path,
          signal: deleteBudget.signal,
        }),
      )

      // Base-folder sessions own the same lifecycles (`sessionRunContext`
      // resolves them too): stop their PTY/preview/goal run before the folder
      // disappears. Best effort: a delete must not fail because opencode is
      // unreachable.
      try {
        const sessions = await fetchSessionsInDirectory(workspace.path)
        await eachLimit(sessions, DELETE_RELEASE_CONCURRENCY, (session) =>
          releaseSession(session.id, { directory: workspace.path, signal: deleteBudget.signal }),
        )
      } catch (error) {
        console.warn(`[masterhand] could not release sessions of ${workspace.path}:`, error)
      }

      // `rm` has no abort channel, so the budget race below bounds the wait:
      // on expiry the removal continues detached while the route answers.
      if (deleteFiles) await removeDir(workspace.path)
    })()
    let deleteTimer: ReturnType<typeof setTimeout> | undefined
    const budgetHit = new Promise<false>((resolve) => {
      deleteTimer = setTimeout(() => {
        deleteBudget.abort()
        resolve(false)
      }, deleteBudgetMs)
      deleteTimer.unref?.()
    })
    let released: boolean
    try {
      released = await Promise.race([releaseWork.then(() => true as const), budgetHit])
    } finally {
      if (deleteTimer) clearTimeout(deleteTimer)
    }
    if (!released) {
      // The row is already gone, so the delete did apply — but the remaining
      // child releases are still running. Answer ambiguous (never a hard
      // failure, never an auto-retry): the client reconciles by refetching
      // the workspace list, and the releases continue in the background
      // (docs/past-mistakes.md rules 1/2/4).
      releaseWork.catch((error) => {
        console.warn(`[masterhand] workspace ${workspace.id} background release failed:`, error)
      })
      return c.json({ error: "delete_timeout" }, 504)
    }

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
   * Refuses a destructive change while any session in the given directories is
   * active. The check is fresh (never the 5 s aggregation cache): a session
   * created moments ago may already be running. It fails closed — when
   * opencode cannot confirm, the mutation is not attempted.
   */
  async function activeSessionGuard(c: Context, directories: string[]): Promise<Response | null> {
    try {
      const lists = await Promise.all(directories.map((directory) => fetchSessionsInDirectory(directory)))
      const sessions = lists.flat()
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
    return null
  }

  /**
   * A branch switch under a running turn would move the files beneath it, and
   * a branch operation on a dirty tree can lose the user's work: refuse both.
   */
  async function branchGuard(
    c: Context,
    workspacePath: string,
    options: { requireClean: boolean },
  ): Promise<Response | null> {
    const busy = await activeSessionGuard(c, [workspacePath])
    if (busy) return busy
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
    // created before the stable role key existed. The pinned opencode drops
    // `parentID` on create, so the run store also supplies the link back to the
    // main session (the client uses it for the "Back to main agent" affordance).
    const goalSessions = new Map<string, { role: GoalRole; parentID: string }>()
    for (const run of deps.store.listGoalRuns()) {
      if (run.criticSessionID) goalSessions.set(run.criticSessionID, { role: "critic", parentID: run.sessionID })
      if (run.judgeSessionID) goalSessions.set(run.judgeSessionID, { role: "judge", parentID: run.sessionID })
    }

    const byID = new Map(records.map((record) => [record.sessionID, record]))
    type MergedSession = OpencodeSession & {
      isolation?: ReturnType<typeof isolationOf>
      goalRole?: GoalRole
    }
    const merged = new Map<string, MergedSession>()
    for (const session of lists.flat()) {
      const fromStore = goalSessions.get(session.id)
      const goalRole = fromStore?.role ?? goalRoleFromMetadata(session.metadata)
      const parentID = session.parentID ?? fromStore?.parentID
      const annotated: MergedSession = goalRole ? { ...session, goalRole, parentID } : session
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
      // The workspace may have been deleted while opencode was creating the
      // session. Re-read the row before the response: a standard session has
      // no isolation record that could be rolled back later, so delete the
      // upstream session now instead of leaving an orphan in a removed folder.
      // The bounded DELETE is awaited: answering before it settles would lose
      // the cleanup if the process stopped right after the response.
      if (!deps.store.getWorkspace(workspace.id)) {
        await rollbackUpstreamSession(session.id)
        return c.json({ error: "workspace_busy" }, 409)
      }
      invalidateSessionsCache()
      await ensurePreviewInstruction(session.id)
      await ensureWorkspaceGuard(session.id, workspace.path)
      return c.json({ session, isolation: null }, 201)
    }

    const token = randomUUID().replace(/-/g, "").slice(0, 10)
    let path: string
    let branch: string
    let baseRef = ""
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

      // The workspace may have been deleted while opencode was creating the
      // session. The lookup at the top of the route is now stale; re-read the
      // row synchronously immediately before the insert (workspace deletion
      // removes it first), so no isolation record ever references a deleted
      // workspace or leaks its worktree. Roll back like a definitive failure.
      if (!deps.store.getWorkspace(workspace.id)) {
        if (sessionID) await rollbackUpstreamSession(sessionID)
        await removeIsolatedWorktree(workspace.id, workspace.path, path, branch)
        return c.json({ error: "workspace_busy" }, 409)
      }

      const record: IsolatedSessionRecord = isolatedSessionRecord(session.id, workspace.id, path, branch, baseRef)
      deps.store.createIsolatedSession(record)
      return c.json({ session: { ...session, isolation: isolationOf(record) }, isolation: isolationOf(record) }, 201)
    } catch (error) {
      // A storage failure while persisting the isolation record says nothing
      // about the worktree or the session: both are healthy, so never roll them
      // back. Rethrow before any cleanup/typed fallback so app.onError answers
      // 503 storage_unavailable instead of 500 isolation_failed (#191).
      if (isStorageError(error)) throw error
      // A deadline is not proof of failure: opencode may have created the
      // session before its response stalled. Reconcile the persisted create
      // marker inside the worktree MasterHand just made; the worktree is never
      // removed on a timeout, because that would make a recovered session
      // unreachable and destroy agent work (#79, #185). With no marker to prove
      // the outcome, it stays for the startup quarantine/reconcile.
      if (error instanceof OpencodeTimeoutError) {
        let recovered: OpencodeSession | null = null
        if (marker) {
          try {
            recovered = await findSessionByCreateMarker(path, marker)
          } catch {
            // The lookup itself failed: the outcome stays unknown.
          }
        }
        if (!recovered) {
          // The workspace may have been deleted while the deadline ran. Startup
          // reconciliation only walks existing workspaces, so an unregistered
          // worktree of a deleted one would leak forever — but its session is
          // unknown, so it is quarantined (renamed, data/branch kept), never
          // deleted. A store read failure is not proof the row is gone: keep
          // the current 504/preserve behavior.
          let workspaceGone = false
          try {
            workspaceGone = deps.store.getWorkspace(workspace.id) === null
          } catch (readError) {
            console.warn(`[masterhand] could not check workspace ${workspace.id} after a timeout:`, readError)
          }
          if (workspaceGone) await quarantineUnknownWorktree(workspace.path, path)
          return c.json({ error: "opencode_timeout" }, 504)
        }

        // The timeout recovery is still a create: if the workspace was deleted
        // meanwhile, roll the recovered session and worktree back instead of
        // persisting an isolation record for a workspace that is gone.
        if (!deps.store.getWorkspace(workspace.id)) {
          await rollbackUpstreamSession(recovered.id)
          await removeIsolatedWorktree(workspace.id, workspace.path, path, branch)
          return c.json({ error: "workspace_busy" }, 409)
        }

        // Persist before the best-effort guard writes: a crash after this point
        // keeps the record (and the worktree) recoverable after a restart.
        // A duplicate reconcile could hit the session's primary key. Adopting
        // the persisted row is defensive only (a real retry uses a new token,
        // so a new worktree): accept it only when it belongs to this attempt.
        let record: IsolatedSessionRecord
        try {
          record = isolatedSessionRecord(recovered.id, workspace.id, path, branch, baseRef)
          deps.store.createIsolatedSession(record)
        } catch (error) {
          const adopted = isStorageConflict(error) ? deps.store.getIsolatedSession(recovered.id) : null
          if (!adopted || adopted.path !== path || adopted.workspaceID !== workspace.id) throw error
          record = adopted
        }
        await ensurePreviewInstruction(recovered.id)
        await ensureWorkspaceGuard(recovered.id, path)
        invalidateSessionsCache()
        return c.json(
          { session: { ...recovered, isolation: isolationOf(record) }, isolation: isolationOf(record) },
          201,
        )
      }

      if (sessionID) await rollbackUpstreamSession(sessionID)
      await removeIsolatedWorktree(workspace.id, workspace.path, path, branch)
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

    await releaseSession(sessionID, {
      directory: deps.store.getIsolatedSession(sessionID)?.path ?? workspace.path,
      bestEffort: false,
    })
    return c.json({ ok: true })
  })

  // Finish is a non-idempotent check→create chain (commit, push, PR). Two
  // devices — or a lost-response retry racing the first request — must share
  // one operation and one PR, so the in-flight promise is registered before
  // the first await (docs/past-mistakes.md rule 12; `RunManager.start` is the
  // precedent). The map is app-scoped: one BFF instance per process.
  const finishing = new Map<string, Promise<FinishOutcome>>()

  async function finishOnce(sessionID: string, signal: AbortSignal): Promise<FinishOutcome> {
    // Re-read after acquiring the slot: an earlier attempt may have persisted
    // the push/PR while this request was queued.
    const record = deps.store.getIsolatedSession(sessionID)
    if (!record) return { ok: false, error: "not_found" }
    const workspace = deps.store.getWorkspace(record.workspaceID)
    if (!workspace) return { ok: false, error: "not_found" }

    let committed = false
    try {
      committed = await worktrees.commitAll(record.path, `MasterHand session ${record.sessionID}`, { signal })
    } catch (error) {
      return {
        ok: false,
        error: "commit_failed",
        detail: error instanceof Error ? error.message : "unknown",
      }
    }

    let pushed = false
    let pushError: string | null = null
    const remoteUrl = await worktrees.remoteUrl(record.path, { signal })
    // A compare URL is a response-only convenience, never proof of a PR. A
    // stored value equal to it is a legacy row written by an older build and
    // is treated as non-authoritative so the next finish can replace it.
    const compareUrl = remoteUrl ? pullRequestUrl(remoteUrl, record.branch, record.baseRef) : null
    const legacyCompare = record.prUrl !== null && record.prUrl === compareUrl
    let prUrl = record.prUrl && !legacyCompare ? record.prUrl : null
    if (remoteUrl) {
      try {
        await worktrees.push(record.path, record.branch, { signal })
        pushed = true
      } catch (error) {
        pushError = error instanceof Error ? error.message : "push_failed"
      }
      if (pushed && !prUrl) {
        // pullRequest reconciles an existing PR/MR when create reports a
        // duplicate, so a retry never loses the real URL to the fallback.
        prUrl = await worktrees.pullRequest(record.path, remoteUrl, record.branch, record.baseRef, { signal })
      }
    }

    // Persist only a provider-returned real URL; pushed and the first real PR
    // are monotonic (a later failed attempt cannot downgrade either).
    deps.store.updateIsolatedSession(record.sessionID, {
      pushed: pushed || record.pushed,
      prUrl,
      replacePrUrl: legacyCompare,
    })
    return {
      ok: true,
      committed,
      pushed: pushed || record.pushed,
      prUrl: prUrl ?? compareUrl,
      branch: record.branch,
      path: record.path,
      error: pushError,
    }
  }

  function finish(sessionID: string): Promise<FinishOutcome> {
    // Synchronous: a release that started after `awaitFinish` sampled the map
    // must never see a finish registered behind it. The session is being
    // removed, so it is indistinguishable from a missing record for the caller:
    // answer `404 not_found` (never a retryable `workspace_busy`).
    if (releasing.has(sessionID)) return Promise.resolve({ ok: false, error: "not_found" })
    const pending = finishing.get(sessionID)
    if (pending) return pending
    // One budget per operation (issue #204), not per request: joiners share
    // the first request's deadline. Expiry aborts the in-flight git children;
    // the outcome maps to `timed_out` below, never to a hard failure, and the
    // server never retries the push/PR itself.
    const operation = new AbortController()
    const budgetMs = deps.finishBudgetMs ?? FINISH_BUDGET_MS
    const budget = setTimeout(() => operation.abort(), budgetMs)
    // Never keep the process alive for a coalesced operation (tests hold
    // gates past their budgets; production exits through shutdown anyway).
    budget.unref?.()
    const task = finishOnce(sessionID, operation.signal)
      .then(
        (outcome): FinishOutcome => (operation.signal.aborted ? { ok: false, error: "timed_out" } : outcome),
      )
      .finally(() => {
        clearTimeout(budget)
        if (finishing.get(sessionID) === task) finishing.delete(sessionID)
      })
    finishing.set(sessionID, task)
    return task
  }

  /**
   * Waits for an in-flight finish. Workspace deletion (#188) must await this
   * before removing the worktree the operation is still using.
   */
  async function awaitFinish(sessionID: string): Promise<void> {
    const pending = finishing.get(sessionID)
    if (pending) await pending.catch(() => {})
  }

  api.post("/isolated-sessions/:sessionID/finish", async (c) => {
    const outcome = await finish(c.req.param("sessionID"))
    if (!outcome.ok) {
      if (outcome.error === "not_found") return c.json({ error: "not_found" }, 404)
      // The operation may still have applied (a push killed mid-flight can
      // land): ambiguous, so the client reconciles against the record instead
      // of seeing a failure (docs/past-mistakes.md rules 1/2/4).
      if (outcome.error === "timed_out") return c.json({ error: "finish_timeout" }, 504)
      return c.json({ error: "commit_failed", detail: outcome.detail }, 500)
    }
    return c.json({
      committed: outcome.committed,
      pushed: outcome.pushed,
      prUrl: outcome.prUrl,
      branch: outcome.branch,
      path: outcome.path,
      error: outcome.error,
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
      // Port allocation persists to the store: a storage failure is not an
      // opencode failure. Let app.onError answer 503 storage_unavailable.
      if (isStorageError(error)) throw error
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
      // `runs.start` allocates/persists the preview port: a storage failure is
      // infrastructure and must reach app.onError (503), not `run_failed` (500).
      if (isStorageError(error)) throw error
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
      // `preview.start` reads/writes the port mapping: a storage failure is
      // infrastructure and must reach app.onError (503), not `preview_failed`.
      if (isStorageError(error)) throw error
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

  /**
   * Kanban board (one per workspace, issue #164). Positions are absolute and
   * idempotent: a lost response is reconciled by a plain refetch/retry with no
   * duplication (creates upsert by client-generated id, deletes are idempotent).
   * Every mutation broadcasts a synthetic `board.updated` frame with the full
   * snapshot, exactly like `goal.updated`.
   */
  function normalizeBoardID(value: unknown): string | null {
    return typeof value === "string" && value.length >= 1 && value.length <= 128 && /^[A-Za-z0-9._-]+$/.test(value)
      ? value
      : null
  }

  function normalizeBoardTitle(value: unknown): string | null {
    if (typeof value !== "string") return null
    const title = value.trim()
    return title.length > 0 && title.length <= 200 ? title : null
  }

  function normalizeBoardDescription(value: unknown): string | null {
    if (value === undefined) return ""
    if (typeof value !== "string" || value.length > 10000) return null
    return value
  }

  function normalizeBoardPosition(value: unknown): number | undefined | null {
    if (value === undefined) return undefined
    return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null
  }

  function emitBoardUpdated(workspaceID: string): void {
    try {
      deps.hub.emit({ type: "board.updated", data: { workspaceID, board: deps.store.getBoard(workspaceID) } })
    } catch {
      // best effort: the mutation already applied
    }
  }

  function boardWorkspaceOfColumn(columnID: string): string | null {
    return deps.store.getBoardColumn(columnID)?.workspaceID ?? null
  }

  function boardWorkspaceOfCard(cardID: string): string | null {
    const card = deps.store.getBoardCard(cardID)
    if (!card) return null
    return boardWorkspaceOfColumn(card.columnID)
  }

  api.get("/board", (c) => {
    const workspaceID = c.req.query("workspace") ?? ""
    if (!workspaceID) return c.json({ error: "workspace_required" }, 400)
    if (!deps.store.getWorkspace(workspaceID)) return c.json({ error: "workspace_not_found" }, 404)
    return c.json({ board: deps.store.getBoard(workspaceID) })
  })

  api.post("/board/columns", async (c) => {
    let body: { id?: unknown; workspaceID?: unknown; title?: unknown; position?: unknown }
    try {
      body = (await c.req.json()) as typeof body
    } catch {
      return c.json({ error: "invalid_body" }, 400)
    }
    const id = normalizeBoardID(body.id)
    if (!id) return c.json({ error: "invalid_id" }, 400)
    const workspaceID = typeof body.workspaceID === "string" ? body.workspaceID : ""
    if (!workspaceID) return c.json({ error: "workspace_required" }, 400)
    if (!deps.store.getWorkspace(workspaceID)) return c.json({ error: "workspace_not_found" }, 404)
    const title = normalizeBoardTitle(body.title)
    if (!title) return c.json({ error: "invalid_title" }, 400)
    const position = normalizeBoardPosition(body.position)
    if (position === null) return c.json({ error: "invalid_position" }, 400)
    const column = deps.store.createBoardColumn({ id, workspaceID, title, position })
    // Upsert is by id: a replay returns the existing row. An id that already
    // lives in another workspace is a conflict, not a move (unreachable with
    // client UUIDs, but the invariant is enforced at the trust boundary).
    if (column.workspaceID !== workspaceID) return c.json({ error: "column_workspace_mismatch" }, 409)
    emitBoardUpdated(workspaceID)
    return c.json({ column }, 201)
  })

  api.patch("/board/columns/:id", async (c) => {
    const id = c.req.param("id")
    let body: { title?: unknown; position?: unknown }
    try {
      body = (await c.req.json()) as typeof body
    } catch {
      return c.json({ error: "invalid_body" }, 400)
    }
    if (body.title === undefined && body.position === undefined) return c.json({ error: "invalid_body" }, 400)
    const patch: { title?: string; position?: number } = {}
    if (body.title !== undefined) {
      const title = normalizeBoardTitle(body.title)
      if (!title) return c.json({ error: "invalid_title" }, 400)
      patch.title = title
    }
    if (body.position !== undefined) {
      const position = normalizeBoardPosition(body.position)
      if (position === null || position === undefined) return c.json({ error: "invalid_position" }, 400)
      patch.position = position
    }
    const column = deps.store.updateBoardColumn(id, patch)
    if (!column) return c.json({ error: "column_not_found" }, 404)
    emitBoardUpdated(column.workspaceID)
    return c.json({ column })
  })

  api.delete("/board/columns/:id", (c) => {
    const id = c.req.param("id")
    // Workspace for the frame: resolved before deletion (idempotent when unknown).
    const workspaceID = boardWorkspaceOfColumn(id)
    deps.store.deleteBoardColumn(id)
    if (workspaceID) emitBoardUpdated(workspaceID)
    return c.json({ ok: true })
  })

  api.post("/board/cards", async (c) => {
    let body: { id?: unknown; columnID?: unknown; title?: unknown; description?: unknown; position?: unknown }
    try {
      body = (await c.req.json()) as typeof body
    } catch {
      return c.json({ error: "invalid_body" }, 400)
    }
    const id = normalizeBoardID(body.id)
    if (!id) return c.json({ error: "invalid_id" }, 400)
    const columnID = normalizeBoardID(body.columnID)
    if (!columnID) return c.json({ error: "invalid_column" }, 400)
    const title = normalizeBoardTitle(body.title)
    if (!title) return c.json({ error: "invalid_title" }, 400)
    const description = normalizeBoardDescription(body.description)
    if (description === null) return c.json({ error: "invalid_description" }, 400)
    const position = normalizeBoardPosition(body.position)
    if (position === null) return c.json({ error: "invalid_position" }, 400)
    const card = deps.store.createBoardCard({ id, columnID, title, description: description ?? "", position })
    if (!card) return c.json({ error: "column_not_found" }, 404)
    // Owning workspace for the frame.
    const workspaceID = boardWorkspaceOfColumn(card.columnID)
    if (workspaceID) emitBoardUpdated(workspaceID)
    return c.json({ card }, 201)
  })

  api.patch("/board/cards/:id", async (c) => {
    const id = c.req.param("id")
    let body: { title?: unknown; description?: unknown; columnID?: unknown; position?: unknown }
    try {
      body = (await c.req.json()) as typeof body
    } catch {
      return c.json({ error: "invalid_body" }, 400)
    }
    if (body.title === undefined && body.description === undefined && body.columnID === undefined && body.position === undefined) {
      return c.json({ error: "invalid_body" }, 400)
    }
    const patch: { title?: string; description?: string; columnID?: string; position?: number } = {}
    if (body.title !== undefined) {
      const title = normalizeBoardTitle(body.title)
      if (!title) return c.json({ error: "invalid_title" }, 400)
      patch.title = title
    }
    if (body.description !== undefined) {
      const description = normalizeBoardDescription(body.description)
      if (description === null) return c.json({ error: "invalid_description" }, 400)
      patch.description = description
    }
    if (body.columnID !== undefined) {
      const columnID = normalizeBoardID(body.columnID)
      if (!columnID) return c.json({ error: "invalid_column" }, 400)
      patch.columnID = columnID
    }
    if (body.position !== undefined) {
      const position = normalizeBoardPosition(body.position)
      if (position === null || position === undefined) return c.json({ error: "invalid_position" }, 400)
      patch.position = position
    }
    // One board per workspace: a card cannot move into another workspace's
    // column. Rejected here (409) so the source board never loses the card
    // silently; the store re-checks the same invariant as a fallback.
    if (patch.columnID) {
      const target = deps.store.getBoardColumn(patch.columnID)
      if (!target) return c.json({ error: "column_not_found" }, 404)
      const current = deps.store.getBoardCard(id)
      if (current) {
        const source = deps.store.getBoardColumn(current.columnID)
        if (source && source.workspaceID !== target.workspaceID) {
          return c.json({ error: "column_workspace_mismatch" }, 409)
        }
      }
    }
    const card = deps.store.updateBoardCard(id, patch)
    if (!card) {
      // Distinguish an unknown card from an unknown target column.
      if (patch.columnID) {
        const target = deps.store.getBoardColumn(patch.columnID)
        if (!target) return c.json({ error: "column_not_found" }, 404)
        const current = deps.store.getBoardCard(id)
        if (current) {
          const source = deps.store.getBoardColumn(current.columnID)
          if (source && source.workspaceID !== target.workspaceID) {
            return c.json({ error: "column_workspace_mismatch" }, 409)
          }
        }
        return c.json({ error: "card_not_found" }, 404)
      }
      return c.json({ error: "card_not_found" }, 404)
    }
    const workspaceID = boardWorkspaceOfColumn(card.columnID)
    if (workspaceID) emitBoardUpdated(workspaceID)
    return c.json({ card })
  })

  api.delete("/board/cards/:id", (c) => {
    const id = c.req.param("id")
    const workspaceID = boardWorkspaceOfCard(id)
    deps.store.deleteBoardCard(id)
    if (workspaceID) emitBoardUpdated(workspaceID)
    return c.json({ ok: true })
  })

  /**
   * Scheduled tasks (issue #147). The routes are the trust boundary: they
   * validate the task input and the schedule (the model is checked against
   * the opencode catalog, like the goal settings route) and persist through
   * the store. The fire path, event settlement and slot math are exclusively
   * the manager's, so clients follow changes through `scheduler.updated`
   * frames (same synthetic shape as `goal.updated`).
   */
  function schedulerFailure(c: Context, error: unknown): Response {
    // Storage is infrastructure, not a scheduler failure: app.onError answers
    // the shared 503 storage_unavailable (docs/past-mistakes.md rule 14).
    if (isStorageError(error)) throw error
    if (error instanceof SchedulerError) return c.json({ error: error.code, detail: error.message }, error.status)
    if (error instanceof OpencodeTimeoutError) return c.json({ error: "opencode_timeout" }, 504)
    return c.json({ error: "scheduler_failed", detail: error instanceof Error ? error.message : undefined }, 502)
  }

  function emitSchedulerUpdated(taskID: string): void {
    try {
      deps.hub.emit({ type: "scheduler.updated", data: { taskID } })
    } catch {
      // best effort: the mutation already applied
    }
  }

  /** Only directories MasterHand manages (a workspace path) can be targeted. */
  function validSchedulerDirectory(directory: string): boolean {
    return Boolean(deps.store.getWorkspaceByPath(directory))
  }

  function unknownDirectory(): SchedulerError {
    return new SchedulerError("invalid_directory", 400, "the task directory must be an existing workspace path")
  }

  /** The persisted shape of an already-validated spec (extra keys dropped). */
  function schedulerSpec(input: unknown): ScheduleSpec {
    const raw = (input ?? null) as Record<string, unknown> | null
    return raw?.kind === "interval"
      ? { kind: "interval", intervalMinutes: raw.intervalMinutes as number }
      : { kind: "cron", cron: (raw?.cron ?? "") as string }
  }

  api.get("/scheduled-tasks", (c) => c.json({ tasks: deps.store.listScheduledTasks() }))

  api.post("/scheduled-tasks", async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "invalid_body" }, 400)
    }
    try {
      const input = body as Record<string, unknown>
      const validated = validateTaskInput(body)
      if (!validSchedulerDirectory(validated.directory)) throw unknownDirectory()
      const timezone = typeof input.timezone === "string" ? input.timezone.trim() : ""
      validateScheduleSpec(input.schedule, Date.now(), timezone)
      const spec = schedulerSpec(input.schedule)
      // Fail closed: an unanswerable catalog check cannot accept the model.
      if (!(await schedulerOpencode.modelExists?.(validated.model))) {
        throw new SchedulerError(
          "invalid_model",
          400,
          `the model is not in the opencode catalog: ${validated.model.providerID}/${validated.model.id}`,
        )
      }
      const nowMs = Date.now()
      const task: ScheduledTask = {
        id: randomUUID(),
        name: validated.name,
        prompt: validated.prompt,
        model: validated.model,
        schedule: spec,
        timezone,
        directory: validated.directory,
        paused: false,
        lastRunAt: null,
        nextRunAt: nextScheduledRunAt(spec, nowMs, nowMs, timezone),
        createdAt: new Date(nowMs).toISOString(),
      }
      deps.store.createScheduledTask(task)
      emitSchedulerUpdated(task.id)
      return c.json({ task }, 201)
    } catch (error) {
      return schedulerFailure(c, error)
    }
  })

  api.patch("/scheduled-tasks/:id", async (c) => {
    const id = c.req.param("id")
    const existing = deps.store.getScheduledTask(id)
    if (!existing) return c.json({ error: "task_not_found" }, 404)
    let body: Record<string, unknown>
    try {
      body = (await c.req.json()) as Record<string, unknown>
    } catch {
      return c.json({ error: "invalid_body" }, 400)
    }
    try {
      const touchesTask = ["name", "prompt", "model", "directory"].some((key) => body[key] !== undefined)
      const touchesSchedule = body.schedule !== undefined || body.timezone !== undefined
      if (!touchesTask && !touchesSchedule && body.paused === undefined) {
        throw new SchedulerError("invalid_body", 400, "no patchable field was provided")
      }
      if (body.paused !== undefined && typeof body.paused !== "boolean") {
        throw new SchedulerError("invalid_paused", 400, "the paused flag must be a boolean")
      }
      let timezone = existing.timezone
      if (body.timezone !== undefined) {
        if (typeof body.timezone !== "string") {
          throw new SchedulerError(
            "invalid_timezone",
            400,
            "the timezone must be an IANA name, or empty for the server default",
          )
        }
        timezone = body.timezone.trim()
      }
      // The merged record is validated wholesale (same rules as the create)
      // so a partial patch can never persist an inconsistent task.
      let validated: ReturnType<typeof validateTaskInput> | null = null
      if (touchesTask) {
        validated = validateTaskInput({
          name: body.name !== undefined ? body.name : existing.name,
          prompt: body.prompt !== undefined ? body.prompt : existing.prompt,
          model: body.model !== undefined ? body.model : existing.model,
          directory: body.directory !== undefined ? body.directory : existing.directory,
        })
        if (!validSchedulerDirectory(validated.directory)) throw unknownDirectory()
        if (!(await schedulerOpencode.modelExists?.(validated.model))) {
          throw new SchedulerError(
            "invalid_model",
            400,
            `the model is not in the opencode catalog: ${validated.model.providerID}/${validated.model.id}`,
          )
        }
      }
      if (touchesSchedule) {
        const mergedSchedule = body.schedule !== undefined ? body.schedule : existing.schedule
        validateScheduleSpec(mergedSchedule, Date.now(), timezone)
      }
      // Only a schedule/timezone change re-arms the cadence; anything else
      // keeps the pending slot (resuming recomputes it manager-side).
      // Only fields present in the body are sent. The manager re-reads the
      // live task inside the per-task chain, so a fire (lastRunAt/nextRunAt) or
      // a pause that landed while this route awaited the model catalog is
      // never overwritten by the snapshot read above.
      const patch: SchedulerTaskPatch = {}
      if (validated) {
        if (body.name !== undefined) patch.name = validated.name
        if (body.prompt !== undefined) patch.prompt = validated.prompt
        if (body.model !== undefined) patch.model = validated.model
        if (body.directory !== undefined) patch.directory = validated.directory
      }
      if (touchesSchedule) {
        const spec =
          body.schedule !== undefined ? schedulerSpec(body.schedule) : existing.schedule
        const nowMs = Date.now()
        patch.nextRunAt = nextScheduledRunAt(spec, nowMs, nowMs, timezone)
        if (body.schedule !== undefined) patch.schedule = spec
        if (body.timezone !== undefined) patch.timezone = timezone
      }
      const updated = await scheduler.updateTask(id, patch)
      // Deleted while awaiting validation: answer 404 instead of resurrecting.
      if (!updated) return c.json({ error: "task_not_found" }, 404)
      // Pause/resume ride the manager so the flag change is serialized with
      // any transition in progress (one chain per task id).
      if (body.paused === true) return c.json({ task: await scheduler.pauseTask(id) })
      if (body.paused === false) return c.json({ task: await scheduler.resumeTask(id) })
      return c.json({ task: deps.store.getScheduledTask(id) ?? updated })
    } catch (error) {
      return schedulerFailure(c, error)
    }
  })

  api.delete("/scheduled-tasks/:id", (c) => {
    const id = c.req.param("id")
    if (!deps.store.getScheduledTask(id)) return c.json({ error: "task_not_found" }, 404)
    // Idempotent store delete cascading the run history; the frame lets
    // clients drop the task from their lists.
    deps.store.deleteScheduledTask(id)
    emitSchedulerUpdated(id)
    return c.body(null, 204)
  })

  /** Manual fire through the manager (serialized, single slot per task). */
  api.post("/scheduled-tasks/:id/run", async (c) => {
    const id = c.req.param("id")
    try {
      await scheduler.taskRunNow(id)
    } catch (error) {
      return schedulerFailure(c, error)
    }
    const task = deps.store.getScheduledTask(id)
    if (!task) return c.json({ error: "task_not_found" }, 404)
    return c.json({ task }, 202)
  })

  api.get("/scheduled-tasks/:id/runs", (c) => {
    const id = c.req.param("id")
    if (!deps.store.getScheduledTask(id)) return c.json({ error: "task_not_found" }, 404)
    // The store already orders newest-first; the cap bounds the response.
    return c.json({ runs: deps.store.listScheduledRuns(id).slice(0, 50) })
  })

  app.route("/api", api)
  // Exposed for index.ts boot/shutdown wiring (reconcile/stop/flush) without
  // widening createApp's return shape; tests inject managers like `goals`.
  ;(app as AppWithScheduler).scheduler = scheduler
  ;(app as AppWithScheduler).goals = goals

  return app
}

export { SESSION_COOKIE }
