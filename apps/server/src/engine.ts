import type { EventHub } from "./events.js"
import { GOAL_INTERNAL_MARKER_KEY, GOAL_SESSION_MARKER_KEY, type GoalManager } from "./goal.js"
import { isChatTurn, type TurnJournal } from "./journal.js"
import type { TurnOpencode } from "./opencode.js"
import { AmbiguousMutationError, isTransientFailure, withRetry } from "./retry.js"
import { SCHEDULER_MARKER_KEY, type SchedulerManager } from "./scheduler.js"
import type { Store, TurnRecord } from "./store.js"
import type {
  SupervisorClient,
  SupervisorIncident,
  SupervisorMemory,
  SupervisorServiceSnapshot,
  SupervisorStatus,
} from "./supervisor.js"

/**
 * Resilience engine: consumes the turn journal and the supervisor snapshot to
 * recover work after the agent engine (or the BFF) restarted.
 *
 * Trust boundary: the recovery pass is a new mutation, never a replay. A goal
 * or scheduled run is only re-driven after its own marker/baseline proves the
 * previous prompt did not land; a chat continuation is a NEW prompt carrying a
 * fresh marker, sent at most once automatically, serialized and capped. If the
 * outcome of a continuation is unknown, it is marked `ambiguous` and never
 * retried blind (rule 4).
 */

export type EngineServiceKind = "engine" | "server"

export interface EngineStatus {
  /** A supervisor sidecar is configured (status/controls available). */
  supervisor: boolean
  /** The event hub is connected to opencode right now. */
  healthy: boolean
  restarting: boolean
  circuitOpen: boolean
  /** Current supervised state of opencode (`running`, `exited`, …). */
  state: string
  /** The watchdog saw ≥95% memory for its sampled window (warning, not restart). */
  memoryWarning: boolean
  attempts: number
  maxAttempts: number
  lastIncident: SupervisorIncident | null
  memory: SupervisorMemory | null
  /** The most recent incident of the BFF container (shown after it recovers). */
  serverIncident: SupervisorIncident | null
  /** The BFF container is currently stopped by the supervisor's circuit. */
  serverCircuitOpen: boolean
  /** Interrupted/ambiguous chat turns waiting for a continuation. */
  interruptedTurns: number
  autoResume: boolean
  autoContinueChats: boolean
}

export interface ResumeResult {
  status: "resumed" | "skipped" | "failed"
  automatic?: boolean
  reason?: string
  ambiguous?: boolean
}

export interface EngineMonitorOptions {
  store: Store
  hub: EventHub
  journal: TurnJournal
  goals: GoalManager
  scheduler: SchedulerManager
  opencode: TurnOpencode
  supervisor: SupervisorClient
  /**
   * Bounded `/api/info` probe used by the recovery pass. The status route runs
   * its own detailed probe (version/error) and does not share this result.
   */
  probeOpencode: () => Promise<boolean>
  emit?: (event: unknown) => void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  autoResume?: boolean
  autoContinueChats?: boolean
  maxChatResumes?: number
  resumeGapMs?: number
  recoveryTimeoutMs?: number
  recoveryMinOutageMs?: number
  healthGraceMs?: number
  /** Supervisor status cache (default 5 s). */
  statusCacheMs?: number
  /** Supervisor status poll for live frames; 0 disables the timer (tests). */
  statusPollMs?: number
  retry?: { attempts?: number; baseDelayMs?: number }
  log?: (message: string) => void
}

export interface EngineMonitor {
  start(): void
  stop(): void
  status(): Promise<EngineStatus>
  /** One debounced recovery pass (single-flight). */
  recover(reason?: string): Promise<void>
  /** Test/route hook: run a pass without the reconnect debounce. */
  recoverNow(): Promise<void>
  /** Manual or automatic continuation of one interrupted chat turn. */
  resumeTurn(sessionID: string, options?: { automatic?: boolean }): Promise<ResumeResult>
  listTurns(): TurnRecord[]
  restartEngine(): Promise<{ ok: boolean; error?: string }>
  resetEngine(): Promise<{ ok: boolean; error?: string }>
}

/** The continuation prompt: context + verify + avoid re-triggering the OOM. */
export function resumePrompt(
  cause: EngineServiceKind,
  automatic = true,
  reason: string | null = null,
): string {
  const why =
    reason === "oom"
      ? "ran out of memory"
      : reason === "unhealthy"
        ? "became unresponsive"
        : "was restarted after a crash"
  const origin = automatic
    ? cause === "server"
      ? "This is an automatic continuation sent by MasterHand. MasterHand restarted while your turn was running"
      : `This is an automatic continuation sent by MasterHand. MasterHand detected that its agent engine ${why} and restarted it automatically`
    : "MasterHand is continuing this turn because the previous one was interrupted"
  return `${origin}. Your previous turn was interrupted, so some work may be lost or left half-finished.

Before continuing:
1. Check the current state of the files, commands and processes you touched.
2. Do not repeat side effects that already completed.
3. If you were running something heavy (a build, install, test suite, download or bulk generation), avoid starting it again as-is, or split it into smaller steps, so it does not exhaust memory and force another restart.

Then continue from where you left off and finish the task.`
}

function isInternalTurn(
  store: Store,
  sessionID: string,
  info: { metadata: Record<string, unknown> | null; parentID: string | null } | null,
): boolean {
  if (!info) return false
  if (info.parentID) return true
  const metadata = info.metadata ?? {}
  if (
    typeof metadata[GOAL_SESSION_MARKER_KEY] === "string" ||
    typeof metadata[GOAL_INTERNAL_MARKER_KEY] === "string" ||
    typeof metadata[SCHEDULER_MARKER_KEY] === "string"
  ) {
    return true
  }
  if (store.getGoalRun(sessionID) || store.findGoalRunByMemberSession(sessionID)) return true
  return Boolean(store.getScheduledRunBySession(sessionID))
}

function turnCause(turn: TurnRecord): EngineServiceKind {
  return /MasterHand server/i.test(turn.reason ?? "") ? "server" : "engine"
}

export function createEngineMonitor(options: EngineMonitorOptions): EngineMonitor {
  const { store, hub, journal, goals, scheduler, opencode, supervisor } = options
  const emit = options.emit ?? (() => {})
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const log = options.log ?? ((message: string) => console.warn(message))
  const autoResume = options.autoResume ?? true
  const autoContinueChats = options.autoContinueChats ?? true
  const maxChatResumes = Math.max(0, options.maxChatResumes ?? 3)
  const resumeGapMs = Math.max(0, options.resumeGapMs ?? 30_000)
  const recoveryTimeoutMs = Math.max(1_000, options.recoveryTimeoutMs ?? 60_000)
  const recoveryMinOutageMs = Math.max(0, options.recoveryMinOutageMs ?? 3_000)
  const healthGraceMs = Math.max(0, options.healthGraceMs ?? 30_000)
  const statusCacheMs = Math.max(0, options.statusCacheMs ?? 5_000)
  const statusPollMs = Math.max(0, options.statusPollMs ?? 10_000)
  const retryAttempts = Math.max(1, options.retry?.attempts ?? 3)
  const retryBaseDelayMs = Math.max(0, options.retry?.baseDelayMs ?? 250)

  let started = false
  let stopped = false
  let disconnectedAt: number | null = null
  let recovery: Promise<void> | null = null
  let statusTimer: ReturnType<typeof setInterval> | null = null
  let unsubscribe: (() => void) | null = null
  let statusCache: { at: number; value: SupervisorStatus | null } | null = null
  let lastStatusFingerprint: string | null = null
  let circuitHandled = false
  /** Per-session continuation single-flight (two devices/taps share one). */
  const resuming = new Map<string, Promise<ResumeResult>>()

  async function supervisorStatus(force = false): Promise<SupervisorStatus | null> {
    if (!force && statusCache && now() - statusCache.at < statusCacheMs) return statusCache.value
    const value = await supervisor.status()
    statusCache = { at: now(), value }
    return value
  }

  async function waitHealthy(deadline: number): Promise<boolean> {
    while (!stopped && now() < deadline) {
      if (await options.probeOpencode()) return true
      await sleep(2_000)
    }
    return false
  }

  function hasRecoverableWork(): boolean {
    if (journal.list(["running", "interrupted", "ambiguous"], 1).length > 0) return true
    if (
      store.listGoalRuns().some((run) => {
        return run.state === "running" || run.state === "critiquing" || run.state === "judging"
      })
    ) {
      return true
    }
    return store.listActiveScheduledRuns().length > 0
  }

  async function pauseForCircuit(service: SupervisorServiceSnapshot | null, reason: string): Promise<void> {
    if (circuitHandled) return
    circuitHandled = true
    const message =
      "the agent engine was stopped after repeated crashes — start it from the resilience banner, then resume the run"
    await goals.pauseInterrupted(message)
    // The engine is stopped: no upstream calls here. Goal/scheduler ownership
    // is a store lookup; a subagent child (if any) is caught by the manual
    // continuation's authoritative sessionInfo guard before any prompt.
    for (const turn of journal.list(["running"], 500)) {
      if (internalByStore(turn.sessionID)) {
        journal.remove(turn.sessionID)
        continue
      }
      journal.close(turn.sessionID, "interrupted", "the agent engine is stopped after repeated crashes")
    }
    emit({
      type: "engine.circuit_open",
      data: { at: now(), reason, service: service?.service ?? "opencode" },
    })
  }

  function resumeMarker(turn: TurnRecord, automatic: boolean): string {
    return `resume_${turn.startedAt}_${turn.resumeAttempts}_${automatic ? "auto" : "manual"}`
  }

  async function sendContinuation(sessionID: string, automatic: boolean): Promise<ResumeResult> {
    if (stopped) return { status: "skipped", reason: "stopped" }
    const turn = journal.get(sessionID)
    if (!turn) return { status: "skipped", reason: "no_turn" }
    if (turn.state !== "interrupted" && turn.state !== "ambiguous") return { status: "skipped", reason: "not_interrupted" }
    if (!isChatTurn(turn)) return { status: "skipped", reason: "internal_turn" }
    // The journal origin is a hint; the authoritative ownership check is the
    // session metadata/store (goal critic/judge, scheduled, subagent). A
    // manual Continue must never inject a prompt into an internal session.
    let info: Awaited<ReturnType<TurnOpencode["sessionInfo"]>>
    try {
      info = await opencode.sessionInfo(sessionID)
    } catch {
      return { status: "failed", reason: "engine_unreachable" }
    }
    if (isInternalTurn(store, sessionID, info)) {
      journal.remove(sessionID)
      return { status: "skipped", reason: "internal_turn" }
    }
    if (automatic && turn.resumeAttempts > 0) return { status: "skipped", reason: "already_attempted" }

    const status = await supervisorStatus(true)
    const service = status?.services.opencode ?? null
    if (service?.circuitOpen) return { status: "skipped", reason: "circuit_open" }

    let active: string[]
    try {
      active = await opencode.activeSessions()
    } catch {
      return { status: "failed", reason: "engine_unreachable" }
    }
    if (active.includes(sessionID)) return { status: "skipped", reason: "session_busy" }

    // A completed assistant message newer than the turn means it actually
    // finished while the BFF was down; continuing would duplicate work.
    try {
      const last = await opencode.lastAssistant(sessionID)
      if (last?.completed && (last.createdAt === null || last.createdAt >= turn.startedAt)) {
        journal.close(sessionID, "completed")
        return { status: "skipped", reason: "already_completed" }
      }
    } catch {
      return { status: "failed", reason: "engine_unreachable" }
    }

    const marker = resumeMarker(turn, automatic)
    try {
      await withRetry(
        async () => {
          await opencode.prompt(
            sessionID,
            resumePrompt(turnCause(turn), automatic, service?.lastIncident?.reason ?? null),
            marker,
          )
          return true
        },
        {
          attempts: retryAttempts,
          baseDelayMs: retryBaseDelayMs,
          sleep,
          shouldRetry: (error) => isTransientFailure(error, { includeTimeouts: true }),
          reconcile: async () => ((await opencode.promptLanded(sessionID, marker)) ? true : undefined),
        },
      )
      journal.markResumed(sessionID, automatic)
      return { status: "resumed", automatic }
    } catch (error) {
      if (error instanceof AmbiguousMutationError) {
        journal.markAmbiguous(
          sessionID,
          "could not confirm whether the continuation landed — check the session before retrying",
        )
        return { status: "failed", reason: "ambiguous", ambiguous: true }
      }
      const reason = error instanceof Error ? error.message : "the continuation failed"
      journal.markResumeFailed(sessionID, `the continuation did not land: ${reason}`)
      return { status: "failed", reason }
    }
  }

  function resumeTurn(sessionID: string, opts: { automatic?: boolean } = {}): Promise<ResumeResult> {
    const pending = resuming.get(sessionID)
    if (pending) return pending
    const automatic = opts.automatic === true
    const task = sendContinuation(sessionID, automatic).finally(() => {
      if (resuming.get(sessionID) === task) resuming.delete(sessionID)
    })
    resuming.set(sessionID, task)
    return task
  }

  async function runRecovery(reason: string): Promise<void> {
    if (stopped || !hub.connected) return
    const startedAt = now()
    const status = await supervisorStatus(true)
    const service = status?.services.opencode ?? null
    if (service?.circuitOpen) {
      await pauseForCircuit(service, reason)
      return
    }
    if (!(await waitHealthy(now() + recoveryTimeoutMs))) {
      // The supervisor may have given up while we waited; otherwise leave the
      // runs untouched for the next reconnect/restart.
      const late = await supervisorStatus(true)
      if (late?.services.opencode?.circuitOpen) await pauseForCircuit(late.services.opencode, reason)
      return
    }
    // A freshly (re)started engine gets a short stability window before any
    // continuation is injected; otherwise the agent could hammer it again.
    if (healthGraceMs > 0) await sleep(healthGraceMs)
    // The circuit could have opened during the grace: re-read before touching
    // any goal/scheduled/chat state, or recovery would drive a stopped engine.
    const afterGrace = await supervisorStatus(true)
    if (afterGrace?.services.opencode?.circuitOpen) {
      await pauseForCircuit(afterGrace.services.opencode, reason)
      return
    }
    if (stopped || !(await options.probeOpencode())) return

    // Goals and scheduled runs first: they own their sessions and reconcile
    // through their own persisted markers/baselines.
    if (autoResume) {
      try {
        await goals.recoverInterrupted()
      } catch (error) {
        log(`[engine] goal recovery failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      try {
        await scheduler.recoverInterruptedRuns()
      } catch (error) {
        log(`[engine] scheduled-run recovery failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      // The goal/scheduled passes can take a while; the engine may have died
      // again. Never inject chat continuations into a stopped engine.
      const afterWork = await supervisorStatus(true)
      if (afterWork?.services.opencode?.circuitOpen) {
        await pauseForCircuit(afterWork.services.opencode, reason)
        return
      }
      if (stopped) return
    }

    let active: Set<string>
    try {
      active = new Set(await opencode.activeSessions())
    } catch {
      return // the next reconnect/recovery pass retries
    }

    const interrupted: TurnRecord[] = []
    for (const turn of journal.list(["running"], 500)) {
      if (active.has(turn.sessionID)) continue
      let info: { directory: string; parentID: string | null; metadata: Record<string, unknown> | null } | null
      try {
        info = await opencode.sessionInfo(turn.sessionID)
      } catch {
        continue
      }
      if (!info) {
        journal.remove(turn.sessionID)
        continue
      }
      if (isInternalTurn(store, turn.sessionID, info)) {
        journal.remove(turn.sessionID)
        continue
      }
      let last: Awaited<ReturnType<TurnOpencode["lastAssistant"]>>
      try {
        last = await opencode.lastAssistant(turn.sessionID)
      } catch {
        continue
      }
      if (last?.completed && (last.createdAt === null || last.createdAt >= turn.startedAt)) {
        journal.close(turn.sessionID, "completed")
        continue
      }
      const reasonText =
        reason === "boot"
          ? "the MasterHand server restarted while this turn was running"
          : "the agent engine restarted while this turn was running"
      journal.close(turn.sessionID, "interrupted", reasonText)
      interrupted.push({ ...turn, state: "interrupted", reason: reasonText })
    }

    if (autoContinueChats && interrupted.length > 0 && !stopped) {
      const incidentAt = service?.lastIncident?.at ?? startedAt
      let alreadyResumed = 0
      for (const resumed of journal.list(undefined, 1_000)) {
        if ((resumed.lastResumeAt ?? 0) >= incidentAt && resumed.resumeAttempts > 0) alreadyResumed += 1
      }
      const budget = Math.max(0, maxChatResumes - alreadyResumed)
      const candidates = interrupted
        .filter((turn) => isChatTurn(turn) && turn.resumeAttempts === 0)
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, budget)
      for (let index = 0; index < candidates.length; index += 1) {
        if (stopped) break
        const candidate = candidates[index]!
        await resumeTurn(candidate.sessionID, { automatic: true })
        if (index < candidates.length - 1 && resumeGapMs > 0) await sleep(resumeGapMs)
      }
    }

    emit({
      type: "engine.recovered",
      data: {
        reason,
        at: now(),
        service: service?.service ?? "opencode",
        interrupted: interrupted.length,
      },
    })
  }

  function recover(reason = "reconnect"): Promise<void> {
    if (stopped || !hub.connected) return Promise.resolve()
    if (recovery) return recovery
    recovery = runRecovery(reason)
      .catch((error) => {
        log(`[engine] recovery pass failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => {
        recovery = null
      })
    return recovery
  }

  function handleHubEvent(event: unknown): void {
    const type = (event as { type?: unknown } | null)?.type
    if (type === "hub.disconnected") {
      disconnectedAt = now()
      // Let the scheduler defer its own re-fires until the health grace.
      scheduler.engineRestarted()
      return
    }
    if (type !== "hub.connected") return
    const outage = disconnectedAt === null ? null : now() - disconnectedAt
    disconnectedAt = null
    if (outage !== null && outage < recoveryMinOutageMs && !hasRecoverableWork()) return
    void recover(outage === null ? "boot" : "reconnect")
  }

  async function pollStatus(): Promise<void> {
    if (stopped) return
    const status = await supervisorStatus(true)
    const service = status?.services.opencode ?? null
    const fingerprint = service ? JSON.stringify(service) : "none"
    if (fingerprint !== lastStatusFingerprint) {
      lastStatusFingerprint = fingerprint
      emit({ type: "engine.updated", data: { engine: await statusSnapshot() } })
    }
    if (service?.circuitOpen) await pauseForCircuit(service, "status-poll")
    else circuitHandled = false
  }

  function internalByStore(sessionID: string): boolean {
    return Boolean(
      store.getGoalRun(sessionID) ||
        store.findGoalRunByMemberSession(sessionID) ||
        store.getScheduledRunBySession(sessionID),
    )
  }

  function listTurns(): TurnRecord[] {
    // Internal rows are removed when the recovery pass/pause classifies them;
    // this store-only filter is the cheap defense in depth (no per-row upstream
    // call on a route that must stay bounded while the engine is down).
    return journal.list(["interrupted", "ambiguous"], 50).filter((turn) => !internalByStore(turn.sessionID))
  }

  async function statusSnapshot(): Promise<EngineStatus> {
    const status = await supervisorStatus()
    const service = status?.services.opencode ?? null
    const serverService = status?.services.masterhand ?? null
    const interruptedTurns = store
      .listTurns(["interrupted", "ambiguous"], 1_000)
      .filter((turn) => !internalByStore(turn.sessionID)).length
    return {
      supervisor: supervisor.enabled,
      healthy: hub.connected,
      restarting: service?.restarting ?? false,
      circuitOpen: service?.circuitOpen ?? false,
      state: service?.state ?? "unknown",
      memoryWarning: service?.memoryWarning ?? false,
      attempts: service?.attempts ?? 0,
      maxAttempts: service?.maxAttempts ?? 3,
      lastIncident: service?.lastIncident ?? null,
      memory: service?.memory ?? null,
      serverIncident: serverService?.lastIncident ?? null,
      serverCircuitOpen: serverService?.circuitOpen ?? false,
      interruptedTurns,
      autoResume,
      autoContinueChats,
    }
  }

  return {
    start() {
      if (started || stopped) return
      started = true
      unsubscribe = hub.subscribe(handleHubEvent)
      if (statusPollMs > 0) {
        statusTimer = setInterval(() => void pollStatus().catch(() => {}), statusPollMs)
        statusTimer.unref?.()
      }
      if (hub.connected) void recover("boot")
    },
    stop() {
      stopped = true
      unsubscribe?.()
      unsubscribe = null
      if (statusTimer) clearInterval(statusTimer)
      statusTimer = null
    },
    status() {
      return statusSnapshot()
    },
    recover,
    async recoverNow() {
      await runRecovery("manual")
    },
    resumeTurn,
    listTurns,
    async restartEngine() {
      const result = await supervisor.restart("opencode")
      statusCache = null
      if (result.ok) emit({ type: "engine.updated", data: { engine: await statusSnapshot() } })
      return result
    },
    async resetEngine() {
      const result = await supervisor.reset("opencode")
      statusCache = null
      if (result.ok) {
        circuitHandled = false
        emit({ type: "engine.updated", data: { engine: await statusSnapshot() } })
      }
      return result
    },
  }
}
