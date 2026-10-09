/**
 * Goal Mode (`/goal`) shared client contract: the run snapshot rendered by
 * every platform plus tolerant parsing of the `goal.updated` SSE frames the
 * BFF broadcasts. All prompts and the state machine live server-side.
 */

export type GoalState = "running" | "critiquing" | "judging" | "approved" | "paused" | "cancelled" | "error"

/** Which agent inside a goal run is currently expected to answer. */
export type GoalPhase = "main" | "critic" | "judge"

export interface GoalIssue {
  severity: "high" | "medium" | "low"
  claim: string
  evidence: string
}

export interface GoalCritique {
  argument: string
  issues: GoalIssue[]
}

export interface GoalVerdict {
  approved: boolean
  reasoning: string
  requiredChanges: string[]
}

export interface GoalReport {
  status: "complete" | "blocked"
  summary: string
  evidence: string[]
  reason: string | null
}

export interface GoalHistoryEntry {
  round: number
  critique: GoalCritique | null
  verdict: GoalVerdict | null
}

/** Full run state as `GET /api/sessions/:id/goal` returns it. */
export interface GoalRun {
  sessionID: string
  goal: string
  state: GoalState
  round: number
  maxRounds: number
  mainModel: string | null
  criticModel: string | null
  judgeModel: string | null
  lastReport: GoalReport | null
  lastCritique: GoalCritique | null
  lastVerdict: GoalVerdict | null
  history: GoalHistoryEntry[]
  error: string | null
  /** Set while the orchestrator waits on a phase (used to render live activity). */
  awaitingKind: GoalPhase | null
  attempt: number
  /** Transient activity note: retrying, missing marker, provider retry… */
  lastError: string | null
  pausedPhase: GoalPhase | "cap" | null
  createdAt: number
  updatedAt: number
}

export interface GoalSettings {
  maxRounds: number
  criticModel: string | null
  judgeModel: string | null
}

/** A model reference as the composer selects it (variant = reasoning effort). */
export interface GoalModelRef {
  providerID: string
  id: string
  variant?: string | null
}

export const GOAL_EVENT_TYPE = "goal.updated"

const GOAL_STATES: readonly GoalState[] = [
  "running",
  "critiquing",
  "judging",
  "approved",
  "paused",
  "cancelled",
  "error",
]

const ACTIVE_STATES: ReadonlySet<GoalState> = new Set(["running", "critiquing", "judging"])

/** True while the loop is live (working, under review or judging). */
export function isGoalActive(state: GoalState): boolean {
  return ACTIVE_STATES.has(state)
}

/** Short label for the status strip. */
export function goalStateLabel(state: GoalState): string {
  switch (state) {
    case "running":
      return "Working"
    case "critiquing":
      return "Under review"
    case "judging":
      return "Judging"
    case "approved":
      return "Goal approved"
    case "paused":
      return "Paused"
    case "cancelled":
      return "Cancelled"
    case "error":
      return "Failed"
  }
}

/** One-line result of the latest critique/verdict, for the collapsed strip. */
export function goalResultLine(run: GoalRun): string | null {
  if (run.state === "approved") return run.lastVerdict?.reasoning || null
  if (run.lastVerdict && !run.lastVerdict.approved) {
    return run.lastVerdict.requiredChanges[0] ?? run.lastVerdict.reasoning ?? null
  }
  if (run.lastCritique) return run.lastCritique.argument
  return null
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : []
}

function normalizeCritique(value: unknown): GoalCritique | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const argument = asString(raw.argument)
  if (!argument) return null
  const issues = Array.isArray(raw.issues)
    ? raw.issues
        .filter((issue): issue is Record<string, unknown> => Boolean(issue) && typeof issue === "object" && !Array.isArray(issue))
        .map((issue) => {
          const severity = asString(issue.severity)
          return {
            severity: (severity === "high" || severity === "medium" ? severity : "low") as GoalIssue["severity"],
            claim: asString(issue.claim) ?? "unspecified issue",
            evidence: asString(issue.evidence) ?? "",
          }
        })
    : []
  return { argument, issues }
}

function normalizeVerdict(value: unknown): GoalVerdict | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (typeof raw.approved !== "boolean") return null
  return {
    approved: raw.approved,
    reasoning: asString(raw.reasoning) ?? "",
    requiredChanges: asStringArray(raw.requiredChanges),
  }
}

function normalizeReport(value: unknown): GoalReport | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const summary = asString(raw.summary)
  if (!summary) return null
  return {
    status: raw.status === "blocked" ? "blocked" : "complete",
    summary,
    evidence: asStringArray(raw.evidence),
    reason: asString(raw.reason),
  }
}

function normalizeHistory(value: unknown): GoalHistoryEntry[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
    .map((entry) => ({
      round: typeof entry.round === "number" ? entry.round : 0,
      critique: normalizeCritique(entry.critique),
      verdict: normalizeVerdict(entry.verdict),
    }))
}

/** Tolerant run snapshot: an unexpected payload degrades to null, never throws. */
export function normalizeGoalRun(value: unknown): GoalRun | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const sessionID = asString(raw.sessionID)
  const goal = asString(raw.goal)
  if (!sessionID || !goal) return null
  const state = GOAL_STATES.includes(raw.state as GoalState) ? (raw.state as GoalState) : "error"
  const phase = (candidate: unknown): GoalPhase | null =>
    candidate === "main" || candidate === "critic" || candidate === "judge" ? candidate : null
  const pausedPhase = raw.pausedPhase === "cap" ? "cap" : phase(raw.pausedPhase)
  return {
    sessionID,
    goal,
    state,
    round: typeof raw.round === "number" ? raw.round : 1,
    maxRounds: typeof raw.maxRounds === "number" ? raw.maxRounds : 5,
    mainModel: asString(raw.mainModel),
    criticModel: asString(raw.criticModel),
    judgeModel: asString(raw.judgeModel),
    lastReport: normalizeReport(raw.lastReport),
    lastCritique: normalizeCritique(raw.lastCritique),
    lastVerdict: normalizeVerdict(raw.lastVerdict),
    history: normalizeHistory(raw.history),
    error: asString(raw.error),
    awaitingKind: phase(raw.awaitingKind),
    attempt: typeof raw.attempt === "number" ? raw.attempt : 0,
    lastError: asString(raw.lastError),
    pausedPhase,
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
  }
}

/** Parses a `goal.updated` SSE frame; null for any other or malformed event. */
export function goalPayloadOf(event: unknown): { sessionID: string; goal: GoalRun | null } | null {
  if (!event || typeof event !== "object") return null
  if ((event as { type?: unknown }).type !== GOAL_EVENT_TYPE) return null
  const data = (event as { data?: unknown }).data
  if (!data || typeof data !== "object" || Array.isArray(data)) return null
  const sessionID = (data as { sessionID?: unknown }).sessionID
  if (typeof sessionID !== "string" || !sessionID) return null
  const goal = (data as { goal?: unknown }).goal
  // Only an explicit null means "the run is gone"; a malformed or missing
  // payload must never be interpreted as a deletion (it would wipe a live
  // run's cache).
  if (goal === null) return { sessionID, goal: null }
  const run = normalizeGoalRun(goal)
  if (!run) return null
  return { sessionID, goal: run }
}

/** Tolerant settings snapshot. */
export function normalizeGoalSettings(value: unknown): GoalSettings | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  return {
    maxRounds: typeof raw.maxRounds === "number" ? raw.maxRounds : 5,
    criticModel: asString(raw.criticModel),
    judgeModel: asString(raw.judgeModel),
  }
}
