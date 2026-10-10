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
  /** Internal critic session (null until the first review); openable from the thread. */
  criticSessionID: string | null
  /** Internal judge session (null until the first decision); openable from the thread. */
  judgeSessionID: string | null
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
    criticSessionID: asString(raw.criticSessionID),
    judgeSessionID: asString(raw.judgeSessionID),
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

// ---------------------------------------------------------------------------
// In-message markers (the agents' custom protocol)
// ---------------------------------------------------------------------------

/** A structured block found inside an assistant message. */
export type GoalMarker =
  | { kind: "report"; report: GoalReport }
  | { kind: "critique"; critique: GoalCritique }
  | { kind: "verdict"; verdict: GoalVerdict }

/** One renderable fragment of an assistant message: prose or a marker. */
export type GoalSegment = { kind: "text"; text: string } | GoalMarker

const MARKER_TAGS = ["goal", "critique", "verdict"] as const

const MARKER_PATTERN = new RegExp(
  `<masterhand:(${MARKER_TAGS.join("|")})([^>]*)>([\\s\\S]*?)<\\/masterhand:\\1>`,
  "g",
)

function markerAttribute(attrs: string, name: string): string | null {
  const match = new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(attrs)
  return match?.[1] ?? null
}

function markerJson(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body.trim())
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function markerSegment(tag: string, attrs: string, body: string): GoalMarker | null {
  const data = markerJson(body)
  if (!data) return null
  if (tag === "goal") {
    // The status attribute wins over the JSON body (the instruction documents
    // `<masterhand:goal status="complete|blocked">`).
    const status = markerAttribute(attrs, "status") ?? data.status
    const report = normalizeReport({ ...data, status })
    return report ? { kind: "report", report } : null
  }
  if (tag === "critique") {
    const critique = normalizeCritique(data)
    return critique ? { kind: "critique", critique } : null
  }
  const verdict = normalizeVerdict(data)
  return verdict ? { kind: "verdict", verdict } : null
}

/**
 * Splits an assistant message into renderable segments: prose stays markdown
 * and every `<masterhand:goal|critique|verdict>` block becomes a typed marker,
 * so clients render the protocol as cards instead of raw JSON. Tolerant: a
 * malformed block stays visible as text, and a trailing incomplete block (the
 * tag is still streaming) is hidden instead of flashing as raw JSON.
 */
export function splitGoalMarkers(text: string): GoalSegment[] {
  const segments: GoalSegment[] = []
  let cursor = 0
  MARKER_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = MARKER_PATTERN.exec(text)) !== null) {
    if (match.index > cursor) segments.push({ kind: "text", text: text.slice(cursor, match.index) })
    const parsed = markerSegment(match[1] ?? "", match[2] ?? "", match[3] ?? "")
    segments.push(parsed ?? { kind: "text", text: match[0] })
    cursor = match.index + match[0].length
  }
  let tail = text.slice(cursor)
  const pending = tail.search(/<masterhand:(?:goal|critique|verdict)\b/)
  if (pending >= 0) {
    const afterTag = tail.slice(pending)
    // Hide only a *streaming* marker: the opening tag completed (`>`) but the
    // closing tag has not arrived. A bare name mention without `>` stays
    // visible, so prose that merely names the protocol is never swallowed.
    const opened = afterTag.includes(">")
    const closed = afterTag.includes("</masterhand:")
    if (opened && !closed) tail = tail.slice(0, pending)
  }
  if (tail) segments.push({ kind: "text", text: tail })
  return segments
}

// ---------------------------------------------------------------------------
// Review timeline (the cards integrated in the main session)
// ---------------------------------------------------------------------------

/** One review round ready to render: settled history plus the in-flight round. */
export interface GoalReviewRound {
  round: number
  critique: GoalCritique | null
  verdict: GoalVerdict | null
  /** True for the in-flight round (its review is still being produced). */
  current: boolean
}

function sameCritique(a: GoalCritique | null, b: GoalCritique | null): boolean {
  if (!a || !b) return a === b
  if (a.argument !== b.argument || a.issues.length !== b.issues.length) return false
  return a.issues.every((issue, index) => {
    const other = b.issues[index]
    return (
      other !== undefined &&
      issue.severity === other.severity &&
      issue.claim === other.claim &&
      issue.evidence === other.evidence
    )
  })
}

/**
 * Completed rounds plus the in-flight one. `lastCritique` outlives its round (a
 * rejection keeps it while the next round runs), so it is only attached to the
 * in-flight round when it is not already the critique of the latest settled one.
 */
export function goalReviewRounds(run: GoalRun): GoalReviewRound[] {
  const rounds: GoalReviewRound[] = run.history.map((entry) => ({ ...entry, current: false }))
  const latest = rounds.at(-1)
  if (latest?.round === run.round) return rounds
  const stale = sameCritique(latest?.critique ?? null, run.lastCritique)
  rounds.push({
    round: run.round,
    critique: stale ? null : run.lastCritique,
    verdict: null,
    current: true,
  })
  return rounds
}

/** What the loop is doing right now, for the live review card. */
export function goalActivityLabel(run: GoalRun): string {
  if (run.lastError) return run.lastError
  switch (run.awaitingKind) {
    case "critic":
      return "The critic is challenging the completion claim"
    case "judge":
      return "The judge is deciding"
    case "main":
      return "The main agent is working on the goal"
    default:
      if (run.state === "critiquing") return "The critic is challenging the completion claim"
      if (run.state === "judging") return "The judge is deciding"
      if (run.state === "running") return "The main agent is working on the goal"
      return goalStateLabel(run.state)
  }
}
