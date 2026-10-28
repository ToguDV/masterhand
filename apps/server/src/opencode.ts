import {
  GOAL_DELIVERY_MARKER_KEY,
  GOAL_INTERNAL_MARKER_KEY,
  GOAL_SESSION_MARKER_KEY,
  type GoalModelRef,
  type GoalOpencode,
  type GoalSessionInfo,
} from "./goal.js"
import { UpstreamStatusError } from "./retry.js"
import { SCHEDULER_MARKER_KEY, type ModelRef, type SchedulerOpencode } from "./scheduler.js"

/**
 * opencode adapters for Goal Mode and the scheduler (issue #205). The two
 * were byte-identical copies in `app.ts` differing only by marker key — and a
 * contract change with upstream already required touching both (the
 * `parentID` quirk), so the next orchestrator would have copied them a third
 * time. The shared primitives below are parameterized by marker key; only
 * `createSession` keeps its own shape per orchestrator (object with
 * `parentID` + role metadata for goals, positional with one key for the
 * scheduler — the `parentID` quirk is load-bearing, never unify them).
 *
 * Every call goes through the injected bounded transport (`callOpencode` in
 * `app.ts`, rule 1): this module builds request bodies and translates HTTP
 * outcomes into thrown typed errors, but owns no timeout or retry policy.
 * The retry policy (bounded backoff, marker reconciliation for
 * non-idempotent calls) lives in the goal/scheduler managers and the shared
 * retry engine.
 */

/** Bounded opencode transport; structurally identical to `callOpencode`. */
export interface OpencodeCallOptions {
  method?: string
  directory?: string | null
  location?: string | null
  body?: unknown
  /** `false` opts out of the default idempotent-method retries (the caller owns the policy). */
  retry?: boolean
  /** Aborts the fetch (e.g. a whole-operation budget owns the deadline). */
  signal?: AbortSignal
}

export type OpencodeCall = (path: string, options?: OpencodeCallOptions) => Promise<Response>

export interface AdapterDeps {
  call: OpencodeCall
  /** Drops the per-directory session aggregation cache after a create/delete. */
  invalidateSessionsCache: () => void
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

/**
 * Create-reconcile lookup, scoped by DIRECTORY: the pinned opencode drops
 * `parentID` on create, so the just-retried create must be found by its
 * marker in session metadata, never by a parent filter. The marker is unique
 * per run/run, and the just-created session is the newest (desc order), so a
 * single page wins.
 */
async function findSessionByMarkerKey(
  call: OpencodeCall,
  markerKey: string,
  directory: string,
  marker: string,
): Promise<{ id: string } | null> {
  const response = await call(`/api/session?directory=${encodeURIComponent(directory)}&limit=200`, {
    retry: false,
  })
  if (!response.ok) throw new UpstreamStatusError(response.status, response)
  const body = (await response.json()) as {
    data?: Array<{ id?: string; metadata?: Record<string, unknown> }>
  }
  const found = (body.data ?? []).find((session) => session.metadata?.[markerKey] === marker)
  return found?.id ? { id: found.id } : null
}

async function promptWithMarker(
  call: OpencodeCall,
  promptMarkerKey: string,
  sessionID: string,
  text: string,
  marker: string,
): Promise<void> {
  const response = await call(`/api/session/${encodeURIComponent(sessionID)}/prompt`, {
    method: "POST",
    body: { text, metadata: { [promptMarkerKey]: marker } },
  })
  if (!response.ok) throw new UpstreamStatusError(response.status, response)
}

async function promptLandedWithMarker(
  call: OpencodeCall,
  promptMarkerKey: string,
  sessionID: string,
  marker: string,
): Promise<boolean> {
  const response = await call(`/api/session/${encodeURIComponent(sessionID)}/message?limit=20&order=desc`, {
    retry: false,
  })
  if (!response.ok) throw new UpstreamStatusError(response.status, response)
  const body = (await response.json()) as {
    data?: Array<{ type?: string; metadata?: Record<string, unknown> }>
  }
  return (body.data ?? []).some(
    (message) => message.type === "user" && message.metadata?.[promptMarkerKey] === marker,
  )
}

async function switchSessionModel(
  call: OpencodeCall,
  sessionID: string,
  model: { id: string; providerID: string; variant?: string | null },
): Promise<void> {
  const body: { id: string; providerID: string; variant?: string } = { id: model.id, providerID: model.providerID }
  if (model.variant) body.variant = model.variant
  const response = await call(`/api/session/${encodeURIComponent(sessionID)}/model`, {
    method: "POST",
    body: { model: body },
  })
  if (!response.ok) throw new UpstreamStatusError(response.status, response)
}

async function listActiveSessions(call: OpencodeCall): Promise<string[]> {
  const response = await call("/api/session/active", { retry: false })
  if (!response.ok) throw new UpstreamStatusError(response.status, response)
  const body = (await response.json()) as { data?: Record<string, unknown> }
  return Object.keys(body.data ?? {})
}

/**
 * opencode adapter for Goal Mode. It translates HTTP outcomes into thrown
 * typed errors; the retry policy (bounded backoff, marker reconciliation for
 * non-idempotent calls) lives in the goal manager / shared retry engine.
 */
export function createGoalOpencode(deps: AdapterDeps): GoalOpencode {
  const { call, invalidateSessionsCache } = deps
  return {
    async sessionInfo(sessionID): Promise<GoalSessionInfo | null> {
      const response = await call(`/api/session/${encodeURIComponent(sessionID)}`, { retry: false })
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
      const response = await call("/api/session", {
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
      // duplicate the internal session.
      return findSessionByMarkerKey(call, GOAL_SESSION_MARKER_KEY, directory, marker)
    },
    async prompt(sessionID, text, marker) {
      return promptWithMarker(call, GOAL_DELIVERY_MARKER_KEY, sessionID, text, marker)
    },
    async promptLanded(sessionID, marker) {
      return promptLandedWithMarker(call, GOAL_DELIVERY_MARKER_KEY, sessionID, marker)
    },
    async writeInstruction(sessionID, key, value) {
      const response = await call(
        `/api/experimental/session/${encodeURIComponent(sessionID)}/instructions/entries/${encodeURIComponent(key)}`,
        { method: "PUT", body: { value }, retry: false },
      )
      if (!response.ok) throw new UpstreamStatusError(response.status, response)
    },
    async removeInstruction(sessionID, key) {
      const response = await call(
        `/api/experimental/session/${encodeURIComponent(sessionID)}/instructions/entries/${encodeURIComponent(key)}`,
        { method: "DELETE", retry: false },
      )
      if (!response.ok && response.status !== 404) throw new UpstreamStatusError(response.status, response)
    },
    async switchModel(sessionID, model: GoalModelRef) {
      return switchSessionModel(call, sessionID, model)
    },
    async switchAgent(sessionID, agent) {
      const response = await call(`/api/session/${encodeURIComponent(sessionID)}/agent`, {
        method: "POST",
        body: { agent },
      })
      if (!response.ok) throw new UpstreamStatusError(response.status, response)
    },
    async interrupt(sessionID) {
      const response = await call(`/api/session/${encodeURIComponent(sessionID)}/interrupt`, {
        method: "POST",
      })
      if (!response.ok) throw new UpstreamStatusError(response.status, response)
    },
    async removeSession(sessionID) {
      const response = await call(`/api/session/${encodeURIComponent(sessionID)}`, {
        method: "DELETE",
        retry: false,
      })
      if (!response.ok && response.status !== 404) throw new UpstreamStatusError(response.status, response)
    },
    async lastAssistant(sessionID) {
      const response = await call(`/api/session/${encodeURIComponent(sessionID)}/message?limit=10&order=desc`, {
        retry: false,
      })
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
      return listActiveSessions(call)
    },
    async models() {
      const response = await call("/api/model", { retry: false })
      if (!response.ok) throw new UpstreamStatusError(response.status, response)
      const body = (await response.json()) as { data?: Array<{ id?: string; providerID?: string }> }
      return (body.data ?? [])
        .filter((model) => Boolean(model.id && model.providerID))
        .map((model) => `${model.providerID}/${model.id}`)
    },
  }
}

/**
 * opencode adapter for the Scheduler (issue #147): the same primitives as
 * Goal Mode with the scheduler's own marker key. Creates and prompts carry
 * `masterhand.scheduler` metadata so a lost response is reconciled against
 * the persisted marker instead of a blind replay; the create lookup is
 * scoped by DIRECTORY because the pinned opencode drops `parentID`.
 */
export function createSchedulerOpencode(deps: AdapterDeps): SchedulerOpencode {
  const { call, invalidateSessionsCache } = deps
  return {
    async createSession(directory, marker, title) {
      const response = await call("/api/session", {
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
      return findSessionByMarkerKey(call, SCHEDULER_MARKER_KEY, directory, marker)
    },
    async prompt(sessionID, text, marker) {
      return promptWithMarker(call, SCHEDULER_MARKER_KEY, sessionID, text, marker)
    },
    async promptLanded(sessionID, marker) {
      return promptLandedWithMarker(call, SCHEDULER_MARKER_KEY, sessionID, marker)
    },
    async switchModel(sessionID, model: ModelRef) {
      return switchSessionModel(call, sessionID, model)
    },
    async activeSessions() {
      // Same upstream call the goal watchdog uses to reconcile lost idle.
      return listActiveSessions(call)
    },
    async deleteSession(sessionID) {
      // Scheduler retention (#197): drop one scheduler-owned session. A
      // missing session (404) counts as pruned; anything else throws so the
      // scheduler logs it and still prunes the row.
      const response = await call(`/api/session/${encodeURIComponent(sessionID)}`, {
        method: "DELETE",
        retry: false,
      })
      if (response.ok || response.status === 404) {
        invalidateSessionsCache()
        return
      }
      throw new UpstreamStatusError(response.status, response)
    },
    async modelExists(model) {
      // Same catalog check the goal settings route's model list uses.
      const response = await call("/api/model", { retry: false })
      if (!response.ok) throw new UpstreamStatusError(response.status, response)
      const body = (await response.json()) as { data?: Array<{ id?: string; providerID?: string }> }
      return (body.data ?? []).some((entry) => entry.providerID === model.providerID && entry.id === model.id)
    },
  }
}
