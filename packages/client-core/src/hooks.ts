import { useCallback, useEffect, useRef, useState } from "react"
import { useQuery, useQueryClient, type QueryClient, type UseQueryResult } from "@tanstack/react-query"
import type { Client } from "./client"
import {
  appendDelta,
  makeToolPart,
  mergeLiveMessages,
  setMessageCost,
  setStreamText,
  updateToolPart,
  upsertToolPart,
} from "./chat"
import { opencodeErrorMessage } from "./errors"
import { goalPayloadOf, type GoalRun } from "./goal"
import type {
  ChatMessage,
  FormInfo,
  Permission,
  PreviewStatus,
  RunStatus,
  SessionStatuses,
  SessionStructuredError,
  V2Event,
} from "./types"

export const queryKeys = {
  status: ["status"] as const,
  sessions: ["sessions"] as const,
  statuses: ["statuses"] as const,
  messages: (sessionID: string) => ["messages", sessionID] as const,
  agents: ["agents"] as const,
  commands: (directory?: string | null) => ["commands", directory ?? null] as const,
  models: ["models"] as const,
  workspaces: ["workspaces"] as const,
  /** Session list scoped to a workspace; `queryKeys.sessions` stays the invalidation prefix. */
  sessionsFor: (workspaceID?: string | null) => ["sessions", workspaceID ?? null] as const,
  /** Directories holding sessions for a workspace (base folder + worktrees). */
  directories: (workspaceID?: string | null) => ["directories", workspaceID ?? null] as const,
  preview: (sessionID: string) => ["preview", sessionID] as const,
  /** Denied commands (audit log), newest first. */
  audit: ["audit"] as const,
  /** Managed dev-server config for a workspace. */
  run: (workspaceID?: string | null) => ["run", workspaceID ?? null] as const,
  /** Managed dev-server state for a session. */
  sessionRun: (sessionID: string) => ["sessionRun", sessionID] as const,
  /** Local git branches of a workspace folder (issue #94). */
  branches: (workspaceID?: string | null) => ["branches", workspaceID ?? null] as const,
  /** Provider integrations and stored credentials (settings, issue #128). */
  integrations: ["integrations"] as const,
  credentials: ["credentials"] as const,
  /** MasterHand-managed OpenAI-compatible providers (settings). */
  customProviders: ["customProviders"] as const,
  /** Goal Mode run state of a session (SSE-driven, see `useGoalRun`). */
  goal: (sessionID: string) => ["goal", sessionID] as const,
  /** Goal review settings (Settings > Goal review). */
  goalSettings: ["goalSettings"] as const,
  /** Web search sources served by opencode (Settings > Web search). */
  websearchSources: ["websearchSources"] as const,
  /** Default web search source stored in MasterHand's config file. */
  websearch: ["websearch"] as const,
}

export function useBffStatus(client: Client, refetchInterval: number | false = false) {
  return useQuery({
    queryKey: queryKeys.status,
    queryFn: () => client.auth.status(),
    retry: false,
    refetchInterval,
  })
}

export function useSessions(
  client: Client,
  enabled: boolean,
  refetchInterval: number | false = 10_000,
  workspaceID?: string | null,
) {
  return useQuery({
    queryKey: queryKeys.sessionsFor(workspaceID),
    queryFn: () => client.api.sessions.list(workspaceID!),
    enabled: enabled && Boolean(workspaceID),
    refetchInterval,
  })
}

export function useSessionDirectories(client: Client, enabled: boolean, workspaceID?: string | null) {
  return useQuery({
    queryKey: queryKeys.directories(workspaceID),
    queryFn: () => client.api.sessions.directories(workspaceID!),
    enabled: enabled && Boolean(workspaceID),
  })
}

export function useWorkspaces(client: Client, enabled = true) {
  return useQuery({
    queryKey: queryKeys.workspaces,
    queryFn: () => client.workspaces.list(),
    enabled,
  })
}

/**
 * Local branches of the workspace folder. Mutations are not auto-retried by
 * the UI; after a timeout the branch state is refetched to reconcile.
 */
export function useBranches(client: Client, enabled: boolean, workspaceID?: string | null) {
  return useQuery({
    queryKey: queryKeys.branches(workspaceID),
    queryFn: () => client.api.branches.list(workspaceID!),
    enabled: enabled && Boolean(workspaceID),
  })
}

export function useSessionStatuses(client: Client, enabled: boolean, connected: boolean) {
  const queryClient = useQueryClient()
  return useQuery({
    queryKey: queryKeys.statuses,
    queryFn: async () => {
      // A poll that starts before an event and resolves after it would erase
      // the status the event just set (e.g. `execution.started` while the
      // request was in flight). Merge instead of replacing.
      const requestedAt = Date.now()
      const snapshot = await client.api.statuses()
      return mergeStatuses(
        queryClient.getQueryData<SessionStatuses>(queryKeys.statuses),
        snapshot,
        statusWritesOf(queryClient),
        requestedAt,
      )
    },
    enabled,
    refetchInterval: connected ? 15_000 : 4_000,
  })
}

export function useMessages(
  client: Client,
  sessionID: string | null,
  options: { connected: boolean; busy: boolean },
) {
  const queryClient = useQueryClient()
  return useQuery({
    queryKey: queryKeys.messages(sessionID ?? ""),
    queryFn: async () => {
      const projected = await client.api.messages(sessionID!)
      const previous = queryClient.getQueryData<ChatMessage[]>(queryKeys.messages(sessionID!))
      // A refetch mid-step must not drop the text already accumulated from
      // events: the projection only carries it once the step closes.
      return mergeLiveMessages(previous, projected)
    },
    enabled: Boolean(sessionID),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchInterval: !options.connected ? 5_000 : options.busy ? 3_000 : false,
  })
}

export function useAgents(client: Client) {
  return useQuery({ queryKey: queryKeys.agents, queryFn: () => client.api.agents(), staleTime: 5 * 60_000 })
}

/**
 * Slash commands for a location (the session's directory). `directory` scopes
 * project-local commands; without it opencode resolves its default location.
 */
export function useCommands(client: Client, directory?: string | null) {
  return useQuery({
    queryKey: queryKeys.commands(directory),
    queryFn: () => client.api.commands(directory),
    staleTime: 5 * 60_000,
  })
}

export function useModels(client: Client) {
  return useQuery({ queryKey: queryKeys.models, queryFn: () => client.api.models(), staleTime: 5 * 60_000 })
}

/**
 * Provider integrations for the settings Providers section (issue #128).
 * `enabled` keeps the request lazy until the panel is open.
 */
export function useIntegrations(client: Client, enabled = true) {
  return useQuery({
    queryKey: queryKeys.integrations,
    queryFn: () => client.api.integrations(),
    enabled,
    staleTime: 60_000,
  })
}

/** Stored credentials, used to disconnect or activate one (#128). */
export function useProviderCredentials(client: Client, enabled = true) {
  return useQuery({
    queryKey: queryKeys.credentials,
    queryFn: () => client.api.credentials(),
    enabled,
    staleTime: 60_000,
  })
}

/** MasterHand-managed OpenAI-compatible providers . */
export function useCustomProviders(client: Client, enabled = true) {
  return useQuery({
    queryKey: queryKeys.customProviders,
    queryFn: () => client.api.customProviders(),
    enabled,
    staleTime: 60_000,
  })
}

/** Web search sources served by opencode (Settings > Web search). */
export function useWebsearchSources(client: Client, enabled = true) {
  return useQuery({
    queryKey: queryKeys.websearchSources,
    queryFn: () => client.api.websearchSources(),
    enabled,
    staleTime: 5 * 60_000,
  })
}

/** Default web search source stored in MasterHand's config file. */
export function useWebsearchSettings(client: Client, enabled = true) {
  return useQuery({
    queryKey: queryKeys.websearch,
    queryFn: () => client.api.websearchSettings(),
    enabled,
    staleTime: 60_000,
  })
}

/** How often a `running` run/preview is re-checked so a dead process surfaces (#89). */
export const RUNNING_POLL_INTERVAL_MS = 5_000
/** `starting` poll interval, bounded by `STARTING_TIMEOUT_MS` (#73). */
export const STARTING_POLL_INTERVAL_MS = 1_500
/** After this long in `starting` the poll stops and the UI shows a timeout. */
export const STARTING_TIMEOUT_MS = 45_000

/**
 * Refetch cadence for a run/preview status: bounded while `starting`, slow
 * while `running` (to notice a process that died), none otherwise.
 */
export function transitionPollInterval(
  status: string | undefined,
  timedOut: boolean,
): number | false {
  if (status === "starting") return timedOut ? false : STARTING_POLL_INTERVAL_MS
  if (status === "running") return RUNNING_POLL_INTERVAL_MS
  return false
}

/** A run/preview query plus its bounded-`starting` state. */
export type TransitionQuery<T> = UseQueryResult<T> & { timedOut: boolean }

/** True once a transition has stayed active past the timeout; resets with it. */
function useBoundedStarting(active: boolean, timeoutMs: number): boolean {
  const [timedOut, setTimedOut] = useState(false)
  useEffect(() => {
    if (!active) {
      setTimedOut(false)
      return
    }
    const timer = setTimeout(() => setTimedOut(true), timeoutMs)
    return () => clearTimeout(timer)
  }, [active, timeoutMs])
  return timedOut
}

export function usePreview(client: Client, sessionID: string | null, enabled = true): TransitionQuery<PreviewStatus> {
  const timedOutRef = useRef(false)
  const query = useQuery({
    queryKey: queryKeys.preview(sessionID ?? ""),
    queryFn: () => client.api.preview(sessionID!),
    enabled: enabled && Boolean(sessionID),
    refetchInterval: (query) => transitionPollInterval(query.state.data?.status, timedOutRef.current),
  })
  const timedOut = useBoundedStarting(query.data?.status === "starting", STARTING_TIMEOUT_MS)
  timedOutRef.current = timedOut
  return { ...query, timedOut }
}

/**
 * Denied commands (audit log). Polled only while a panel is open; the shared
 * event handler invalidates it as soon as a denial arrives.
 */
export function useAudit(client: Client, enabled = true) {
  return useQuery({
    queryKey: queryKeys.audit,
    queryFn: () => client.api.audit(),
    enabled,
    refetchInterval: enabled ? 10_000 : false,
  })
}

/** The workspace's managed run configuration (null until one is saved/detected). */
export function useWorkspaceRun(client: Client, workspaceID?: string | null) {
  return useQuery({
    queryKey: queryKeys.run(workspaceID),
    queryFn: () => client.api.run(workspaceID!),
    enabled: Boolean(workspaceID),
  })
}

/** Live state of a session's managed dev server. */
export function useSessionRun(
  client: Client,
  sessionID: string | null,
  workspaceID?: string | null,
): TransitionQuery<RunStatus> {
  const timedOutRef = useRef(false)
  const query = useQuery({
    queryKey: queryKeys.sessionRun(sessionID ?? ""),
    queryFn: () => client.api.sessionRun(sessionID!, workspaceID!),
    enabled: Boolean(sessionID) && Boolean(workspaceID),
    refetchInterval: (query) => transitionPollInterval(query.state.data?.status, timedOutRef.current),
  })
  const timedOut = useBoundedStarting(query.data?.status === "starting", STARTING_TIMEOUT_MS)
  timedOutRef.current = timedOut
  return { ...query, timedOut }
}

/**
 * Timestamp of the last event-driven goal write per session: the status query
 * uses it to tell whether its snapshot may be older than a `goal.updated`
 * frame that arrived while the request was in flight.
 */
const goalWriteTimes = new WeakMap<QueryClient, Map<string, number>>()

function goalWritesOf(queryClient: QueryClient): Map<string, number> {
  let times = goalWriteTimes.get(queryClient)
  if (!times) {
    times = new Map()
    goalWriteTimes.set(queryClient, times)
  }
  return times
}

/**
 * Goal Mode run state. SSE-driven (`goal.updated` frames update the cache);
 * the query only reconciles on reconnect and after mutations, so it never
 * polls on its own.
 */
export function useGoalRun(client: Client, sessionID: string | null, enabled = true) {
  const queryClient = useQueryClient()
  return useQuery({
    queryKey: queryKeys.goal(sessionID ?? ""),
    queryFn: async () => {
      const requestedAt = Date.now()
      const snapshot = await client.api.goal.status(sessionID!)
      // A frame that arrived while the fetch was in flight beats the snapshot
      // (including a `goal: null` deletion — cached null must not fall back).
      if ((goalWritesOf(queryClient).get(sessionID!) ?? 0) >= requestedAt) {
        const cached = queryClient.getQueryData<GoalRun | null>(queryKeys.goal(sessionID!))
        return cached !== undefined ? cached : snapshot
      }
      return snapshot
    },
    enabled: enabled && Boolean(sessionID),
  })
}

/** Goal review settings (critic/judge models, round budget). */
export function useGoalSettings(client: Client, enabled = true) {
  return useQuery({
    queryKey: queryKeys.goalSettings,
    queryFn: () => client.api.goal.settings(),
    enabled,
  })
}

export interface EventHandlerCallbacks {
  onPermission?: (permission: Permission) => void
  onPermissionReplied?: (permissionID: string) => void
  /** A form was created (the agent's `question` tool is waiting for input). */
  onForm?: (form: FormInfo) => void
  /** A form was replied to or cancelled, on this or another device. */
  onFormSettled?: (formID: string) => void
  onSessionError?: (message: string) => void
  /** opencode (re)connected upstream: reconcile state that SSE never replays. */
  onServerConnected?: () => void
}

function parseRawInput(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/**
 * Timestamp of the last event-driven status write per session. The statuses
 * poll uses it to tell whether its snapshot may be older than a status an
 * event set while the request was in flight.
 */
const statusWriteTimes = new WeakMap<QueryClient, Map<string, number>>()

function statusWritesOf(queryClient: QueryClient): Map<string, number> {
  let times = statusWriteTimes.get(queryClient)
  if (!times) {
    times = new Map()
    statusWriteTimes.set(queryClient, times)
  }
  return times
}

/**
 * Merges the server's active-session snapshot into the event-driven cache. A
 * status set by an event at/after `requestedAt` (when the poll started) wins
 * over the snapshot, because the two raced; any other status missing from the
 * snapshot is idle and gets dropped.
 */
export function mergeStatuses(
  previous: SessionStatuses | undefined,
  snapshot: SessionStatuses,
  eventTimes: ReadonlyMap<string, number>,
  requestedAt: number,
): SessionStatuses {
  const merged: SessionStatuses = {}
  for (const [sessionID, status] of Object.entries(previous ?? {})) {
    if (sessionID in snapshot) continue
    if ((eventTimes.get(sessionID) ?? 0) >= requestedAt) merged[sessionID] = status
  }
  return { ...merged, ...snapshot }
}

/** Applies an opencode v2 event to the TanStack Query cache. Shared by every platform. */
export function createEventHandler(
  queryClient: QueryClient,
  callbacks: EventHandlerCallbacks = {},
): (event: unknown) => void {
  // opencode emits one catalog event per location when it hot-reloads its
  // config; coalesce the burst into a single trailing refetch (each new event
  // restarts the window).
  let catalogRefreshTimer: ReturnType<typeof setTimeout> | null = null
  const refreshCatalogs = () => {
    if (catalogRefreshTimer !== null) clearTimeout(catalogRefreshTimer)
    catalogRefreshTimer = setTimeout(() => {
      catalogRefreshTimer = null
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents })
      void queryClient.invalidateQueries({ queryKey: queryKeys.models })
      void queryClient.invalidateQueries({ queryKey: ["commands"] })
    }, 250)
  }

  return (raw) => {
    if (!raw || typeof raw !== "object") return
    const type = (raw as { type?: unknown }).type
    if (type === "hub.connected" || type === "hub.disconnected") {
      // Synthetic frame from the BFF hub: it gained/lost its upstream
      // connection. Refresh the health status now instead of waiting for the
      // next poll so the status indicator reacts immediately.
      void queryClient.invalidateQueries({ queryKey: queryKeys.status })
      return
    }
    // Goal Mode frames are BFF-synthesized with the full run payload: write
    // them straight into the cache (stamped so an in-flight fetch cannot
    // overwrite them with a stale snapshot).
    const goalPayload = goalPayloadOf(raw)
    if (goalPayload) {
      goalWritesOf(queryClient).set(goalPayload.sessionID, Date.now())
      queryClient.setQueryData<GoalRun | null>(queryKeys.goal(goalPayload.sessionID), goalPayload.goal)
      return
    }
    const event = raw as V2Event
    // Single timestamp per event: the tool cases stamp live timing with it.
    const eventNow = Date.now()

    const setStatus = (sessionID: string, status: SessionStatuses[string]) => {
      statusWritesOf(queryClient).set(sessionID, Date.now())
      queryClient.setQueryData<SessionStatuses>(queryKeys.statuses, (prev) => ({
        ...(prev ?? {}),
        [sessionID]: status,
      }))
    }
    const updateMessages = (sessionID: string, updater: (list: ChatMessage[]) => ChatMessage[]) => {
      queryClient.setQueryData<ChatMessage[]>(queryKeys.messages(sessionID), (prev) =>
        prev ? updater(prev) : prev,
      )
    }

    switch (event.type) {
      case "server.connected":
        // opencode (re)connected upstream. The BFF hub keeps the downstream
        // stream open while it retries, so a page loaded during the outage
        // (e.g. a dev-server restart) keeps failed agent/model catalogs and
        // messages until it is reloaded. This event is the recovery signal.
        invalidateOnReconnect(queryClient)
        callbacks.onServerConnected?.()
        return
      case "agent.updated":
      case "model.updated":
      case "provider.updated":
      case "command.updated":
      case "config.updated":
      case "models-dev.refreshed":
        // opencode hot-reloaded its catalog (config edits, models.dev refresh).
        refreshCatalogs()
        return
      case "permission.asked":
        callbacks.onPermission?.(event.data as Permission)
        return
      case "permission.replied":
        callbacks.onPermissionReplied?.(event.data.requestID)
        return
      case "form.created":
        callbacks.onForm?.(event.data.form as FormInfo)
        return
      case "form.replied":
      case "form.cancelled":
        callbacks.onFormSettled?.(event.data.id)
        return
      case "session.created":
      case "session.renamed":
      case "session.metadata.updated":
      case "session.deleted":
      case "session.agent.selected":
      case "session.model.selected":
      case "session.permissions":
        void queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
        return
      case "session.status":
        setStatus(event.data.sessionID, event.data.status)
        return
      case "session.idle":
        setStatus(event.data.sessionID, { type: "idle" })
        void queryClient.invalidateQueries({ queryKey: queryKeys.messages(event.data.sessionID) })
        return
      case "session.execution.started":
        setStatus(event.data.sessionID, { type: "busy" })
        void queryClient.invalidateQueries({ queryKey: queryKeys.messages(event.data.sessionID) })
        return
      case "session.execution.succeeded":
      case "session.execution.interrupted":
        setStatus(event.data.sessionID, { type: "idle" })
        void queryClient.invalidateQueries({ queryKey: queryKeys.messages(event.data.sessionID) })
        return
      case "session.execution.failed": {
        setStatus(event.data.sessionID, { type: "idle" })
        const message = opencodeErrorMessage(event.data.error as SessionStructuredError)
        if (message) callbacks.onSessionError?.(message)
        void queryClient.invalidateQueries({ queryKey: queryKeys.messages(event.data.sessionID) })
        return
      }
      case "session.retry.scheduled":
        setStatus(event.data.sessionID, {
          type: "retry",
          attempt: event.data.attempt,
          message: event.data.error.message,
          next: event.data.at,
        })
        return
      case "session.text.delta":
        updateMessages(event.data.sessionID, (list) =>
          appendDelta(list, {
            sessionID: event.data.sessionID,
            messageID: event.data.assistantMessageID,
            ordinal: event.data.ordinal,
            kind: "text",
            delta: event.data.delta,
          }),
        )
        return
      case "session.reasoning.delta":
        updateMessages(event.data.sessionID, (list) =>
          appendDelta(list, {
            sessionID: event.data.sessionID,
            messageID: event.data.assistantMessageID,
            ordinal: event.data.ordinal,
            kind: "reasoning",
            delta: event.data.delta,
          }),
        )
        return
      case "session.text.ended":
        updateMessages(event.data.sessionID, (list) =>
          setStreamText(list, {
            sessionID: event.data.sessionID,
            messageID: event.data.assistantMessageID,
            ordinal: event.data.ordinal,
            kind: "text",
            text: event.data.text,
          }),
        )
        return
      case "session.reasoning.ended":
        updateMessages(event.data.sessionID, (list) =>
          setStreamText(list, {
            sessionID: event.data.sessionID,
            messageID: event.data.assistantMessageID,
            ordinal: event.data.ordinal,
            kind: "reasoning",
            text: event.data.text,
          }),
        )
        return
      case "session.step.ended":
        updateMessages(event.data.sessionID, (list) =>
          setMessageCost(list, event.data.sessionID, event.data.assistantMessageID, {
            cost: event.data.cost,
            tokens: event.data.tokens,
            finish: event.data.finish,
          }),
        )
        return
      case "session.tool.input.started":
        updateMessages(event.data.sessionID, (list) =>
          upsertToolPart(
            list,
            event.data.sessionID,
            event.data.assistantMessageID,
            makeToolPart(event.data.sessionID, event.data.assistantMessageID, event.data.id, event.data.name, {
              status: "pending",
              input: {},
              raw: "",
            }),
          ),
        )
        return
      case "session.tool.input.delta":
        updateMessages(event.data.sessionID, (list) =>
          updateToolPart(
            list,
            event.data.sessionID,
            event.data.assistantMessageID,
            event.data.id,
            (part) => ({ ...part, state: { ...part.state, raw: `${part.state.raw ?? ""}${event.data.delta}` } }),
            (part) => ({ ...part, state: { ...part.state, raw: event.data.delta } }),
          ),
        )
        return
      case "session.tool.input.ended":
        updateMessages(event.data.sessionID, (list) =>
          updateToolPart(
            list,
            event.data.sessionID,
            event.data.assistantMessageID,
            event.data.id,
            (part) => ({
              ...part,
              state: { ...part.state, status: "running", input: parseRawInput(event.data.text), raw: undefined },
            }),
            (part) => ({ ...part, state: { status: "running", input: parseRawInput(event.data.text) } }),
          ),
        )
        return
      case "session.tool.called":
        updateMessages(event.data.sessionID, (list) =>
          updateToolPart(
            list,
            event.data.sessionID,
            event.data.assistantMessageID,
            event.data.id,
            (part) => ({
              ...part,
              state: {
                ...part.state,
                status: "running",
                input: event.data.input,
                timing: {
                  ...part.state.timing,
                  created: part.state.timing?.created ?? eventNow,
                  ran: part.state.timing?.ran ?? eventNow,
                },
              },
            }),
            (part) => ({
              ...part,
              state: { status: "running", input: event.data.input, timing: { created: eventNow, ran: eventNow } },
            }),
            eventNow,
          ),
        )
        return
      case "session.tool.progress":
        updateMessages(event.data.sessionID, (list) =>
          updateToolPart(
            list,
            event.data.sessionID,
            event.data.assistantMessageID,
            event.data.id,
            (part) => ({ ...part, state: { ...part.state, metadata: event.data.metadata } }),
            (part) => ({ ...part, state: { ...part.state, metadata: event.data.metadata } }),
          ),
        )
        return
      case "session.tool.success":
        updateMessages(event.data.sessionID, (list) =>
          updateToolPart(
            list,
            event.data.sessionID,
            event.data.assistantMessageID,
            event.data.id,
            (part) => ({
              ...part,
              state: {
                ...part.state,
                status: "completed",
                output: toolContentText(event.data.content),
                metadata: event.data.metadata,
                timing: { ...part.state.timing, completed: eventNow },
              },
            }),
            (part) => ({
              ...part,
              state: {
                status: "completed",
                input: {},
                output: toolContentText(event.data.content),
                metadata: event.data.metadata,
                timing: { created: eventNow, completed: eventNow },
              },
            }),
            eventNow,
          ),
        )
        return
      case "session.tool.failed": {
        updateMessages(event.data.sessionID, (list) =>
          updateToolPart(
            list,
            event.data.sessionID,
            event.data.assistantMessageID,
            event.data.id,
            (part) => ({
              ...part,
              state: {
                ...part.state,
                status: "error",
                error: event.data.error.message,
                output: toolContentText(event.data.content),
                metadata: event.data.metadata,
                timing: { ...part.state.timing, completed: eventNow },
              },
            }),
            (part) => ({
              ...part,
              state: {
                status: "error",
                input: {},
                error: event.data.error.message,
                output: toolContentText(event.data.content),
                metadata: event.data.metadata,
                timing: { created: eventNow, completed: eventNow },
              },
            }),
            eventNow,
          ),
        )
        // A denied command is also recorded in the BFF audit log; refresh it live.
        const errorType = (event.data.error as { type?: unknown }).type
        if (errorType === "permission.rejected" || /permission denied/i.test(event.data.error.message)) {
          void queryClient.invalidateQueries({ queryKey: queryKeys.audit })
        }
        return
      }
      default:
        return
    }
  }
}

function toolContentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  const lines: string[] = []
  for (const item of content) {
    if (!item || typeof item !== "object") continue
    const entry = item as { type?: unknown; text?: unknown; uri?: unknown; name?: unknown }
    if (entry.type === "text" && typeof entry.text === "string") lines.push(entry.text)
    else if (entry.type === "file" && typeof entry.uri === "string") {
      lines.push(`[${typeof entry.name === "string" && entry.name ? entry.name : entry.uri}] ${entry.uri}`)
    }
  }
  return lines.length > 0 ? lines.join("\n") : undefined
}

/** Invalidates server state after (re)connecting so missed events are reconciled. */
export function invalidateOnReconnect(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
  void queryClient.invalidateQueries({ queryKey: ["messages"] })
  void queryClient.invalidateQueries({ queryKey: queryKeys.statuses })
  void queryClient.invalidateQueries({ queryKey: ["directories"] })
  // Goal runs: `goal.updated` frames are never replayed, so a missed one is
  // reconciled by refetching the run state.
  void queryClient.invalidateQueries({ queryKey: ["goal"] })
  // Catalogs recover on their own too: a page loaded while opencode rejected
  // the BFF credentials would otherwise keep empty composer selectors until a
  // manual reload.
  void queryClient.invalidateQueries({ queryKey: queryKeys.agents })
  void queryClient.invalidateQueries({ queryKey: queryKeys.models })
  void queryClient.invalidateQueries({ queryKey: ["commands"] })
}

export interface UseEventStreamOptions {
  enabled: boolean
  onEvent: (event: unknown) => void
  onConnectionChange?: (connected: boolean) => void
  onConnect?: () => void
}

/** Minimal surface `attachReconnectListeners` needs from a stream. */
interface ReconnectableStream {
  forceReconnect(): void
}

/** The listener pair a DOM target must expose to be wired (and unwired). */
interface EventListenerTarget {
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}

/**
 * Returns `value` only when it is a usable DOM listener target. React Native
 * defines a global `window` that is not one, and has no `document` at all.
 */
function listenerTarget<T>(value: T | null): (T & EventListenerTarget) | null {
  if (value === null) return null
  const target = value as unknown as Partial<EventListenerTarget>
  const usable =
    typeof target.addEventListener === "function" && typeof target.removeEventListener === "function"
  return usable ? (value as T & EventListenerTarget) : null
}

/**
 * Web-only reconnection triggers: `visibilitychange` and `online`.
 *
 * React Native also defines a global `window`, but without the DOM listener
 * API (and no `document` at all), so each target is feature-detected instead of
 * assumed. Native does not need them: it drives the same reconnect through
 * `useEventStream`'s returned handle when the app returns to the foreground.
 * Returns the cleanup. Exported for tests.
 */
export function attachReconnectListeners(stream: ReconnectableStream): () => void {
  const doc = listenerTarget(typeof document === "undefined" ? null : document)
  const win = listenerTarget(typeof window === "undefined" ? null : window)

  const handleVisibility = (): void => {
    if (doc?.visibilityState === "visible") stream.forceReconnect()
  }
  const handleOnline = (): void => stream.forceReconnect()

  doc?.addEventListener("visibilitychange", handleVisibility)
  win?.addEventListener("online", handleOnline)

  return () => {
    doc?.removeEventListener("visibilitychange", handleVisibility)
    win?.removeEventListener("online", handleOnline)
  }
}

/**
 * Reconnecting SSE subscription that also reacts to tab visibility and network
 * changes on web.
 *
 * Returns a stable `forceReconnect` handle for signals the stream cannot see by
 * itself — React Native has no DOM events, so the app calls it when it returns
 * to the foreground.
 */
export function useEventStream(client: Client, options: UseEventStreamOptions): () => void {
  const onEventRef = useRef(options.onEvent)
  onEventRef.current = options.onEvent
  const onConnectionRef = useRef(options.onConnectionChange)
  onConnectionRef.current = options.onConnectionChange
  const onConnectRef = useRef(options.onConnect)
  onConnectRef.current = options.onConnect
  const streamRef = useRef<ReconnectableStream | null>(null)

  useEffect(() => {
    if (!options.enabled) return

    const stream = client.eventStream({
      onEvent: (event) => onEventRef.current(event),
      onConnectionChange: (connected) => onConnectionRef.current?.(connected),
      onConnect: () => onConnectRef.current?.(),
    })
    stream.start()

    // Web only: React Native has no DOM globals to listen to.
    const detachReconnectListeners = attachReconnectListeners(stream)
    streamRef.current = stream

    return () => {
      streamRef.current = null
      detachReconnectListeners()
      stream.stop()
    }
  }, [client, options.enabled])

  return useCallback(() => streamRef.current?.forceReconnect(), [])
}
