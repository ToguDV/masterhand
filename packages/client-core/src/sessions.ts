import type { FinishSessionResult, Session, SessionIsolation } from "./types"

/**
 * Session metadata key opencode persists on sessions MasterHand creates. The
 * session create body accepts `metadata` and returns it from `GET /api/session`
 * (verified against v2.0.21), so a lost create response can be reconciled by
 * marker instead of guessing by time or title.
 */
export const CREATE_MARKER_KEY = "masterhand.create"

/** Unique token attached to one session creation. */
export function createSessionMarker(): string {
  return `session_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

/** Reads the create marker persisted on a session (null for other clients' sessions). */
export function sessionCreateMarker(session: Session): string | null {
  const value = session.metadata?.[CREATE_MARKER_KEY]
  return typeof value === "string" && value.length > 0 ? value : null
}

export type SessionFilter = "all" | "isolated" | "standard"

/** Filters a workspace session list by isolation mode (shared by web/mobile). */
export function filterSessions(sessions: Session[], filter: SessionFilter): Session[] {
  if (filter === "all") return sessions
  return sessions.filter((session) =>
    filter === "isolated" ? Boolean(session.isolation) : !session.isolation,
  )
}

/**
 * Sessions that belong in the session list. Subagent children are linked to
 * their parent through `parentID` and are only reachable from the parent's
 * subagent card, so they never show up as top-level sessions. Forks (used for
 * `/btw` side questions) are temporary and stay out of the list too, and the
 * BFF marks Goal Mode's internal critic/judge sessions (`goalRole`) because the
 * pinned opencode ignores `parentID` on create.
 */
export function rootSessions(sessions: Session[]): Session[] {
  return sessions.filter((session) => !session.parentID && !session.fork && !session.goalRole)
}

/**
 * Rebuilds a `finish` result from the isolated-session record when a lost
 * response is confirmed by it (`pushed`/`prUrl` set by the server). Returns
 * `null` when the record carries no evidence the operation completed, so the
 * UI reports the ambiguity instead of a false success.
 */
export function finishResultFromIsolation(
  isolation: SessionIsolation | null | undefined,
): FinishSessionResult | null {
  if (!isolation || (!isolation.pushed && !isolation.prUrl)) return null
  return {
    committed: true,
    pushed: Boolean(isolation.pushed),
    prUrl: isolation.prUrl ?? null,
    branch: isolation.branch,
    path: isolation.worktreePath,
    error: null,
  }
}
