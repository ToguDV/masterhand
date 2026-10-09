import { UpstreamStatusError, isTransientFailure, withRetry, type RetryOptions } from "./retry.js"
import {
  DEFAULT_GOAL_MAX_ROUNDS,
  type GoalCritique,
  type GoalPhase,
  type GoalReport,
  type GoalRunRecord,
  type GoalSettingsRecord,
  type GoalVerdict,
  type Store,
} from "./store.js"

/**
 * Goal Mode (`/goal`): a main agent works on a goal, an adversarial critic
 * challenges the claimed completion and an impartial judge decides. The loop
 * repeats until approval or the round cap. This module owns the state machine
 * and every prompt (the clients never build them).
 *
 * Reliability: every opencode call goes through the shared retry engine
 * (`retry.ts`) — idempotent calls retry transient failures directly, and
 * non-idempotent mutations (session create, prompt) reconcile a persisted
 * marker first so a retry can never duplicate them. Phases that fail are
 * re-driven a bounded number of times with incremental delays; when the budget
 * is spent the run lands in a visible, resumable `error`/`paused` state —
 * never stuck. See `docs/past-mistakes.md`.
 */

export const GOAL_INSTRUCTION_KEY = "masterhand.goal"
export const CRITIC_INSTRUCTION_KEY = "masterhand.goal.critic"
export const JUDGE_INSTRUCTION_KEY = "masterhand.goal.judge"

/** Metadata marker attached to every prompt so a lost response can be reconciled. */
export const GOAL_DELIVERY_MARKER_KEY = "masterhand.goal.delivery"
/** Metadata marker attached to internal session creation (create reconciliation). */
export const GOAL_SESSION_MARKER_KEY = "masterhand.goal.role"

export const MAX_GOAL_LENGTH = 4000
/** How many times a failed phase is re-driven before the run errors out. */
export const MAX_PHASE_RETRIES = 3
const PHASE_RETRY_BASE_MS = 2000
const DEFAULT_WATCHDOG_MS = 30_000

export const GOAL_INSTRUCTION = `You are working in MasterHand Goal Mode: a main goal, an adversarial critic and an impartial judge.

Work on the user's goal until it is genuinely complete — implement, verify and finish it; do not stop at a plan or at partial work.

When (and only when) the goal is truly done, the LAST content of your final message must be this completion marker, with real evidence from checks you ran:

<masterhand:goal status="complete">{"summary": "<one-line summary>", "evidence": ["<verifiable check you ran>"]}</masterhand:goal>

If the goal cannot be completed, do not fake it: end your final message with

<masterhand:goal status="blocked">{"summary": "<one-line summary>", "reason": "<what blocks it>"}</masterhand:goal>

The marker is machine-parsed: use the exact tag names and a single JSON object.`

export const CRITIC_INSTRUCTION = `You are MasterHand's adversarial reviewer ("critic") in Goal Mode. Your job is to challenge the main agent's claim of completion and try to falsify it.

Inspect the workspace, read files, and run commands or tests when useful. Be rigorous but fair: raise only material issues (unverified claims, missing tests, broken behavior, incomplete work).

Reply with exactly one critique block as the final content of your message:

<masterhand:critique>{"argument": "<the strongest case against completion>", "issues": [{"severity": "high|medium|low", "claim": "<what is wrong or unverified>", "evidence": "<how you verified it or what is missing>"}]}</masterhand:critique>

If the work is sound, output the same block with an empty "issues" array and say so explicitly in "argument".`

export const JUDGE_INSTRUCTION = `You are the impartial judge in Goal Mode. You receive the goal, the main agent's completion report and the critic's argument.

Judge only from the material provided: do not do the work yourself, do not take sides, and do not invent facts. Approve only when the goal is genuinely complete and every material issue from the critic is resolved (or provably wrong). If you reject, list concrete, actionable required changes.

Reply with exactly one verdict block as the final content of your message:

<masterhand:verdict>{"approved": true, "reasoning": "<why>", "requiredChanges": []}</masterhand:verdict>`

const GOAL_MARKER_NUDGE = `Your turn ended without the completion marker, so the goal is not considered finished. If the goal is genuinely complete, reply now ending your final message with the marker from the goal instructions (<masterhand:goal ...>...</masterhand:goal>). If it is not, keep working and emit the marker only when it is.`

// ---------------------------------------------------------------------------
// Marker parsing (tolerant: surrounding text is allowed, the last block wins)
// ---------------------------------------------------------------------------

interface MarkerBlock {
  attrs: string
  body: string
}

function lastMarkerBlock(text: string, tag: string): MarkerBlock | null {
  const pattern = new RegExp(`<masterhand:${tag}([^>]*)>([\\s\\S]*?)<\\/masterhand:${tag}>`, "g")
  let match: RegExpExecArray | null
  let last: MarkerBlock | null = null
  while ((match = pattern.exec(text)) !== null) {
    last = { attrs: match[1] ?? "", body: match[2] ?? "" }
  }
  return last
}

function markerAttribute(attrs: string, name: string): string | null {
  const match = new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(attrs)
  return match?.[1] ?? null
}

function markerJson(block: MarkerBlock): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(block.body.trim())
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function markerString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null
}

function markerStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim())
    : []
}

/** Completion marker emitted by the main agent; null when absent or malformed. */
export function parseGoalMarker(text: string): GoalReport | null {
  const block = lastMarkerBlock(text, "goal")
  if (!block) return null
  const data = markerJson(block)
  if (!data) return null
  const summary = markerString(data.summary)
  if (!summary) return null
  const status =
    markerAttribute(block.attrs, "status") === "blocked" || data.status === "blocked" ? "blocked" : "complete"
  return { status, summary, evidence: markerStringArray(data.evidence), reason: markerString(data.reason) }
}

/** Critic block; null when absent or malformed. */
export function parseCritique(text: string): GoalCritique | null {
  const block = lastMarkerBlock(text, "critique")
  if (!block) return null
  const data = markerJson(block)
  if (!data) return null
  const argument = markerString(data.argument)
  if (!argument) return null
  const issues = Array.isArray(data.issues)
    ? data.issues
        .map((issue) => (issue && typeof issue === "object" && !Array.isArray(issue) ? (issue as Record<string, unknown>) : null))
        .filter((issue): issue is Record<string, unknown> => issue !== null)
        .map((issue) => {
          const severity = markerString(issue.severity)
          const normalized: GoalCritique["issues"][number]["severity"] =
            severity === "high" || severity === "medium" ? severity : "low"
          return {
            severity: normalized,
            claim: markerString(issue.claim) ?? markerString(issue.evidence) ?? "unspecified issue",
            evidence: markerString(issue.evidence) ?? "",
          }
        })
    : []
  return { argument, issues }
}

/** Judge verdict; null when absent or malformed. */
export function parseVerdict(text: string): GoalVerdict | null {
  const block = lastMarkerBlock(text, "verdict")
  if (!block) return null
  const data = markerJson(block)
  if (!data || typeof data.approved !== "boolean") return null
  return {
    approved: data.approved,
    reasoning: markerString(data.reasoning) ?? "",
    requiredChanges: markerStringArray(data.requiredChanges),
  }
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

/** An expected error the routes translate to a typed HTTP response. */
export class GoalError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 404 | 409 | 502,
    message: string,
  ) {
    super(message)
    this.name = "GoalError"
  }
}

export interface GoalSessionInfo {
  directory: string
  parentID?: string
  model: string | null
}

/**
 * Thin adapter over opencode. The manager owns the loop; app.ts implements
 * this with bounded `callOpencode` calls and tests use a scripted fake.
 */
export interface GoalOpencode {
  sessionInfo(sessionID: string): Promise<GoalSessionInfo | null>
  createSession(input: {
    directory: string
    parentID: string
    title: string
    marker: string
  }): Promise<{ id: string }>
  findSessionByMarker(marker: string): Promise<{ id: string } | null>
  prompt(sessionID: string, text: string, marker: string): Promise<void>
  promptLanded(sessionID: string, marker: string): Promise<boolean>
  writeInstruction(sessionID: string, key: string, value: string): Promise<void>
  removeInstruction(sessionID: string, key: string): Promise<void>
  switchModel(sessionID: string, model: string): Promise<void>
  interrupt(sessionID: string): Promise<void>
  removeSession(sessionID: string): Promise<void>
  lastAssistant(sessionID: string): Promise<{ id: string; text: string } | null>
  activeSessions(): Promise<string[]>
  /** Catalog model refs as `provider/model`. */
  models(): Promise<string[]>
}

export interface GoalEvent {
  type: "goal.updated"
  data: { sessionID: string; goal: GoalRunRecord | null }
}

export interface GoalManagerOptions {
  store: Store
  opencode: GoalOpencode
  emit?: (event: GoalEvent) => void
  now?: () => number
  /** Retry tuning; tests inject an instant sleeper and small delays. */
  retry?: {
    attempts?: number
    baseDelayMs?: number
    jitter?: boolean
    sleep?: (ms: number) => Promise<void>
  }
  /** Watchdog interval for lost events; 0 disables it (tests drive `reconcile`). */
  watchdogMs?: number
  defaultMaxRounds?: number
}

export interface GoalManager {
  start(input: { sessionID: string; goal: string; model?: string | null }): Promise<GoalRunRecord>
  status(sessionID: string): GoalRunRecord | null
  pause(sessionID: string): Promise<GoalRunRecord>
  resume(sessionID: string): Promise<GoalRunRecord>
  cancel(sessionID: string): Promise<GoalRunRecord>
  /** Session deleted (outside MasterHand or through the BFF): drop its run. */
  forget(sessionID: string): Promise<void>
  /** Hub events: idle, execution failed/interrupted, retry scheduled, deletions. */
  handleEvent(event: unknown): void
  /** One watchdog pass over runs awaiting a session that looks idle. */
  reconcile(): Promise<void>
  /** Marks in-flight runs paused after a BFF restart (never auto-resumes). */
  reconcileOnBoot(): void
  /** Waits for every queued transition (tests). */
  flush(): Promise<void>
  stop(): void
  getSettings(): GoalSettingsRecord
  saveSettings(patch: Partial<GoalSettingsRecord>): Promise<GoalSettingsRecord>
}

const TERMINAL_STATES = new Set(["approved", "cancelled"])

function normalizeRef(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return /^[^\s/]+\/[^\s]+$/.test(trimmed) ? trimmed : null
}

function errorMessage(error: unknown): string {
  if (error instanceof UpstreamStatusError) return `opencode answered ${error.status}`
  if (error instanceof Error) return error.message
  return String(error)
}

function retryNote(error: unknown): string {
  if (error instanceof UpstreamStatusError) return `opencode answered ${error.status} — retrying`
  if ((error as { name?: string } | null)?.name === "OpencodeTimeoutError") {
    return "opencode did not respond in time — checking whether the request landed"
  }
  return "opencode unreachable — retrying"
}

function eventData(event: unknown): Record<string, unknown> | null {
  const data = (event as { data?: unknown } | null)?.data
  return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null
}

function eventErrorMessage(data: Record<string, unknown>): string {
  const error = data.error
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const message = (error as { message?: unknown }).message
    if (typeof message === "string" && message.trim()) return message.trim()
  }
  if (typeof error === "string" && error.trim()) return error.trim()
  return "the agent turn failed"
}

const WAKE_EVENTS = new Set([
  "session.idle",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.retry.scheduled",
  "session.status",
  "session.deleted",
])

export function createGoalManager(options: GoalManagerOptions): GoalManager {
  const { store, opencode } = options
  const emit = options.emit ?? (() => {})
  const now = options.now ?? Date.now
  const sleep =
    options.retry?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const retryBase = {
    attempts: options.retry?.attempts ?? 4,
    baseDelayMs: options.retry?.baseDelayMs ?? 250,
    jitter: options.retry?.jitter ?? true,
  }
  const defaultMaxRounds = options.defaultMaxRounds ?? DEFAULT_GOAL_MAX_ROUNDS

  /** Per-run transition queue: events and watchdog passes never interleave. */
  const chains = new Map<string, Promise<void>>()

  function enqueue(sessionID: string, task: () => Promise<void>): Promise<void> {
    const tail = chains.get(sessionID) ?? Promise.resolve()
    const next = tail.then(task).catch((error) => {
      console.error(`[goal] ${sessionID} transition failed:`, error)
    })
    chains.set(sessionID, next)
    void next.finally(() => {
      if (chains.get(sessionID) === next) chains.delete(sessionID)
    })
    return next
  }

  async function flush(): Promise<void> {
    while (chains.size > 0) await Promise.allSettled([...chains.values()])
  }

  function persist(run: GoalRunRecord): void {
    run.updatedAt = now()
    store.saveGoalRun(run)
    emit({ type: "goal.updated", data: { sessionID: run.sessionID, goal: { ...run, history: [...run.history] } } })
  }

  /** One bounded opencode call; `includeTimeouts` only for reconcilable paths. */
  function retryable<T>(
    operation: () => Promise<T>,
    opts: { includeTimeouts?: boolean; reconcile?: (error: unknown) => Promise<T | undefined> | T | undefined; onRetry?: (error: unknown) => void } = {},
  ): Promise<T> {
    return withRetry(operation, {
      ...retryBase,
      sleep,
      shouldRetry: (error) => isTransientFailure(error, { includeTimeouts: opts.includeTimeouts }),
      reconcile: opts.reconcile,
      onRetry: (info) => opts.onRetry?.(info.error),
    })
  }

  function clearAwaiting(run: GoalRunRecord): void {
    run.awaitingKind = null
    run.awaitingSessionID = null
    run.awaitingAssistantID = null
  }

  function fail(run: GoalRunRecord, message: string, phase?: GoalPhase | "cap"): void {
    const fallback = run.awaitingKind ?? run.pausedPhase ?? "main"
    run.pausedPhase = phase ?? (fallback === "cap" ? "cap" : fallback)
    run.state = "error"
    run.error = message
    run.lastError = null
    run.attempt = 0
    clearAwaiting(run)
    persist(run)
  }

  function phaseSessionID(run: GoalRunRecord, kind: GoalPhase): string | null {
    if (kind === "main") return run.sessionID
    return kind === "critic" ? run.criticSessionID : run.judgeSessionID
  }

  /** Prompts the phase session and records the awaiting baseline + marker. */
  async function promptPhase(run: GoalRunRecord, kind: GoalPhase, text: string): Promise<void> {
    const sessionID = phaseSessionID(run, kind)
    if (!sessionID) throw new GoalError("goal_not_active", 409, `no session for phase ${kind}`)
    const baseline = await retryable(() => opencode.lastAssistant(sessionID), { includeTimeouts: true })
    run.promptSerial += 1
    const marker = `goal_${run.sessionID}_${run.promptSerial}`
    run.awaitingKind = kind
    run.awaitingSessionID = sessionID
    run.awaitingAssistantID = baseline?.id ?? null
    run.lastError = null
    persist(run)

    await retryable<boolean>(
      async () => {
        await opencode.prompt(sessionID, text, marker)
        return true
      },
      {
        includeTimeouts: true,
        reconcile: async () => ((await opencode.promptLanded(sessionID, marker)) ? true : undefined),
        onRetry: (error) => {
          const live = store.getGoalRun(run.sessionID)
          if (!live) return
          live.lastError = retryNote(error)
          persist(live)
        },
      },
    )
    const live = store.getGoalRun(run.sessionID)
    if (live && !TERMINAL_STATES.has(live.state)) {
      live.lastError = null
      persist(live)
    }
  }

  async function writeInstruction(run: GoalRunRecord, sessionID: string, key: string, value: string): Promise<void> {
    await retryable(() => opencode.writeInstruction(sessionID, key, value), { includeTimeouts: true })
  }

  async function switchModel(sessionID: string, model: string | null): Promise<void> {
    if (!model) return
    await retryable(() => opencode.switchModel(sessionID, model), { includeTimeouts: true })
  }

  async function removeInstruction(run: GoalRunRecord, sessionID: string, key: string): Promise<void> {
    try {
      await retryable(() => opencode.removeInstruction(sessionID, key), { includeTimeouts: true })
    } catch {
      // best effort: a stale instruction only nudges the agent, never breaks it
    }
  }

  async function createInternalSession(
    run: GoalRunRecord,
    kind: "critic" | "judge",
  ): Promise<{ id: string; directory: string }> {
    const info = await retryable(() => opencode.sessionInfo(run.sessionID), { includeTimeouts: true })
    if (!info) throw new GoalError("goal_not_active", 409, "the goal session no longer exists")
    const marker = `${kind}_${run.sessionID}_${run.round}_${run.promptSerial}`
    const created = await retryable<{ id: string }>(
      () =>
        opencode.createSession({
          directory: info.directory,
          parentID: run.sessionID,
          title: kind === "critic" ? "Goal critic" : "Goal judge",
          marker,
        }),
      {
        includeTimeouts: true,
        reconcile: async () => (await opencode.findSessionByMarker(marker)) ?? undefined,
        onRetry: (error) => {
          const live = store.getGoalRun(run.sessionID)
          if (!live) return
          live.lastError = retryNote(error)
          persist(live)
        },
      },
    )
    return { id: created.id, directory: info.directory }
  }

  function critiquePrompt(run: GoalRunRecord, report: GoalReport): string {
    return [
      `Goal: ${run.goal}`,
      `Main agent report: ${JSON.stringify(report)}`,
      `Round ${run.round}.`,
    ].join("\n")
  }

  function judgePrompt(run: GoalRunRecord, critique: GoalCritique): string {
    return [
      `Goal: ${run.goal}`,
      `Main agent report: ${JSON.stringify(run.lastReport)}`,
      `Critic review: ${JSON.stringify(critique)}`,
      `Round ${run.round}.`,
    ].join("\n")
  }

  /** Continuation prompt for the main agent (retries, resume, follow-up rounds). */
  function mainContinuation(run: GoalRunRecord, reason?: string): string {
    const lines = [`Continue working on the goal: ${run.goal}`]
    if (run.lastVerdict && !run.lastVerdict.approved) {
      lines.push("The judge rejected the previous attempt. Required changes:")
      for (const change of run.lastVerdict.requiredChanges) lines.push(`- ${change}`)
      const issues = run.lastCritique?.issues ?? []
      for (const issue of issues) lines.push(`- (${issue.severity}) ${issue.claim}: ${issue.evidence}`)
    }
    if (reason) lines.push(`Your previous turn ended early: ${reason}.`)
    lines.push("Verify the result and end your final message with the completion marker from the goal instructions.")
    return lines.join("\n")
  }

  async function startCritique(run: GoalRunRecord, report: GoalReport): Promise<void> {
    run.state = "critiquing"
    clearAwaiting(run)
    persist(run)
    try {
      let criticID = run.criticSessionID
      if (!criticID) {
        const created = await createInternalSession(run, "critic")
        criticID = created.id
        run.criticSessionID = criticID
        persist(run)
      }
      await writeInstruction(run, criticID, CRITIC_INSTRUCTION_KEY, CRITIC_INSTRUCTION)
      await switchModel(criticID, run.criticModel)
      await promptPhase(run, "critic", critiquePrompt(run, report))
    } catch (error) {
      await retryPhase(run, "critic", errorMessage(error))
    }
  }

  async function startJudge(run: GoalRunRecord, critique: GoalCritique): Promise<void> {
    run.state = "judging"
    clearAwaiting(run)
    persist(run)
    try {
      let judgeID = run.judgeSessionID
      if (!judgeID) {
        const created = await createInternalSession(run, "judge")
        judgeID = created.id
        run.judgeSessionID = judgeID
        persist(run)
      }
      await writeInstruction(run, judgeID, JUDGE_INSTRUCTION_KEY, JUDGE_INSTRUCTION)
      await switchModel(judgeID, run.judgeModel)
      await promptPhase(run, "judge", judgePrompt(run, critique))
    } catch (error) {
      await retryPhase(run, "judge", errorMessage(error))
    }
  }

  /** Re-drives the phase that failed (or was paused) after the backoff delay. */
  async function retryPhase(run: GoalRunRecord, kind: GoalPhase, reason: string): Promise<void> {
    if (run.attempt >= MAX_PHASE_RETRIES) {
      fail(run, `${reason} — gave up after ${run.attempt} retries`, kind)
      return
    }
    run.attempt += 1
    run.lastError = reason
    run.pausedPhase = kind
    persist(run)

    const delay = PHASE_RETRY_BASE_MS * 2 ** (run.attempt - 1)
    await sleep(delay)

    const current = store.getGoalRun(run.sessionID)
    if (!current || TERMINAL_STATES.has(current.state) || current.state === "paused") return
    try {
      if (kind === "main") {
        current.state = "running"
        persist(current)
        await promptPhase(current, "main", mainContinuation(current, reason))
      } else if (kind === "critic" && current.lastReport) {
        await promptPhase(current, "critic", critiquePrompt(current, current.lastReport))
      } else if (kind === "judge" && current.lastCritique) {
        await promptPhase(current, "judge", judgePrompt(current, current.lastCritique))
      } else {
        fail(current, reason, kind)
      }
    } catch (error) {
      fail(current, `${reason}: ${errorMessage(error)}`, kind)
    }
  }

  async function settleRound(run: GoalRunRecord, verdict: GoalVerdict): Promise<void> {
    run.lastVerdict = verdict
    run.attempt = 0
    run.history = [...run.history, { round: run.round, critique: run.lastCritique, verdict }]
    if (verdict.approved) {
      run.state = "approved"
      run.pausedPhase = null
      run.lastError = null
      clearAwaiting(run)
      persist(run)
      await removeInstruction(run, run.sessionID, GOAL_INSTRUCTION_KEY)
      return
    }

    if (run.round >= run.maxRounds) {
      run.state = "paused"
      run.pausedPhase = "cap"
      run.lastError = null
      clearAwaiting(run)
      persist(run)
      return
    }

    run.round += 1
    run.state = "running"
    clearAwaiting(run)
    persist(run)
    try {
      await promptPhase(run, "main", mainContinuation(run))
    } catch (error) {
      await retryPhase(run, "main", errorMessage(error))
    }
  }

  async function handleMissingMarker(run: GoalRunRecord): Promise<void> {
    if (run.nudged) {
      fail(run, "the agent finished without the completion marker", "main")
      return
    }
    run.nudged = true
    run.lastError = "the completion marker was missing — asked the agent to emit it"
    run.pausedPhase = "main"
    persist(run)
    try {
      await promptPhase(run, "main", GOAL_MARKER_NUDGE)
    } catch (error) {
      fail(run, `the completion marker was missing: ${errorMessage(error)}`, "main")
    }
  }

  /** Processes the reply of the awaited session; returns true when it advanced. */
  async function processIdle(runSessionID: string, sessionID: string): Promise<boolean> {
    const run = store.getGoalRun(runSessionID)
    if (!run || TERMINAL_STATES.has(run.state) || run.state === "paused") return false
    if (run.awaitingSessionID !== sessionID || !run.awaitingKind) return false

    let last: { id: string; text: string } | null
    try {
      last = await retryable(() => opencode.lastAssistant(sessionID), { includeTimeouts: true })
    } catch (error) {
      await retryPhase(run, run.awaitingKind, errorMessage(error))
      return false
    }
    if (!last || last.id === run.awaitingAssistantID) return false

    const kind = run.awaitingKind
    run.awaitingAssistantID = last.id
    persist(run)

    if (kind === "main") {
      const report = parseGoalMarker(last.text)
      if (!report) {
        await handleMissingMarker(run)
        return true
      }
      run.lastReport = report
      run.attempt = 0
      if (report.status === "blocked") {
        fail(run, `the agent reported the goal as blocked: ${report.reason ?? report.summary}`, "main")
        return true
      }
      await startCritique(run, report)
      return true
    }

    if (kind === "critic") {
      const critique = parseCritique(last.text)
      if (!critique) {
        await retryPhase(run, "critic", "the critic reply had no critique marker")
        return true
      }
      run.lastCritique = critique
      run.attempt = 0
      await startJudge(run, critique)
      return true
    }

    const verdict = parseVerdict(last.text)
    if (!verdict) {
      await retryPhase(run, "judge", "the judge reply had no verdict marker")
      return true
    }
    await settleRound(run, verdict)
    return true
  }

  /** The run that owns `sessionID` as its main, critic or judge session. */
  function runForSession(sessionID: string): GoalRunRecord | null {
    const main = store.getGoalRun(sessionID)
    if (main) return main
    for (const run of store.listGoalRuns()) {
      if (run.criticSessionID === sessionID || run.judgeSessionID === sessionID) return run
    }
    return null
  }

  function handleEvent(event: unknown): void {
    const type = (event as { type?: unknown } | null)?.type
    if (typeof type !== "string" || !WAKE_EVENTS.has(type)) return
    const data = eventData(event)
    const sessionID = typeof data?.sessionID === "string" ? data.sessionID : null
    if (!data || !sessionID) return

    if (type === "session.deleted") {
      const main = store.getGoalRun(sessionID)
      if (main) {
        void forget(sessionID)
        return
      }
      const run = runForSession(sessionID)
      if (!run || TERMINAL_STATES.has(run.state)) return
      if (run.awaitingSessionID === sessionID) {
        void enqueue(run.sessionID, async () => {
          const live = store.getGoalRun(run.sessionID)
          if (!live || TERMINAL_STATES.has(live.state) || live.awaitingSessionID !== sessionID) return
          fail(live, `the ${live.awaitingKind ?? "review"} session was deleted`, live.awaitingKind ?? "main")
        })
      }
      return
    }

    const run = runForSession(sessionID)
    if (!run || TERMINAL_STATES.has(run.state)) return
    if (run.awaitingSessionID !== sessionID) return

    if (type === "session.idle" || type === "session.execution.succeeded") {
      void enqueue(run.sessionID, async () => {
        await processIdle(run.sessionID, sessionID)
      })
      return
    }
    if (type === "session.execution.failed") {
      const message = eventErrorMessage(data)
      void enqueue(run.sessionID, async () => {
        const live = store.getGoalRun(run.sessionID)
        if (!live || TERMINAL_STATES.has(live.state) || live.awaitingSessionID !== sessionID) return
        await retryPhase(live, live.awaitingKind ?? "main", message)
      })
      return
    }
    if (type === "session.execution.interrupted") {
      void enqueue(run.sessionID, async () => {
        const live = store.getGoalRun(run.sessionID)
        if (!live || TERMINAL_STATES.has(live.state) || live.awaitingSessionID !== sessionID) return
        fail(live, "the turn was interrupted", live.awaitingKind ?? "main")
      })
      return
    }

    // opencode is retrying a provider error itself: surface it, keep waiting.
    const status = data.status as { type?: unknown; attempt?: unknown; message?: unknown } | undefined
    const isRetry = type === "session.retry.scheduled" || status?.type === "retry"
    if (!isRetry) return
    const attempt = typeof data.attempt === "number" ? data.attempt : typeof status?.attempt === "number" ? status.attempt : null
    const message =
      typeof status?.message === "string" && status.message.trim()
        ? status.message.trim()
        : (() => {
            const reason = eventErrorMessage(data)
            return reason === "the agent turn failed" ? "provider error" : reason
          })()
    void enqueue(run.sessionID, async () => {
      const live = store.getGoalRun(run.sessionID)
      if (!live || TERMINAL_STATES.has(live.state)) return
      live.lastError = `opencode is retrying${attempt ? ` (attempt ${attempt})` : ""}: ${message}`
      persist(live)
    })
  }

  async function start(input: { sessionID: string; goal: string; model?: string | null }): Promise<GoalRunRecord> {
    const goal = input.goal.trim()
    if (!goal || goal.length > MAX_GOAL_LENGTH) {
      throw new GoalError("invalid_goal", 400, `the goal must be 1..${MAX_GOAL_LENGTH} characters`)
    }
    const existing = store.getGoalRun(input.sessionID)
    if (existing && !TERMINAL_STATES.has(existing.state)) {
      throw new GoalError("goal_running", 409, "a goal run is already active for this session")
    }
    let info: GoalSessionInfo | null
    let active: string[]
    try {
      info = await retryable(() => opencode.sessionInfo(input.sessionID), { includeTimeouts: true })
      if (info) active = await retryable(() => opencode.activeSessions(), { includeTimeouts: true })
      else active = []
    } catch (error) {
      throw new GoalError("opencode_unreachable", 502, errorMessage(error))
    }
    if (!info) throw new GoalError("session_not_found", 404, "unknown session")
    if (active.includes(input.sessionID)) {
      throw new GoalError("session_busy", 409, "the session is running a turn; wait for it to finish")
    }

    const settings = store.getGoalSettings()
    const mainModel = normalizeRef(input.model) ?? info.model
    const run: GoalRunRecord = {
      sessionID: input.sessionID,
      goal,
      state: "running",
      round: 1,
      maxRounds: settings.maxRounds > 0 ? settings.maxRounds : defaultMaxRounds,
      mainModel,
      criticModel: normalizeRef(settings.criticModel) ?? mainModel,
      judgeModel: normalizeRef(settings.judgeModel) ?? mainModel,
      criticSessionID: null,
      judgeSessionID: null,
      lastReport: null,
      lastCritique: null,
      lastVerdict: null,
      history: [],
      error: null,
      awaitingKind: null,
      awaitingSessionID: null,
      awaitingAssistantID: null,
      attempt: 0,
      nudged: false,
      lastError: null,
      pausedPhase: null,
      promptSerial: 0,
      createdAt: now(),
      updatedAt: now(),
    }
    persist(run)

    try {
      await writeInstruction(run, run.sessionID, GOAL_INSTRUCTION_KEY, GOAL_INSTRUCTION)
      await promptPhase(run, "main", goal)
    } catch (error) {
      fail(run, `could not start the goal: ${errorMessage(error)}`, "main")
      throw new GoalError("opencode_unreachable", 502, errorMessage(error))
    }
    const live = store.getGoalRun(input.sessionID)
    return live ?? run
  }

  function status(sessionID: string): GoalRunRecord | null {
    return store.getGoalRun(sessionID)
  }

  async function pause(sessionID: string): Promise<GoalRunRecord> {
    const run = store.getGoalRun(sessionID)
    if (!run) throw new GoalError("goal_not_found", 404, "no goal run for this session")
    if (run.state !== "running" && run.state !== "critiquing" && run.state !== "judging") {
      throw new GoalError("goal_not_active", 409, "the run is not active")
    }
    await enqueue(sessionID, async () => {
      const live = store.getGoalRun(sessionID)
      if (!live || (live.state !== "running" && live.state !== "critiquing" && live.state !== "judging")) return
      live.pausedPhase = live.awaitingKind ?? "main"
      live.state = "paused"
      live.lastError = null
      const awaited = live.awaitingSessionID
      clearAwaiting(live)
      persist(live)
      if (awaited) {
        try {
          await retryable(() => opencode.interrupt(awaited), { includeTimeouts: true })
        } catch {
          // the turn will end on its own; the paused state is already durable
        }
      }
    })
    return store.getGoalRun(sessionID) ?? run
  }

  async function resume(sessionID: string): Promise<GoalRunRecord> {
    const run = store.getGoalRun(sessionID)
    if (!run) throw new GoalError("goal_not_found", 404, "no goal run for this session")
    if (run.state !== "paused" && run.state !== "error") {
      throw new GoalError("goal_not_active", 409, "the run is not paused")
    }
    await enqueue(sessionID, async () => {
      const live = store.getGoalRun(sessionID)
      if (!live || (live.state !== "paused" && live.state !== "error")) return
      live.error = null
      live.lastError = null
      live.attempt = 0

      if (live.pausedPhase === "cap") {
        live.round += 1
        live.maxRounds += Math.max(1, store.getGoalSettings().maxRounds)
        live.state = "running"
        clearAwaiting(live)
        persist(live)
        try {
          await promptPhase(live, "main", mainContinuation(live))
        } catch (error) {
          fail(live, `could not resume: ${errorMessage(error)}`, "main")
        }
        return
      }

      const phase = live.pausedPhase ?? "main"
      if (phase === "critic" && live.lastReport) {
        await startCritique(live, live.lastReport)
        return
      }
      if (phase === "judge" && live.lastCritique) {
        await startJudge(live, live.lastCritique)
        return
      }
      live.state = "running"
      clearAwaiting(live)
      persist(live)
      try {
        await promptPhase(live, "main", mainContinuation(live))
      } catch (error) {
        fail(live, `could not resume: ${errorMessage(error)}`, "main")
      }
    })
    return store.getGoalRun(sessionID) ?? run
  }

  async function cancel(sessionID: string): Promise<GoalRunRecord> {
    const run = store.getGoalRun(sessionID)
    if (!run) throw new GoalError("goal_not_found", 404, "no goal run for this session")
    if (run.state === "approved" || run.state === "cancelled") {
      throw new GoalError("goal_not_active", 409, "the run is already over")
    }
    await enqueue(sessionID, async () => {
      const live = store.getGoalRun(sessionID)
      if (!live || live.state === "approved" || live.state === "cancelled") return
      const awaited = live.awaitingSessionID
      live.state = "cancelled"
      live.error = null
      live.lastError = null
      clearAwaiting(live)
      persist(live)
      if (awaited) {
        try {
          await retryable(() => opencode.interrupt(awaited), { includeTimeouts: true })
        } catch {
          // best effort
        }
      }
      for (const id of [live.criticSessionID, live.judgeSessionID]) {
        if (!id) continue
        try {
          await retryable(() => opencode.removeSession(id), { includeTimeouts: true })
        } catch {
          // the child sessions are hidden; leaving one is harmless
        }
      }
      await removeInstruction(live, live.sessionID, GOAL_INSTRUCTION_KEY)
    })
    return store.getGoalRun(sessionID) ?? run
  }

  async function forget(sessionID: string): Promise<void> {
    await enqueue(sessionID, async () => {
      if (!store.getGoalRun(sessionID)) return
      store.removeGoalRun(sessionID)
      emit({ type: "goal.updated", data: { sessionID, goal: null } })
    })
  }

  async function reconcile(): Promise<void> {
    for (const run of store.listGoalRuns()) {
      if (TERMINAL_STATES.has(run.state) || run.state === "paused") continue
      if (!run.awaitingSessionID || !run.awaitingKind) continue
      await enqueue(run.sessionID, async () => {
        const live = store.getGoalRun(run.sessionID)
        if (!live || TERMINAL_STATES.has(live.state) || live.state === "paused") return
        const awaited = live.awaitingSessionID
        const kind = live.awaitingKind
        if (!awaited || !kind) return
        let active: string[]
        try {
          active = await retryable(() => opencode.activeSessions(), { includeTimeouts: true })
        } catch {
          return
        }
        if (active.includes(awaited)) return
        const processed = await processIdle(live.sessionID, awaited)
        if (!processed) {
          const current = store.getGoalRun(live.sessionID)
          if (!current || TERMINAL_STATES.has(current.state) || current.state === "paused") return
          if (current.awaitingSessionID !== awaited) return
          await retryPhase(current, kind, "the turn ended without a reply")
        }
      })
    }
    await flush()
  }

  function reconcileOnBoot(): void {
    for (const run of store.listGoalRuns()) {
      if (TERMINAL_STATES.has(run.state)) continue
      run.pausedPhase = run.pausedPhase ?? run.awaitingKind ?? "main"
      run.state = "paused"
      run.error = "The run was interrupted by a MasterHand restart — resume to continue."
      run.lastError = null
      run.attempt = 0
      clearAwaiting(run)
      persist(run)
    }
  }

  function getSettings(): GoalSettingsRecord {
    return store.getGoalSettings()
  }

  async function saveSettings(patch: Partial<GoalSettingsRecord>): Promise<GoalSettingsRecord> {
    const current = store.getGoalSettings()
    const next: GoalSettingsRecord = {
      maxRounds: patch.maxRounds ?? current.maxRounds,
      criticModel: patch.criticModel === undefined ? current.criticModel : normalizeRef(patch.criticModel),
      judgeModel: patch.judgeModel === undefined ? current.judgeModel : normalizeRef(patch.judgeModel),
    }
    if (patch.criticModel !== undefined && patch.criticModel !== null && !next.criticModel) {
      throw new GoalError("invalid_model", 400, "the critic model must be a provider/model reference")
    }
    if (patch.judgeModel !== undefined && patch.judgeModel !== null && !next.judgeModel) {
      throw new GoalError("invalid_model", 400, "the judge model must be a provider/model reference")
    }
    if (!Number.isInteger(next.maxRounds) || next.maxRounds < 1 || next.maxRounds > 50) {
      throw new GoalError("invalid_settings", 400, "max rounds must be an integer between 1 and 50")
    }
    const requested = [next.criticModel, next.judgeModel].filter((ref): ref is string => ref !== null)
    if (requested.length > 0) {
      let catalog: string[] = []
      try {
        catalog = await retryable(() => opencode.models(), { includeTimeouts: true })
      } catch (error) {
        throw new GoalError("opencode_unreachable", 502, errorMessage(error))
      }
      if (catalog.length > 0) {
        const missing = requested.find((ref) => !catalog.includes(ref))
        if (missing) throw new GoalError("invalid_model", 400, `unknown model: ${missing}`)
      }
    }
    store.saveGoalSettings(next)
    return next
  }

  const watchdogMs = options.watchdogMs ?? DEFAULT_WATCHDOG_MS
  const watchdog = watchdogMs > 0 ? setInterval(() => void reconcile().catch(() => {}), watchdogMs) : null
  // Never keep the process alive for the watchdog (tests create many apps).
  ;(watchdog as { unref?: () => void } | null)?.unref?.()

  return {
    start,
    status,
    pause,
    resume,
    cancel,
    forget,
    handleEvent,
    reconcile,
    reconcileOnBoot,
    flush,
    stop() {
      if (watchdog) clearInterval(watchdog)
    },
    getSettings,
    saveSettings,
  }
}
