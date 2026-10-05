import { OpenCode } from "@opencode/client"
import type { Permission, PermissionResponse } from "./types"
import type {
  AgentInfo,
  AuditEvent,
  BffStatus,
  ChatMessage,
  CreateSessionInput,
  CreateWorkspaceInput,
  DeviceLoginResponse,
  DeviceRecord,
  FinishSessionResult,
  FormAnswer,
  FormDetail,
  FormInfo,
  ModelsCatalog,
  Permission as PermissionType,
  PreviewStatus,
  PromptContext,
  PromptInput,
  RunCandidate,
  RunCommandInput,
  RunStatus,
  Session,
  SessionStatuses,
  SlashCommand,
  WorkspaceRecord,
  WorkspaceRunConfig,
} from "./types"
import { toChatMessage } from "./chat"
import { createEventStream, type EventStream, type EventStreamOptions } from "./events"

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = "ApiError"
  }
}

/** A request that stalled past the client deadline (see `ClientOptions.timeoutMs`). */
export class RequestTimeoutError extends Error {
  constructor(message = "Request timed out") {
    super(message)
    this.name = "RequestTimeoutError"
  }
}

export interface ClientOptions {
  /** Base server URL (e.g. "https://masterhand.example.com"). Empty means same-origin. */
  baseUrl?: string
  /** Returns a device Bearer token. Omit it on web/desktop to use the session cookie. */
  getToken?: () => string | null | Promise<string | null>
  /** Called when a request fails with 401. */
  onUnauthorized?: () => void
  fetchImpl?: typeof fetch
  /**
   * Aborts requests that stall for longer than this, so a hung socket (paused
   * or unreachable server, lost mobile network) rejects instead of latching
   * the UI forever. `0` disables the deadline.
   */
  timeoutMs?: number
}

export interface Client {
  readonly baseUrl: string
  auth: {
    login(password: string): Promise<void>
    logout(): Promise<void>
    loginDevice(password: string, name: string): Promise<DeviceLoginResponse>
    status(): Promise<BffStatus>
    devices(): Promise<DeviceRecord[]>
    revokeDevice(id: string): Promise<void>
  }
  api: {
    /**
     * Workspace-scoped session operations. The BFF aggregates the workspace
     * folder and every isolated worktree, annotating each session with its
     * `isolation` (branch/worktree path) when it runs isolated.
     */
    sessions: {
      list(workspaceID: string): Promise<Session[]>
      create(workspaceID: string, input?: CreateSessionInput): Promise<Session>
      remove(workspaceID: string, sessionID: string): Promise<void>
      finish(sessionID: string): Promise<FinishSessionResult>
      /** Directories that may hold sessions for the workspace (base + worktrees). */
      directories(workspaceID: string): Promise<string[]>
    }
    /** Full message history of a session, oldest first (v2 cursor API paginated). */
    messages(sessionID: string): Promise<ChatMessage[]>
    /**
     * Sends a prompt. When `current` is provided, the agent/model are switched
     * first only if they differ (opencode records a message per switch).
     */
    prompt(sessionID: string, input: PromptInput, current?: PromptContext): Promise<void>
    /** Runs a slash command (`/name args`) with the same agent/model switching. */
    runCommand(sessionID: string, input: RunCommandInput, current?: PromptContext): Promise<void>
    /** Forks a session (full context) for a temporary side question. */
    forkSession(sessionID: string, before?: string): Promise<Session>
    /** Deletes a session (used to discard a side-question fork). */
    removeSession(sessionID: string): Promise<void>
    /** Interrupts the running turn; returns whether anything was interrupted. */
    abortSession(sessionID: string): Promise<boolean>
    /** Blocked actions (denied commands) kept for diagnosis, newest first. */
    audit(limit?: number): Promise<AuditEvent[]>
    clearAudit(): Promise<void>
    /** Pending permission requests, optionally scoped to a location. */
    permissions(directory?: string | null): Promise<Permission[]>
    respondPermission(
      sessionID: string,
      permissionID: string,
      response: PermissionResponse,
    ): Promise<void>
    /**
     * Pending forms of a session (the primitive behind the agent's `question`
     * tool). `form.created` events are not replayed, so the clients reconcile
     * with `pendingForms` when they (re)connect.
     */
    forms(sessionID: string): Promise<FormInfo[]>
    /** One form with its current state (pending / answered / cancelled). */
    form(sessionID: string, formID: string): Promise<FormDetail>
    /** Replies to a form; the agent's turn resumes with the answer. */
    respondForm(sessionID: string, formID: string, answer: FormAnswer): Promise<void>
    /** Cancels a form; opencode reports it back to the agent. */
    cancelForm(sessionID: string, formID: string): Promise<void>
    /** Every pending form of a location (workspace folder or worktree). */
    pendingForms(directory?: string | null): Promise<FormInfo[]>
    agents(): Promise<AgentInfo[]>
    /** Slash commands for a location, with deterministic argument hints. */
    commands(directory?: string | null): Promise<SlashCommand[]>
    /** Models, providers and server default model for the composer selectors. */
    models(): Promise<ModelsCatalog>
    statuses(): Promise<SessionStatuses>
    /** Live preview (Cloudflare quick tunnel) for a session. */
    preview(sessionID: string): Promise<PreviewStatus>
    startPreview(sessionID: string): Promise<PreviewStatus>
    stopPreview(sessionID: string): Promise<void>
    /**
     * Managed dev-server lifecycle: MasterHand starts the workspace's run
     * command (argv, `{port}` replaced) and stops that exact process, so the
     * agent never kills servers itself.
     */
    run(workspaceID: string): Promise<WorkspaceRunConfig | null>
    saveRun(
      workspaceID: string,
      input: { command: string; args: string[]; cwd?: string | null },
    ): Promise<WorkspaceRunConfig>
    /** Reads the agent-proposed `.masterhand/run.json` (validated, not saved). */
    detectRun(workspaceID: string): Promise<RunCandidate>
    sessionRun(sessionID: string, workspaceID: string): Promise<RunStatus>
    startSessionRun(sessionID: string, workspaceID: string): Promise<RunStatus>
    stopSessionRun(sessionID: string, workspaceID: string): Promise<void>
  }
  workspaces: {
    list(): Promise<WorkspaceRecord[]>
    create(input: CreateWorkspaceInput): Promise<WorkspaceRecord>
    remove(id: string, options?: { deleteFiles?: boolean }): Promise<void>
  }
  eventStream(options: Omit<EventStreamOptions, "baseUrl" | "getToken" | "fetchImpl">): EventStream
}

const MESSAGE_PAGE_SIZE = 200
const MAX_MESSAGE_PAGES = 50

function sameModel(a: PromptContext["model"], b: PromptContext["model"]): boolean {
  if (!a || !b) return false
  return (
    a.id === b.id &&
    a.providerID === b.providerID &&
    (a.variant ?? undefined) === (b.variant ?? undefined)
  )
}

/** Absolute origin the generated opencode client needs; empty baseUrl means same-origin. */
function resolveOrigin(baseUrl: string): string {
  if (baseUrl) return baseUrl
  const location = (globalThis as { location?: { origin?: string } }).location
  return location?.origin ?? "http://localhost"
}

export function createClient(options: ClientOptions = {}): Client {
  const baseUrl = (options.baseUrl ?? "").replace(/\/+$/, "")
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 30_000

  /**
   * Every request is bounded: a stalled socket (paused container, lost
   * network, suspended host) rejects with `RequestTimeoutError` instead of
   * hanging forever — which used to latch the composer's `sending` state.
   */
  async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    if (timeoutMs <= 0) return fetchImpl(input, init)
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    const external = init.signal
    const forwardAbort = () => controller.abort()
    if (external) {
      if (external.aborted) controller.abort()
      else external.addEventListener("abort", forwardAbort, { once: true })
    }
    try {
      return await fetchImpl(input, { ...init, signal: controller.signal })
    } catch (error) {
      if (timedOut) throw new RequestTimeoutError()
      throw error
    } finally {
      clearTimeout(timer)
      external?.removeEventListener("abort", forwardAbort)
    }
  }

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers)
    if (init.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json")
    }
    const token = await options.getToken?.()
    if (token) headers.set("authorization", `Bearer ${token}`)

    const response = await fetchWithTimeout(`${baseUrl}${path}`, { ...init, headers, credentials: "same-origin" })
    if (!response.ok) {
      if (response.status === 401) options.onUnauthorized?.()
      const text = await response.text().catch(() => "")
      throw new ApiError(response.status, text || `HTTP ${response.status}`)
    }
    if (response.status === 204) return undefined as T
    return (await response.json()) as T
  }

  /**
   * Fetch used by the generated opencode client: injects the device token,
   * keeps same-origin cookies and normalizes failures into `ApiError` (so the
   * UI's 401 handling matches the BFF calls).
   */
  const authedFetch: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers)
    const token = await options.getToken?.()
    if (token) headers.set("authorization", `Bearer ${token}`)
    const response = await fetchWithTimeout(input, { ...init, headers, credentials: "same-origin" })
    if (!response.ok) {
      if (response.status === 401) options.onUnauthorized?.()
      const text = await response.text().catch(() => "")
      throw new ApiError(response.status, text || `HTTP ${response.status}`)
    }
    return response
  }

  const opencode = OpenCode.make({
    baseUrl: `${resolveOrigin(baseUrl)}/api/oc/`,
    fetch: authedFetch,
  })

  /**
   * The generated client wraps everything `fetch` throws (including our
   * `ApiError` and `RequestTimeoutError`) in its own transport error. Unwrap
   * it so callers keep the typed error contract used across the BFF calls.
   */
  async function opencodeRequest<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call()
    } catch (error) {
      const cause = (error as { cause?: unknown } | null)?.cause
      if (cause instanceof ApiError || cause instanceof RequestTimeoutError) throw cause
      throw error
    }
  }

  async function listAllMessages(sessionID: string): Promise<ChatMessage[]> {
    const messages: ChatMessage[] = []
    let cursor: string | undefined
    for (let page = 0; page < MAX_MESSAGE_PAGES; page++) {
      // opencode rejects combining `order` with a cursor: it is only for the
      // first page, and the pages that follow keep that order (verified against
      // a live 2.0.21 server). Newest first, so hitting the page cap drops old
      // history — never the messages being read.
      const response = await opencode.message.list(
        cursor
          ? { sessionID, limit: MESSAGE_PAGE_SIZE, cursor }
          : { sessionID, order: "desc", limit: MESSAGE_PAGE_SIZE },
      )
      for (const message of response.data) {
        const chat = toChatMessage(message, sessionID)
        if (chat) messages.push(chat)
      }
      const next = response.cursor.next
      if (!next) break
      cursor = next
    }
    // The UI and the streaming reducers expect chronological order.
    return messages.reverse()
  }

  /**
   * Switches the session's agent/model only when they differ from `current`:
   * every switch records a `*-switched` message in the history.
   */
  async function applyContext(
    sessionID: string,
    agent: string | undefined,
    model: PromptContext["model"],
    current?: PromptContext,
  ): Promise<void> {
    if (agent && agent !== current?.agent) {
      await opencode.session.switchAgent({ sessionID, agent })
    }
    if (model && !sameModel(model, current?.model)) {
      await opencode.session.switchModel({ sessionID, model })
    }
  }

  return {
    baseUrl,
    auth: {
      login: (password) =>
        request<void>("/api/login", { method: "POST", body: JSON.stringify({ password }) }),
      logout: () => request<void>("/api/logout", { method: "POST" }),
      loginDevice: (password, name) =>
        request<DeviceLoginResponse>("/api/devices", {
          method: "POST",
          body: JSON.stringify({ password, name }),
        }),
      status: () => request<BffStatus>("/api/status"),
      devices: () =>
        request<{ devices: DeviceRecord[] }>("/api/devices").then((response) => response.devices),
      revokeDevice: (id) => request<void>(`/api/devices/${encodeURIComponent(id)}`, { method: "DELETE" }),
    },
    api: {
      sessions: {
        list: (workspaceID) =>
          request<{ sessions: Session[] }>(
            `/api/workspaces/${encodeURIComponent(workspaceID)}/sessions`,
          ).then((response) => response.sessions),
        create: (workspaceID, input) =>
          request<{ session: Session }>(`/api/workspaces/${encodeURIComponent(workspaceID)}/sessions`, {
            method: "POST",
            body: JSON.stringify(input ?? {}),
          }).then((response) => response.session),
        remove: (workspaceID, sessionID) =>
          request<void>(
            `/api/workspaces/${encodeURIComponent(workspaceID)}/sessions/${encodeURIComponent(sessionID)}`,
            { method: "DELETE" },
          ),
        finish: (sessionID) =>
          request<FinishSessionResult>(
            `/api/isolated-sessions/${encodeURIComponent(sessionID)}/finish`,
            { method: "POST" },
          ),
        directories: (workspaceID) =>
          request<{ directories: string[] }>(
            `/api/workspaces/${encodeURIComponent(workspaceID)}/directories`,
          ).then((response) => response.directories),
      },
      messages: (sessionID) => listAllMessages(sessionID),
      prompt: (sessionID, input, current) =>
        opencodeRequest(async () => {
          await applyContext(sessionID, input.agent, input.model, current)
          await opencode.session.prompt({
            sessionID,
            text: input.text,
            ...(input.agents && input.agents.length > 0 ? { agents: input.agents } : {}),
            ...(input.metadata ? { metadata: input.metadata } : {}),
          })
        }),
      runCommand: (sessionID, input, current) =>
        opencodeRequest(async () => {
          await applyContext(sessionID, input.agent, input.model, current)
          await opencode.session.command({
            sessionID,
            name: input.name,
            text: input.text,
            ...(input.agents && input.agents.length > 0 ? { agents: input.agents } : {}),
          })
        }),
      forkSession: (sessionID, before) =>
        opencodeRequest(() => opencode.session.fork(before ? { sessionID, before } : { sessionID })),
      removeSession: (sessionID) =>
        opencodeRequest(() => opencode.session.remove({ sessionID })),
      abortSession: (sessionID) =>
        opencodeRequest(() =>
          opencode.session.interrupt({ sessionID }).then((response) => response.interrupted),
        ),
      audit: (limit) =>
        request<{ events: AuditEvent[] }>(`/api/audit${limit ? `?limit=${limit}` : ""}`).then(
          (response) => response.events,
        ),
      clearAudit: () => request<void>("/api/audit", { method: "DELETE" }),
      permissions: (directory) =>
        opencodeRequest(() =>
          opencode.permission.request
            .list(directory ? { location: { directory } } : undefined)
            .then((response) => response.data as PermissionType[]),
        ),
      respondPermission: (sessionID, permissionID, response) =>
        opencodeRequest(() =>
          opencode.permission.reply({ sessionID, requestID: permissionID, decision: response }),
        ),
      forms: (sessionID) => opencodeRequest(() => opencode.session.form.list({ sessionID })),
      form: (sessionID, formID) => opencodeRequest(() => opencode.session.form.get({ sessionID, formID })),
      respondForm: (sessionID, formID, answer) =>
        opencodeRequest(() => opencode.session.form.reply({ sessionID, formID, answer })),
      cancelForm: (sessionID, formID) => opencodeRequest(() => opencode.session.form.cancel({ sessionID, formID })),
      pendingForms: (directory) =>
        opencodeRequest(() =>
          opencode.form.list(directory ? { location: { directory } } : undefined).then((response) => response.data),
        ),
      agents: () =>
        opencodeRequest(() =>
          opencode.agent.list().then((response) => response.data as AgentInfo[]),
        ),
      commands: (directory) =>
        request<{ commands: SlashCommand[] }>(
          `/api/commands${directory ? `?directory=${encodeURIComponent(directory)}` : ""}`,
        ).then((response) => response.commands),
      models: () =>
        opencodeRequest(async () => {
          const [models, providers, defaultModel] = await Promise.all([
            opencode.model.list(),
            opencode.provider.list(),
            opencode.model.default(),
          ])
          return {
            models: models.data,
            providers: providers.data,
            defaultModel: defaultModel.data,
          } satisfies ModelsCatalog
        }),
      statuses: () =>
        opencodeRequest(async () => {
          const active = await opencode.session.active()
          return Object.fromEntries(
            Object.keys(active ?? {}).map((sessionID) => [sessionID, { type: "busy" as const }]),
          ) as SessionStatuses
        }),
      preview: (sessionID) =>
        request<{ preview: PreviewStatus }>(`/api/sessions/${encodeURIComponent(sessionID)}/preview`).then(
          (response) => response.preview,
        ),
      startPreview: (sessionID) =>
        request<{ preview: PreviewStatus }>(`/api/sessions/${encodeURIComponent(sessionID)}/preview`, {
          method: "POST",
        }).then((response) => response.preview),
      stopPreview: (sessionID) =>
        request<void>(`/api/sessions/${encodeURIComponent(sessionID)}/preview`, { method: "DELETE" }),
      run: (workspaceID) =>
        request<{ run: WorkspaceRunConfig | null }>(
          `/api/workspaces/${encodeURIComponent(workspaceID)}/run`,
        ).then((response) => response.run),
      saveRun: (workspaceID, input) =>
        request<{ run: WorkspaceRunConfig }>(`/api/workspaces/${encodeURIComponent(workspaceID)}/run`, {
          method: "PUT",
          body: JSON.stringify(input),
        }).then((response) => response.run),
      detectRun: (workspaceID) =>
        request<{ run: RunCandidate }>(
          `/api/workspaces/${encodeURIComponent(workspaceID)}/run/detect`,
          { method: "POST" },
        ).then((response) => response.run),
      sessionRun: (sessionID, workspaceID) =>
        request<{ run: RunStatus }>(
          `/api/sessions/${encodeURIComponent(sessionID)}/run?workspace=${encodeURIComponent(workspaceID)}`,
        ).then((response) => response.run),
      startSessionRun: (sessionID, workspaceID) =>
        request<{ run: RunStatus }>(
          `/api/sessions/${encodeURIComponent(sessionID)}/run?workspace=${encodeURIComponent(workspaceID)}`,
          { method: "POST" },
        ).then((response) => response.run),
      stopSessionRun: (sessionID, workspaceID) =>
        request<void>(
          `/api/sessions/${encodeURIComponent(sessionID)}/run?workspace=${encodeURIComponent(workspaceID)}`,
          { method: "DELETE" },
        ),
    },
    workspaces: {
      list: () => request<{ workspaces: WorkspaceRecord[] }>("/api/workspaces").then((response) => response.workspaces),
      create: (input) =>
        request<{ workspace: WorkspaceRecord }>("/api/workspaces", {
          method: "POST",
          body: JSON.stringify(input),
        }).then((response) => response.workspace),
      remove: (id, options) =>
        request<void>(
          `/api/workspaces/${encodeURIComponent(id)}${options?.deleteFiles ? "?deleteFiles=1" : ""}`,
          { method: "DELETE" },
        ),
    },
    eventStream: (streamOptions) =>
      createEventStream({
        ...streamOptions,
        baseUrl,
        getToken: options.getToken,
        fetchImpl,
      }),
  }
}
