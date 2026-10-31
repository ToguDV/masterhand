export type AgentActivityKind = "finished" | "failed" | "permission" | "question"

/** Device-wide switches for the local agent-activity alerts. */
export interface AgentActivityPreferences {
  finished: boolean
  failed: boolean
  permission: boolean
  question: boolean
}

/** Everything on: enabling notifications is the master switch. */
export const DEFAULT_AGENT_ACTIVITY_PREFERENCES: AgentActivityPreferences = {
  finished: true,
  failed: true,
  permission: true,
  question: true,
}

/**
 * Tolerant decoder for stored preferences: unknown or malformed fields fall
 * back to the default (on) so a missing key never silences an alert.
 */
export function normalizeAgentActivityPreferences(value: unknown): AgentActivityPreferences {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  const pick = (kind: AgentActivityKind): boolean =>
    typeof record[kind] === "boolean"
      ? (record[kind] as boolean)
      : DEFAULT_AGENT_ACTIVITY_PREFERENCES[kind]
  return {
    finished: pick("finished"),
    failed: pick("failed"),
    permission: pick("permission"),
    question: pick("question"),
  }
}

export function agentActivityKindEnabled(
  preferences: AgentActivityPreferences,
  kind: AgentActivityKind,
): boolean {
  return preferences[kind] !== false
}

export interface AgentActivitySession {
  id: string
  title?: string | null
  parentID?: string | null
  fork?: unknown
  goalRole?: "critic" | "judge" | string | null
}

export interface AgentActivityDecision {
  kind: AgentActivityKind
  sessionID: string
  title: string
  permissionID?: string
  formID?: string
}

interface AgentActivityEvent {
  type: string
  data?: {
    sessionID?: string
    id?: string
    requestID?: string
    form?: { id?: string; sessionID?: string; metadata?: { kind?: string } }
  } & Record<string, unknown>
}

interface DecideContext {
  isAppActive: boolean
  wasBusy: boolean
  session?: AgentActivitySession | null
  alreadyNotified?: boolean
}

function isInternal(session?: AgentActivitySession | null): boolean {
  if (!session) return false
  return Boolean(session.parentID ?? session.fork ?? session.goalRole)
}

function displayTitle(session?: AgentActivitySession | null, fallbackID?: string): string {
  const title = typeof session?.title === "string" ? session.title.trim() : ""
  if (title) return title
  return fallbackID ?? "session"
}

/**
 * Pure decision for local agent notifications (no native imports, test-safe).
 * Returns null when nothing should buzz: app in foreground, already-idle
 * session, internal critic/judge/fork, user-interrupted turn or duplicate.
 */
export function decideAgentActivity(
  event: AgentActivityEvent,
  ctx: DecideContext,
): AgentActivityDecision | null {
  if (ctx.isAppActive) return null
  const sessionID =
    (typeof event.data?.sessionID === "string" && event.data.sessionID) ||
    ctx.session?.id ||
    ""
  if (!sessionID) return null
  if (isInternal(ctx.session)) return null

  switch (event.type) {
    case "session.idle":
    case "session.execution.succeeded": {
      if (!ctx.wasBusy) return null
      return { kind: "finished", sessionID, title: displayTitle(ctx.session, sessionID) }
    }
    case "session.execution.failed": {
      return { kind: "failed", sessionID, title: displayTitle(ctx.session, sessionID) }
    }
    case "session.execution.interrupted":
      return null
    case "permission.asked": {
      if (ctx.alreadyNotified) return null
      const permissionID =
        (typeof event.data?.id === "string" && event.data.id) ||
        (typeof event.data?.requestID === "string" && event.data.requestID) ||
        ""
      return {
        kind: "permission",
        sessionID,
        title: displayTitle(ctx.session, sessionID),
        ...(permissionID ? { permissionID } : {}),
      }
    }
    case "form.created": {
      if (ctx.alreadyNotified) return null
      const form = event.data?.form
      const formID = typeof form?.id === "string" ? form.id : ""
      const kind = form?.metadata?.kind
      if (kind && kind !== "question") return null
      return {
        kind: "question",
        sessionID,
        title: displayTitle(ctx.session, sessionID),
        ...(formID ? { formID } : {}),
      }
    }
    default:
      return null
  }
}
