import { randomUUID } from "node:crypto"
import { Cron } from "croner"
import { AmbiguousMutationError, UpstreamStatusError, isTransientFailure, withRetry } from "./retry.js"
import {
  type ModelRef,
  type ScheduledRun,
  type ScheduledRunStatus,
  type ScheduledTask,
  type ScheduleSpec,
  type Store,
} from "./store.js"

/**
 * Scheduler (issue #147): fires each non-paused task when its scheduled slot
 * passes, creating an opencode session in the task's workspace with the
 * task's prompt and model. This module owns the loop and every request body
 * (the clients and routes never build them).
 *
 * Reliability: every opencode call goes through the shared retry engine
 * (`retry.ts`) — the model pin is idempotent and retries transient failures,
 * while the session create and the prompt are non-idempotent mutations that
 * reconcile a persisted marker first (`masterhand.scheduler` values of the
 * shape `<taskId>#<runId>#create` / `#prompt`, looked up by directory on the
 * create — the pinned v2.0.6 drops `parentID` — and over the last ~20 user
 * messages on the prompt). A reconcile lookup that itself fails aborts with
 * `AmbiguousMutationError`: the run is marked `failed`, never blind-replayed.
 * Overlap is a single serialized slot per task: a due task that already has an
 * active run gets one `queued` envelope (coalesced) and fires it as soon as
 * the active run ends. See `docs/past-mistakes.md`.
 */

export const SCHEDULER_MARKER_KEY = "masterhand.scheduler"

export type {
  ModelRef,
  ScheduleKind,
  ScheduledRun,
  ScheduledRunStatus,
  ScheduledTask,
  ScheduleSpec,
} from "./store.js"

export class SchedulerError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 404 | 409 | 502,
    message: string,
  ) {
    super(message)
    this.name = "SchedulerError"
  }
}

/** Synthetic frame broadcast on every scheduler mutation (events.ts `emit`). */
export interface SchedulerEvent {
  type: "scheduler.updated"
  data: { taskID: string }
}

/**
 * Thin adapter over opencode. The manager owns the loop; app.ts implements
 * this with bounded `callOpencode` calls and tests use a scripted fake —
 * exactly like `GoalOpencode`.
 */
export interface SchedulerOpencode {
  /** Creates the root session; `marker` must be persisted as session metadata. */
  createSession(directory: string, marker: string, title: string): Promise<{ id: string }>
  /**
   * Create-reconcile lookup, scoped by DIRECTORY: the pinned opencode drops
   * `parentID` on create, so the just-retried create must be found by its
   * marker in session metadata, never by a parent filter.
   */
  findSessionByMarker(directory: string, marker: string): Promise<{ id: string } | null>
  /** Sends the prompt; `marker` must be persisted as user-message metadata. */
  prompt(sessionID: string, text: string, marker: string): Promise<void>
  /** Prompt-reconcile: scans the last ~20 messages for the marker. */
  promptLanded(sessionID: string, marker: string): Promise<boolean>
  /** Idempotent model pin (`POST /api/session/:id/model`). */
  switchModel(sessionID: string, model: ModelRef): Promise<void>
  /** Same upstream call the goal watchdog uses to reconcile lost idle. */
  activeSessions(): Promise<string[]>
  /** Optional catalog check for route-level model validation (goal parity). */
  modelExists?(model: ModelRef): Promise<boolean>
}

export interface SchedulerManagerOptions {
  store: Store
  opencode: SchedulerOpencode
  emit?: (event: SchedulerEvent) => void
  /** Millisecond-epoch clock (tests inject a fixed one). */
  now?: () => number
  /** Retry sleeper (tests record delays instead of waiting). */
  sleep?: (ms: number) => Promise<void>
  /** Tick interval; 0 disables the timer (tests drive `tick()`). */
  tickMs?: number
  /** Retry tuning; the injected `sleep` hooks into every backoff. */
  retry?: { attempts?: number; baseDelayMs?: number; jitter?: boolean }
}

export interface SchedulerManager {
  /** One tick pass: repair lost-idle runs, then process due tasks once. */
  tick(): Promise<void>
  /** Hub events: session.idle / execution.* / session.error / session.deleted. */
  handleEvent(event: unknown): void
  /** Manual run of a task through the same single-slot fire path. */
  taskRunNow(taskId: string): Promise<ScheduledRun>
  /** Pause is serialized per task so it cannot race the fire path. */
  pauseTask(taskId: string): Promise<ScheduledTask>
  /** Resume recomputes nextRunAt (no immediate catch-up fire). */
  resumeTask(taskId: string): Promise<ScheduledTask>
  /** Boot reconciliation: firing→interrupted, queued→skipped, recompute. */
  reconcileTasks(): void
  /** Waits for every queued transition (tests). */
  flush(): Promise<void>
  stop(): void
}

const MINUTE_MS = 60_000
/** Default loop cadence; every `nextRunAt` is minute-granular at best. */
export const DEFAULT_TICK_MS = 20_000
/** Bounds the look-ahead walk so garbage schedules can never stall a tick. */
const MAX_SLOT_STEPS = 100_000

const COMPLETED_EVENTS = new Set(["session.idle", "session.execution.succeeded"])
const FAILED_EVENTS = new Set([
  "session.execution.failed",
  "session.error",
  "session.execution.interrupted",
  "session.deleted",
])

function errorMessage(error: unknown): string {
  if (error instanceof UpstreamStatusError) return `opencode answered ${error.status}`
  if (error instanceof Error) return error.message
  return String(error)
}

/** `AmbiguousMutationError` is surfaced as "unknown outcome", never a retry. */
function failureNote(error: unknown, action: string): string {
  if (error instanceof AmbiguousMutationError) {
    return `could not confirm whether ${action} landed — check the run before retrying`
  }
  return `${action} failed: ${errorMessage(error)}`
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

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: timezone }).format(new Date())
    return true
  } catch {
    return false
  }
}

function parseMs(value: string | null | undefined): number | null {
  if (typeof value !== "string" || value.trim() === "") return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

/**
 * Next quote of the schedule strictly after `anchorMs`, advanced past `nowMs`
 * (missed slots are skipped silently — no catch-up, no backlog records).
 * Croner owns cron math in the task's timezone (server default when empty);
 * a corrupt or nonsensical spec yields `null` so it can never stall the loop.
 */
export function nextScheduledRunAt(
  spec: ScheduleSpec,
  anchorMs: number,
  nowMs: number,
  timezone = "",
): string | null {
  if (spec.kind === "interval") {
    const minutes = typeof spec.intervalMinutes === "number" && Number.isFinite(spec.intervalMinutes)
      ? spec.intervalMinutes
      : 0
    if (minutes < 5) return null
    const interval = minutes * MINUTE_MS
    const delta = nowMs - anchorMs
    const steps = delta >= 0 ? Math.floor(delta / interval) + 1 : 1
    if (steps > MAX_SLOT_STEPS) return null
    return new Date(anchorMs + steps * interval).toISOString()
  }
  if (spec.kind === "cron") {
    const expression = typeof spec.cron === "string" ? spec.cron : ""
    if (!expression) return null
    let job: Cron
    try {
      job = new Cron(expression, { mode: "5-part", timezone: timezone.trim() || undefined })
    } catch {
      return null
    }
    let slot = job.nextRun(new Date(anchorMs))
    for (let steps = 0; slot && slot.getTime() <= nowMs; steps += 1) {
      if (steps >= MAX_SLOT_STEPS) return null
      slot = job.nextRun(slot)
    }
    return slot ? slot.toISOString() : null
  }
  return null
}

/**
 * Validates a `ScheduleSpec` (and the IANA timezone given alongside it):
 * unknown kind, interval below 5 minutes or missing, invalid cron syntax,
 * crons firing more often than every 5 minutes and invalid timezones are all
 * rejected with their own `SchedulerError` code (discriminable per reason).
 */
export function validateScheduleSpec(spec: unknown, now: number, serverTz = ""): void {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw new SchedulerError("invalid_schedule", 400, "the schedule is required")
  }
  const raw = spec as Record<string, unknown>
  if (raw.kind !== "interval" && raw.kind !== "cron") {
    throw new SchedulerError("invalid_schedule_kind", 400, "the schedule kind must be interval or cron")
  }
  const timezone = typeof serverTz === "string" ? serverTz.trim() : ""
  if (timezone && !isValidTimezone(timezone)) {
    throw new SchedulerError("invalid_timezone", 400, `unknown timezone: ${serverTz}`)
  }
  if (raw.kind === "interval") {
    const minutes = raw.intervalMinutes
    if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 5) {
      throw new SchedulerError("invalid_interval", 400, "the interval must be at least 5 minutes")
    }
    return
  }
  const cron = raw.cron
  if (typeof cron !== "string" || cron.trim().length === 0) {
    throw new SchedulerError("invalid_cron", 400, "the cron expression is required")
  }
  let job: Cron
  try {
    job = new Cron(cron, { mode: "5-part", timezone: timezone || undefined })
  } catch {
    throw new SchedulerError("invalid_cron", 400, `the cron expression is invalid: ${cron}`)
  }
  const first = job.nextRun(new Date(now))
  const second = first ? job.nextRun(first) : null
  if (!first) {
    throw new SchedulerError("invalid_cron", 400, "the cron expression never fires")
  }
  if (!second || second.getTime() - first.getTime() < 5 * MINUTE_MS) {
    throw new SchedulerError(
      "invalid_frequency",
      400,
      "the cron expression fires more often than every 5 minutes",
    )
  }
}

export interface ValidatedTaskInput {
  name: string
  prompt: string
  directory: string
  model: ModelRef
}

/** Task name cap, shared with the 200-char session-title convention. */
const MAX_TASK_NAME = 200
/** Prompt cap: large enough for a real brief, small enough to bound the run. */
const MAX_TASK_PROMPT = 8_000

function validatedModelRef(value: unknown): ModelRef {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const raw = value as Record<string, unknown>
    const providerID = typeof raw.providerID === "string" ? raw.providerID.trim() : ""
    const id = typeof raw.id === "string" ? raw.id.trim() : ""
    const variant =
      raw.variant === undefined ? undefined : typeof raw.variant === "string" ? raw.variant.trim() : ""
    if (providerID && id && (variant === undefined || variant)) {
      return variant ? { providerID, id, variant } : { providerID, id }
    }
  }
  throw new SchedulerError(
    "invalid_model",
    400,
    "the model reference must be an object { providerID, id, variant? }",
  )
}

/**
 * Required fields and shapes of a task input (name/prompt/directory non-empty
 * and within their caps, model as `{ providerID, id, variant? }`). Returns the
 * trimmed values so routes can persist the normalized result.
 */
export function validateTaskInput(input: unknown): ValidatedTaskInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new SchedulerError("invalid_task", 400, "the task body is required")
  }
  const raw = input as Record<string, unknown>
  const name = typeof raw.name === "string" ? raw.name.trim() : ""
  if (!name) throw new SchedulerError("invalid_name", 400, "the task name is required")
  if (name.length > MAX_TASK_NAME) {
    throw new SchedulerError("invalid_name", 400, `the task name is limited to ${MAX_TASK_NAME} characters`)
  }
  const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : ""
  if (!prompt) throw new SchedulerError("invalid_prompt", 400, "the task prompt is required")
  if (prompt.length > MAX_TASK_PROMPT) {
    throw new SchedulerError("invalid_prompt", 400, `the task prompt is limited to ${MAX_TASK_PROMPT} characters`)
  }
  const directory = typeof raw.directory === "string" ? raw.directory.trim() : ""
  if (!directory) throw new SchedulerError("invalid_directory", 400, "the task directory is required")
  return { name, prompt, directory, model: validatedModelRef(raw.model) }
}

export function createScheduler(options: SchedulerManagerOptions): SchedulerManager {
  const { store, opencode } = options
  const emit = options.emit ?? (() => {})
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const retryBase = {
    attempts: options.retry?.attempts ?? 4,
    baseDelayMs: options.retry?.baseDelayMs ?? 250,
    jitter: options.retry?.jitter ?? true,
  }

  /** Per-task transition queue: events and tick passes never interleave. */
  const chains = new Map<string, Promise<unknown>>()

  function enqueue(taskId: string, task: () => Promise<void>): Promise<void> {
    const tail = chains.get(taskId) ?? Promise.resolve()
    const next = tail.then(task).catch((error) => {
      console.error(`[scheduler] ${taskId} transition failed:`, error)
    })
    chains.set(taskId, next)
    void next.finally(() => {
      if (chains.get(taskId) === next) chains.delete(taskId)
    })
    return next
  }

  /**
   * Serialized check→create for a non-idempotent mutation (rule 12): two
   * devices running a task now must not create two runs. Failures propagate.
   */
  function runExclusive<T>(taskId: string, task: () => Promise<T>): Promise<T> {
    const tail = chains.get(taskId) ?? Promise.resolve()
    const next = tail.then(task)
    const settled = next.then(
      () => undefined,
      () => undefined,
    )
    chains.set(taskId, settled)
    void settled.finally(() => {
      if (chains.get(taskId) === settled) chains.delete(taskId)
    })
    return next
  }

  async function flush(): Promise<void> {
    while (chains.size > 0) await Promise.allSettled([...chains.values()])
  }

  function persistTask(record: ScheduledTask): void {
    store.saveScheduledTask(record)
    emit({ type: "scheduler.updated", data: { taskID: record.id } })
  }

  function persistRun(record: ScheduledRun): void {
    store.saveScheduledRun(record)
    emit({ type: "scheduler.updated", data: { taskID: record.taskId } })
  }

  function createRun(record: ScheduledRun): void {
    store.createScheduledRun(record)
    emit({ type: "scheduler.updated", data: { taskID: record.taskId } })
  }

  function iso(ms = now()): string {
    return new Date(ms).toISOString()
  }

  /** Re-reads the task right before the write so a pause cannot be clobbered. */
  function patchTask(taskId: string, patch: Partial<ScheduledTask>): void {
    const live = store.getScheduledTask(taskId)
    if (live) persistTask({ ...live, ...patch })
  }

  /**
   * A task whose workspace row is gone has no directory to run in (#188).
   * Deletion never writes to the scheduler store, so this revalidation runs on
   * the serialized fire path and at boot: pause the task (persisted) instead of
   * firing it forever into a removed folder. Returns true when it paused.
   */
  function pauseWithoutWorkspace(task: ScheduledTask): boolean {
    if (store.getWorkspaceByPath(task.directory)) return false
    if (!task.paused) {
      console.warn(`[scheduler] pausing ${task.id}: workspace ${task.directory} no longer exists`)
      patchTask(task.id, { paused: true })
    }
    return true
  }

  /**
   * The next slot for a task: an already-future `nextRunAt` is kept (terminal
   * recomputes are idempotent); a stale or missing one advances from itself —
   * so the schedule phase is preserved and missed slots are skipped silently.
   */
  function computeNextRunAt(task: ScheduledTask, currentMs: number): string | null {
    const prev = parseMs(task.nextRunAt)
    if (prev !== null && prev > currentMs) return task.nextRunAt
    const anchor = prev ?? parseMs(task.createdAt) ?? currentMs
    return nextScheduledRunAt(task.schedule, anchor, currentMs, task.timezone)
  }

  /** One bounded opencode call; `includeTimeouts` only for reconcilable paths. */
  function retryable<T>(
    operation: () => Promise<T>,
    opts: { includeTimeouts?: boolean; reconcile?: (error: unknown) => Promise<T | undefined> | T | undefined } = {},
  ): Promise<T> {
    return withRetry(operation, {
      ...retryBase,
      sleep,
      shouldRetry: (error) => isTransientFailure(error, { includeTimeouts: opts.includeTimeouts }),
      reconcile: opts.reconcile,
    })
  }

  /**
   * The fire path (non-idempotent, ADR-32): the run persists as `firing`
   * first (a crash shows `firing` at boot), then create → pin → prompt, each
   * reconcilable or idempotent. A confirm failure marks the run `failed` and
   * keeps the session; nothing is ever destructively cleaned up here.
   */
  async function fire(
    task: ScheduledTask,
    existing?: ScheduledRun,
    source: "schedule" | "manual" = "schedule",
  ): Promise<ScheduledRun> {
    const current = iso()
    const run: ScheduledRun = existing
      ? { ...existing, status: "firing" }
      : {
          id: randomUUID(),
          taskId: task.id,
          sessionID: null,
          status: "firing",
          source,
          error: null,
          startedAt: current,
          endedAt: null,
        }
    persistRun(run)
    // Schedule math anchors on the SCHEDULED slot (the stale nextRunAt), not
    // on the actual (possibly late) fire time.
    const nextRunAt = computeNextRunAt(task, now())
    patchTask(task.id, { lastRunAt: current, nextRunAt })

    const createMarker = `${task.id}#${run.id}#create`
    const promptMarker = `${task.id}#${run.id}#prompt`
    let sessionID: string
    try {
      const created = await retryable(
        () => opencode.createSession(task.directory, createMarker, task.name),
        {
          includeTimeouts: true,
          // Scoped by directory, not parentID (see SchedulerOpencode above).
          reconcile: async () => (await opencode.findSessionByMarker(task.directory, createMarker)) ?? undefined,
        },
      )
      sessionID = created.id
      // Persisted as soon as the create reconciles (rule 6).
      run.sessionID = sessionID
      persistRun(run)
    } catch (error) {
      return settleRun(run, "failed", failureNote(error, "the session create"))
    }

    try {
      await retryable(() => opencode.switchModel(sessionID, task.model), { includeTimeouts: true })
    } catch (error) {
      return settleRun(run, "failed", `could not set the model: ${errorMessage(error)}`)
    }

    try {
      await retryable(
        async () => {
          await opencode.prompt(sessionID, task.prompt, promptMarker)
          return true
        },
        {
          includeTimeouts: true,
          reconcile: async () => ((await opencode.promptLanded(sessionID, promptMarker)) ? true : undefined),
        },
      )
    } catch (error) {
      return settleRun(run, "failed", failureNote(error, "the prompt"))
    }

    run.status = "running"
    persistRun(run)
    return run
  }

  /**
   * Terminal transition for a run, then recomputes `nextRunAt` (idempotent)
   * and surfaces one queued envelope through the fire path — or skips it when
   * the task was paused/deleted since.
   */
  async function settleRun(
    run: ScheduledRun,
    status: "completed" | "failed",
    error?: string | null,
  ): Promise<ScheduledRun> {
    const live = store.getScheduledRun(run.id)
    if (!live || (live.status !== "firing" && live.status !== "running")) return run
    live.status = status
    if (error !== undefined && error !== null) live.error = error
    live.endedAt = iso()
    persistRun(live)
    await surfaceQueued(live.taskId)
    return live
  }

  /** Terminal follow-up: recompute the schedule, fire/skip a queued envelope. */
  async function surfaceQueued(taskId: string): Promise<void> {
    const task = store.getScheduledTask(taskId)
    if (task) {
      const next = computeNextRunAt(task, now())
      if (next !== task.nextRunAt) patchTask(taskId, { nextRunAt: next })
    }
    const queued = store
      .listActiveScheduledRuns()
      .find((run) => run.taskId === taskId && run.status === "queued")
    if (!queued) return
    const live = store.getScheduledTask(taskId)
    if (!live) return // cascaded away with its runs
    if (pauseWithoutWorkspace(live)) {
      persistRun({
        ...queued,
        status: "skipped",
        error: "the workspace no longer exists",
        endedAt: iso(),
      })
      return
    }
    if (live.paused) {
      persistRun({
        ...queued,
        status: "skipped",
        error: "the task was paused before the queued run could fire",
        endedAt: iso(),
      })
      return
    }
    await fire(live, queued)
  }

  async function settleByRunId(
    runId: string,
    status: "completed" | "failed",
    error?: string | null,
  ): Promise<void> {
    const live = store.getScheduledRun(runId)
    if (live) await settleRun(live, status, error)
  }

  /** One due task pass, inside the task's serialized chain. */
  async function processDue(taskId: string): Promise<void> {
    const task = store.getScheduledTask(taskId)
    if (!task || task.paused) return
    // Serialized revalidation immediately before the fire path: the workspace
    // may have been deleted since the tick selected this task.
    if (pauseWithoutWorkspace(task)) return
    const slot = parseMs(task.nextRunAt)
    if (slot === null || slot > now()) return
    const active = store.listActiveScheduledRuns().filter((run) => run.taskId === taskId)
    if (active.length > 0) {
      // Overlap = enqueue, one coalesced envelope, never a second slot.
      if (active.some((run) => run.status === "queued")) return
      createRun({
        id: randomUUID(),
        taskId,
        sessionID: null,
        status: "queued",
        source: "schedule",
        error: null,
        startedAt: iso(),
        endedAt: null,
      })
      return
    }
    await fire(task)
  }

  async function reconcileRunningRuns(): Promise<void> {
    const running = store
      .listActiveScheduledRuns()
      .filter((run) => run.status === "running" && run.sessionID)
    if (running.length === 0) return
    let active: string[]
    try {
      active = await retryable(() => opencode.activeSessions(), { includeTimeouts: true })
    } catch {
      return // leave the run for a later tick; an outage must not fail it
    }
    const activeSet = new Set(active)
    for (const run of running) {
      if (activeSet.has(run.sessionID!)) continue
      void enqueue(run.taskId, () => settleByRunId(run.id, "completed"))
    }
  }

  async function tick(): Promise<void> {
    await reconcileRunningRuns()
    const current = now()
    for (const task of store.listScheduledTasks()) {
      if (task.paused) continue
      const slot = parseMs(task.nextRunAt)
      if (slot === null || slot > current) continue
      void runExclusive(task.id, () => processDue(task.id)).catch((error) => {
        console.error(`[scheduler] ${task.id} tick failed:`, error)
      })
    }
    await flush()
  }

  function handleEvent(event: unknown): void {
    const type = (event as { type?: unknown } | null)?.type
    if (typeof type !== "string" || (!COMPLETED_EVENTS.has(type) && !FAILED_EVENTS.has(type))) return
    const data = (event as { data?: unknown } | null)?.data
    if (!data || typeof data !== "object" || Array.isArray(data)) return
    const sessionID = (data as { sessionID?: unknown }).sessionID
    if (typeof sessionID !== "string" || sessionID.length === 0) return

    for (const run of store.listActiveScheduledRuns()) {
      if (run.sessionID !== sessionID) continue
      void enqueue(run.taskId, async () => {
        if (COMPLETED_EVENTS.has(type!)) {
          await settleByRunId(run.id, "completed")
          return
        }
        if (type === "session.deleted") {
          await settleByRunId(run.id, "failed", "the run's session was deleted")
          return
        }
        await settleByRunId(
          run.id,
          "failed",
          type === "session.execution.interrupted" ? "the turn was interrupted" : eventErrorMessage(data as Record<string, unknown>),
        )
      })
    }
  }

  function reconcileTasks(): void {
    const current = now()
    for (const run of store.listActiveScheduledRuns()) {
      // Only the envelope-below-fire states are interrupted by a restart: a
      // `running` turn may still be executing in opencode and heals on the
      // next tick (or keeps its own idle/error close).
      if (run.status === "firing") {
        persistRun({
          ...run,
          status: "interrupted",
          error: "the fire was interrupted by a MasterHand restart",
          endedAt: iso(current),
        })
      } else if (run.status === "queued") {
        persistRun({
          ...run,
          status: "skipped",
          error: "the queued run was skipped by a MasterHand restart",
          endedAt: iso(current),
        })
      }
    }
    for (const task of store.listScheduledTasks()) {
      // Boot pass: a directory removed while MasterHand was down must not
      // resume firing just because the task row survived.
      if (pauseWithoutWorkspace(task)) continue
      const next = computeNextRunAt(task, current)
      if (next !== task.nextRunAt) patchTask(task.id, { nextRunAt: next })
    }
  }

  function taskRunNow(taskId: string): Promise<ScheduledRun> {
    return runExclusive(taskId, async () => {
      const live = store.getScheduledTask(taskId)
      if (!live) throw new SchedulerError("task_not_found", 404, "unknown scheduled task")
      if (live.paused) throw new SchedulerError("task_paused", 409, "the scheduled task is paused")
      const active = store.listActiveScheduledRuns().filter((run) => run.taskId === taskId)
      const queued = active.find((run) => run.status === "queued")
      if (queued) return queued
      if (active.length > 0) {
        // One coalesced envelope even for a manual start.
        const envelope: ScheduledRun = {
          id: randomUUID(),
          taskId,
          sessionID: null,
          status: "queued",
          source: "manual",
          error: null,
          startedAt: iso(),
          endedAt: null,
        }
        createRun(envelope)
        return envelope
      }
      return fire(live, undefined, "manual")
    })
  }

  function pauseTask(taskId: string): Promise<ScheduledTask> {
    return runExclusive(taskId, async () => {
      const live = store.getScheduledTask(taskId)
      if (!live) throw new SchedulerError("task_not_found", 404, "unknown scheduled task")
      if (!live.paused) {
        const paused: ScheduledTask = { ...live, paused: true }
        persistTask(paused)
        return paused
      }
      return live
    })
  }

  function resumeTask(taskId: string): Promise<ScheduledTask> {
    return runExclusive(taskId, async () => {
      const live = store.getScheduledTask(taskId)
      if (!live) throw new SchedulerError("task_not_found", 404, "unknown scheduled task")
      if (live.paused) {
        // Strictly-future slot recomputed here: resuming late never fires at once.
        persistTask({ ...live, paused: false, nextRunAt: computeNextRunAt(live, now()) })
      }
      return store.getScheduledTask(taskId)!
    })
  }

  const tickMs = options.tickMs ?? DEFAULT_TICK_MS
  const timer = tickMs > 0 ? setInterval(() => void tick().catch(() => {}), Math.max(1, tickMs)) : null
  // Never keep the process alive for the scheduler (tests create many managers).
  ;(timer as { unref?: () => void } | null)?.unref?.()

  return {
    tick,
    handleEvent,
    taskRunNow,
    pauseTask,
    resumeTask,
    reconcileTasks,
    flush,
    stop(): void {
      if (timer) clearInterval(timer)
    },
  }
}
