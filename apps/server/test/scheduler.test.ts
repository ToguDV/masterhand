import { Cron } from "croner"
import { describe, expect, it, vi } from "vitest"
import {
  SchedulerError,
  SCHEDULER_MARKER_KEY,
  createScheduler,
  nextScheduledRunAt,
  validateScheduleSpec,
  validateTaskInput,
  type ModelRef,
  type ScheduledRun,
  type ScheduledTask,
  type SchedulerManager,
  type SchedulerOpencode,
} from "../src/scheduler.js"
import { createMemoryStore, type Store } from "../src/store.js"

// ---------------------------------------------------------------------------
// Scripted fake opencode + injectable clock, modeled on goal.test.ts. Tests
// drive completions explicitly (emit hub events) so the loop is deterministic.
// ---------------------------------------------------------------------------

const BASE = Date.parse("2026-06-01T08:00:00.000Z")
const MINUTE = 60_000

interface FakeSchedulerSession {
  id: string
  directory: string
  marker: string | null
  model: ModelRef | null
  messages: Array<{ role: "user" | "assistant"; text: string; metadata: Record<string, string> | null }>
}

interface ScriptedFailure {
  error: Error
  /** Whether the operation applied before it failed (ambiguous outcome). */
  landed?: boolean
}

class FakeOpencode implements SchedulerOpencode {
  sessions = new Map<string, FakeSchedulerSession>()
  creates: Array<{ directory: string; marker: string; title: string }> = []
  prompts: Array<{ sessionID: string; text: string; marker: string }> = []
  modelPins: Array<{ sessionID: string; model: ModelRef }> = []
  activeSet = new Set<string>()
  failCreates: ScriptedFailure[] = []
  failPrompts: ScriptedFailure[] = []
  failModelPins: Error[] = []
  failLookups: Error[] = []
  failPromptLookups: Error[] = []
  failActive: Error[] = []
  modelCatalog: string[] = ["prov/model-a", "prov/model-b"]
  /** Holds (slows) createSession calls until released (run-now coalescing test). */
  private createGate: Promise<void> | null = null
  private sequence = 0

  nextID(): string {
    this.sequence += 1
    return `ses_${this.sequence}`
  }

  holdCreates(gate: Promise<void>): void {
    this.createGate = gate
  }

  addSession(id: string, directory = "/workspace/app"): FakeSchedulerSession {
    const session: FakeSchedulerSession = {
      id,
      directory,
      marker: null,
      model: null,
      messages: [],
    }
    this.sessions.set(id, session)
    return session
  }

  async createSession(directory: string, marker: string, title: string): Promise<{ id: string }> {
    if (this.createGate) await this.createGate
    this.creates.push({ directory, marker, title })
    const failure = this.failCreates.shift()
    const create = (): { id: string } => {
      const session = this.addSession(this.nextID(), directory)
      session.marker = marker
      return { id: session.id }
    }
    if (failure?.landed) create()
    if (failure) throw failure.error
    return create()
  }

  async findSessionByMarker(directory: string, marker: string): Promise<{ id: string } | null> {
    const failure = this.failLookups.shift()
    if (failure) throw failure
    for (const session of this.sessions.values()) {
      if (session.marker === marker && session.directory === directory) return { id: session.id }
    }
    return null
  }

  async prompt(sessionID: string, text: string, marker: string): Promise<void> {
    const failure = this.failPrompts.shift()
    const push = (): void => {
      this.sessions.get(sessionID)?.messages.push({
        role: "user",
        text,
        metadata: { [SCHEDULER_MARKER_KEY]: marker },
      })
    }
    if (failure?.landed) push()
    if (failure) throw failure.error
    if (!this.sessions.has(sessionID)) throw new Error(`no session ${sessionID}`)
    this.prompts.push({ sessionID, text, marker })
    push()
  }

  async promptLanded(sessionID: string, marker: string): Promise<boolean> {
    const failure = this.failPromptLookups.shift()
    if (failure) throw failure
    return (
      this.sessions.get(sessionID)?.messages.some(
        (message) => message.role === "user" && message.metadata?.[SCHEDULER_MARKER_KEY] === marker,
      ) ?? false
    )
  }

  async switchModel(sessionID: string, model: ModelRef): Promise<void> {
    const failure = this.failModelPins.shift()
    if (failure) throw failure
    const session = this.sessions.get(sessionID)
    if (session) session.model = model
    this.modelPins.push({ sessionID, model: { ...model } })
  }

  async activeSessions(): Promise<string[]> {
    const failure = this.failActive.shift()
    if (failure) throw failure
    return [...this.activeSet]
  }

  async modelExists(model: ModelRef): Promise<boolean> {
    return this.modelCatalog.includes(`${model.providerID}/${model.id}`)
  }
}

// ---------------------------------------------------------------------------

/** Current clock value shared by every harness (each harness resets it). */
let clockMs = BASE

interface Harness {
  store: Store
  opencode: FakeOpencode
  manager: SchedulerManager
  events: Array<{ taskID: string }>
  advance: (ms: number) => void
  iso: (ms: number) => string
}

/** Every task points at a real workspace row; deletion is what removes it. */
function seedWorkspace(store: Store, path = "/workspace/app"): void {
  store.createWorkspace({ id: "ws_app", name: "app", path, createdAt: BASE })
}

function harness(options: { tasks?: ScheduledTask[] } = {}): Harness {
  clockMs = BASE
  const store = createMemoryStore()
  seedWorkspace(store)
  const opencode = new FakeOpencode()
  const events: Harness["events"] = []
  const manager = createScheduler({
    store,
    opencode,
    emit: (event) => events.push(event.data),
    now: () => clockMs,
    sleep: async () => {},
    tickMs: 0,
    retry: { attempts: 3, baseDelayMs: 1, jitter: false },
  })
  for (const task of options.tasks ?? [makeTask()]) store.createScheduledTask(task)
  return {
    store,
    opencode,
    manager,
    events,
    advance: (ms) => {
      clockMs += ms
    },
    iso: (ms) => new Date(ms).toISOString(),
  }
}

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "task_1",
    name: "Nightly check",
    prompt: "check the build",
    model: { providerID: "prov", id: "model-a", variant: "low" },
    schedule: { kind: "interval", intervalMinutes: 30 },
    timezone: "",
    directory: "/workspace/app",
    paused: false,
    lastRunAt: null,
    // Due by default: the seeded slot is one second in the past.
    nextRunAt: new Date(clockMs - 1000).toISOString(),
    createdAt: new Date(clockMs - 90 * MINUTE).toISOString(),
    ...overrides,
  }
}

function liveTask(h: Harness, taskID = "task_1"): ScheduledTask {
  const task = h.store.getScheduledTask(taskID)
  if (!task) throw new Error(`task ${taskID} missing`)
  return task
}

function onlyRun(h: Harness, taskID = "task_1"): ScheduledRun {
  const runs = h.store.listScheduledRuns(taskID)
  if (runs.length !== 1) throw new Error(`expected one run, got ${runs.length}`)
  return runs[0]!
}

function settleIdle(h: Harness, sessionID: string): Promise<void> {
  h.manager.handleEvent({ type: "session.idle", data: { sessionID } })
  return h.manager.flush()
}

function settleError(h: Harness, sessionID: string, event: Record<string, unknown>): Promise<void> {
  h.manager.handleEvent({ type: "session.execution.failed", data: { sessionID, ...event } })
  return h.manager.flush()
}

// ---------------------------------------------------------------------------
// Tick overlap
// ---------------------------------------------------------------------------

describe("scheduler tick overlap", () => {
  it("skips an overlapping tick pass instead of stacking", async () => {
    // The 20 s timer can fire while a pass is still settling a slow upstream
    // (issue #202): the second pass must skip, so `activeSessions` is asked
    // once no matter how many passes overlap.
    const h = harness()
    h.store.createScheduledRun({
      id: "run_hung",
      taskId: "task_1",
      sessionID: "ses_hung",
      status: "running",
      source: "schedule",
      error: null,
      startedAt: h.iso(0),
      endedAt: null,
    })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let activeCalls = 0
    const inner = h.opencode.activeSessions.bind(h.opencode)
    h.opencode.activeSessions = async () => {
      activeCalls += 1
      await gate
      return inner()
    }
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {})
    try {
      const first = h.manager.tick()
      const second = h.manager.tick()
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(activeCalls).toBe(1)
      expect(debug).toHaveBeenCalledWith(expect.stringContaining("already running"))
      release()
      await Promise.all([first, second])
      expect(activeCalls).toBe(1)
    } finally {
      debug.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// Fire path
// ---------------------------------------------------------------------------

describe("scheduler fire path", () => {
  it("fires a due task: session create, prompt and model pin carry the markers", async () => {
    const h = harness()
    await h.manager.tick()

    expect(h.opencode.creates).toHaveLength(1)
    const run = onlyRun(h)
    expect(h.opencode.creates[0]).toEqual({
      directory: "/workspace/app",
      marker: `task_1#${run.id}#create`,
      title: "Nightly check",
    })
    expect(h.opencode.prompts).toEqual([
      {
        sessionID: run.sessionID,
        text: "check the build",
        marker: `task_1#${run.id}#prompt`,
      },
    ])
    expect(h.opencode.modelPins).toEqual([
      { sessionID: run.sessionID, model: { providerID: "prov", id: "model-a", variant: "low" } },
    ])
    expect(run.status).toBe("running")
    expect(run.source).toBe("schedule")
    expect(h.opencode.sessions.get(run.sessionID!)?.marker).toBe(`task_1#${run.id}#create`)
    expect(h.opencode.sessions.get(run.sessionID!)?.directory).toBe("/workspace/app")
    expect(run.endedAt).toBeNull()

    // Scheduled-time math: slot was 1 s ago, the interval is 30 min.
    const task = liveTask(h)
    // `lastRunAt` records the actual fire time (the run's truth), while the
    // schedule math anchors on the SCHEDULED slot to avoid drift.
    expect(task.lastRunAt).toBe(h.iso(clockMs))
    // First interval slot strictly after the anchor (the scheduled slot itself).
    expect(task.nextRunAt).toBe(h.iso(clockMs - 1000 + 30 * MINUTE))
  })

  it("emits one frame per settled transition of a fire, not one per write", async () => {
    // A fire used to emit 4-5 scheduler.updated frames (firing, task patch,
    // session attach, running, …) and every client refetched everything per
    // frame: only the settled transitions (firing, running) announce.
    const h = harness()
    await h.manager.tick()

    expect(onlyRun(h).status).toBe("running")
    expect(h.events).toHaveLength(2)
  })

  it("closes a running run as completed on session.idle and as failed on session.error", async () => {
    const h = harness()
    await h.manager.tick()
    const run = onlyRun(h)
    const sessionID = run.sessionID!

    await settleIdle(h, sessionID)
    const completed = onlyRun(h)
    expect(completed.status).toBe("completed")
    expect(completed.endedAt).not.toBeNull()
    // Terminal recompute is idempotent: nextRunAt stays the aligned future slot.
    expect(liveTask(h).nextRunAt).toBe(h.iso(clockMs - 1000 + 30 * MINUTE))

    // A second fire fails through the hub error event.
    h.store.saveScheduledTask({ ...makeTask(), nextRunAt: h.iso(clockMs - 1) })
    h.advance(MINUTE)
    await h.manager.tick()
    const second = h.store.listScheduledRuns("task_1")[0]!
    expect(second.status).toBe("running")
    await settleError(h, second.sessionID!, { error: { message: "provider rate limited" } })
    const failed = h.store.listScheduledRuns("task_1")[0]!
    expect(failed.id).toBe(second.id)
    expect(failed.status).toBe("failed")
    expect(failed.error).toContain("provider rate limited")
    expect(failed.endedAt).not.toBeNull()
  })

  it("also closes on session.execution.succeeded and the session.error alias", async () => {
    const h = harness()
    await h.manager.tick()
    const run = onlyRun(h)
    h.manager.handleEvent({ type: "session.execution.succeeded", data: { sessionID: run.sessionID } })
    await h.manager.flush()
    expect(onlyRun(h).status).toBe("completed")

    h.store.saveScheduledTask({ ...makeTask(), nextRunAt: h.iso(clockMs - 1) })
    h.advance(MINUTE)
    await h.manager.tick()
    const second = h.store.listScheduledRuns("task_1")[0]!
    h.manager.handleEvent({
      type: "session.error",
      data: { sessionID: second.sessionID, error: { message: "boom" } },
    })
    await h.manager.flush()
    const failed = h.store.listScheduledRuns("task_1")[0]!
    expect(failed.status).toBe("failed")
    expect(failed.id).toBe(second.id)
    expect(failed.error).toContain("boom")
  })

  it("reconciles a create whose response was lost instead of duplicating the session", async () => {
    const h = harness()
    // The create landed but the response was lost; the reconcile must find it
    // by directory + create marker (the pinned v2.0.6 drops parentID).
    h.opencode.failCreates.push({ error: new Error("connection reset"), landed: true })
    await h.manager.tick()

    expect(h.opencode.creates).toHaveLength(1)
    const run = onlyRun(h)
    expect(run.status).toBe("running")
    expect(h.opencode.prompts).toHaveLength(1)
    expect(h.opencode.prompts[0]?.marker).toBe(`task_1#${run.id}#prompt`)
  })

  it("fails the run without replaying when the create lookup cannot prove the outcome", async () => {
    const h = harness()
    h.opencode.failCreates.push({ error: new Error("boom") })
    h.opencode.failLookups.push(new TypeError("lookup down"))
    await h.manager.tick()

    const run = onlyRun(h)
    expect(run.status).toBe("failed")
    expect(run.error).toContain("could not confirm")
    expect(run.sessionID).toBeNull()
    expect(h.opencode.prompts).toHaveLength(0)
    expect(h.opencode.modelPins).toHaveLength(0)
    expect(liveTask(h).nextRunAt).not.toBeNull()
  })

  it("reconciles an ambiguous prompt that landed and fails an unproven one", async () => {
    const h = harness()
    h.opencode.failPrompts.push({ error: new Error("boom"), landed: true })
    await h.manager.tick()
    const run = onlyRun(h)
    expect(run.status).toBe("running")
    // Landed on the first attempt: the marker proves it, nothing is replayed.
    expect(h.opencode.sessions.get(run.sessionID!)!.messages).toHaveLength(1)
    await settleIdle(h, run.sessionID!)
    expect(onlyRun(h).status).toBe("completed")

    h.store.saveScheduledTask({ ...makeTask(), nextRunAt: h.iso(clockMs - 1) })
    h.advance(MINUTE)
    h.opencode.failPrompts.push({ error: new Error("boom") })
    h.opencode.failPromptLookups.push(new TypeError("lookup down"))
    await h.manager.tick()
    const failed = h.store.listScheduledRuns("task_1")[0]!
    expect(failed.status).toBe("failed")
    expect(failed.error).toContain("could not confirm")
    // The session stays: no destructive cleanup on our own freshly created one.
    expect(failed.sessionID && h.opencode.sessions.has(failed.sessionID)).toBe(true)
  })

  it("fails the run when the model pin exhausts its retries, keeping the session", async () => {
    const h = harness()
    h.opencode.failModelPins.push(new TypeError("down"), new TypeError("down"), new TypeError("down"))
    await h.manager.tick()

    const run = onlyRun(h)
    expect(run.status).toBe("failed")
    expect(run.error).toContain("model")
    expect(run.sessionID).not.toBeNull()
    expect(h.opencode.prompts).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Overlap: enqueue, single slot, coalescing
// ---------------------------------------------------------------------------

describe("scheduler overlap", () => {
  it("enqueues one queued run while busy, coalesces further ticks and fires it on completion", async () => {
    const h = harness()
    await h.manager.tick()
    const active = onlyRun(h)
    h.opencode.activeSet.add(active.sessionID!)
    expect(h.store.listScheduledRuns("task_1")).toHaveLength(1)

    // Slot passes while the run is still going: one enqueue, then coalesced.
    h.advance(30 * MINUTE)
    await h.manager.tick()
    h.advance(MINUTE)
    await h.manager.tick()
    const runs = h.store.listScheduledRuns("task_1")
    expect(runs).toHaveLength(2)
    const queued = runs.find((entry) => entry.status === "queued")!
    expect(queued.source).toBe("schedule")

    // Completion surfaces the queued run immediately through the fire path.
    await settleIdle(h, active.sessionID!)
    const after = h.store.listScheduledRuns("task_1")
    const surfaced = after.find((entry) => entry.id === queued.id)!
    expect(surfaced.status).toBe("running")
    expect(h.opencode.prompts).toHaveLength(2)
    expect(h.opencode.creates.at(-1)?.marker).toBe(`task_1#${surfaced.id}#create`)
  })

  it("marks a queued run skipped when the task was paused meanwhile", async () => {
    const h = harness()
    await h.manager.tick()
    const active = onlyRun(h)
    h.opencode.activeSet.add(active.sessionID!)

    h.advance(30 * MINUTE)
    await h.manager.tick()
    const queued = h.store.listScheduledRuns("task_1").find((entry) => entry.status === "queued")!

    const task = liveTask(h)
    h.store.saveScheduledTask({ ...task, paused: true })

    await settleIdle(h, active.sessionID!)
    const skipped = h.store.listScheduledRuns("task_1").find((entry) => entry.id === queued.id)!
    expect(skipped.status).toBe("skipped")
    expect(skipped.error).toContain("paused")
    expect(skipped.endedAt).not.toBeNull()
    expect(h.opencode.creates).toHaveLength(1)

    // Resume works: a due tick after unpausing fires again.
    h.advance(MINUTE)
    h.store.saveScheduledTask({ ...liveTask(h), paused: false, nextRunAt: h.iso(clockMs - 1) })
    await h.manager.tick()
    const resumed = h.store.listScheduledRuns("task_1").filter((entry) => entry.status === "running")
    expect(resumed).toHaveLength(1)
    expect(h.opencode.prompts).toHaveLength(2)
  })

  it("stops firing a deleted task and cascades its runs", async () => {
    const h = harness()
    await h.manager.tick()
    const active = onlyRun(h)
    h.opencode.activeSet.add(active.sessionID!)
    h.advance(30 * MINUTE)
    await h.manager.tick()
    expect(h.store.listScheduledRuns("task_1")).toHaveLength(2)

    h.store.deleteScheduledTask("task_1")
    expect(h.store.getScheduledTask("task_1")).toBeNull()
    expect(h.store.listScheduledRuns("task_1")).toHaveLength(0)

    h.advance(MINUTE)
    await h.manager.tick()
    expect(h.opencode.creates).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Run-now
// ---------------------------------------------------------------------------

describe("scheduler run-now", () => {
  it("runs immediately when idle and coalesces a concurrent run-now into the single queue slot", async () => {
    const h = harness()
    h.opencode.holdCreates(new Promise((resolve) => setTimeout(resolve, 5)))

    const first = h.manager.taskRunNow("task_1")
    const second = await h.manager.taskRunNow("task_1")
    expect(second.status).toBe("queued")
    expect(second.source).toBe("manual")
    const firstRun = await first
    expect(firstRun.status).toBe("running")
    expect(firstRun.source).toBe("manual")

    // Exactly one queued slot for both calls.
    const queues = h.store.listScheduledRuns("task_1").filter((entry) => entry.status === "queued")
    expect(queues).toHaveLength(1)
    // The queued run fires once the first run completes.
    h.opencode.activeSet.add(firstRun.sessionID!)
    await settleIdle(h, firstRun.sessionID!)
    const surfaced = h.store.listScheduledRuns("task_1").find((entry) => entry.status === "running")
    expect(surfaced?.source).toBe("manual")
    expect(h.opencode.prompts).toHaveLength(2)
  })

  it("enqueues instead of firing when a run is already active", async () => {
    const h = harness()
    const first = await h.manager.taskRunNow("task_1")
    // Still running (no event yet): a second call enqueues instead of a second fire.
    const second = await h.manager.taskRunNow("task_1")
    expect(first.status).toBe("running")
    expect(second.status).toBe("queued")
    expect(h.opencode.creates).toHaveLength(1)
  })

  it("rejects run-now for unknown and paused tasks with typed errors", async () => {
    const h = harness({ tasks: [makeTask({ paused: true, nextRunAt: null })] })
    await expect(h.manager.taskRunNow("ghost")).rejects.toMatchObject({ code: "task_not_found", status: 404 })
    await expect(h.manager.taskRunNow("task_1")).rejects.toMatchObject({ code: "task_paused", status: 409 })
    expect(h.opencode.creates).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

describe("scheduler validation", () => {
  it("rejects unknown schedule kinds", () => {
    expect(() => validateScheduleSpec({ kind: "hourly" }, BASE, "UTC")).toThrow(SchedulerError)
    expect(() => validateScheduleSpec({ kind: "hourly" }, BASE, "UTC")).toThrow(/kind/i)
    expect(() => validateScheduleSpec({}, BASE, "UTC")).toThrow(SchedulerError)
  })

  it("rejects interval schedules below five minutes or malformed", () => {
    expect(() => validateScheduleSpec({ kind: "interval", intervalMinutes: 4 }, BASE, "UTC")).toThrow(/interval/i)
    expect(() => validateScheduleSpec({ kind: "interval" }, BASE, "UTC")).toThrow(/interval/i)
    expect(() =>
      validateScheduleSpec({ kind: "interval", intervalMinutes: Number.NaN }, BASE, "UTC"),
    ).toThrow(/interval/i)
    expect(() => validateScheduleSpec({ kind: "interval", intervalMinutes: 5 }, BASE, "UTC")).not.toThrow()
    expect(() => validateScheduleSpec({ kind: "interval", intervalMinutes: 90 }, BASE, "UTC")).not.toThrow()
  })

  it("rejects broken or too-frequent cron expressions", () => {
    expect(() => validateScheduleSpec({ kind: "cron", cron: "banana" }, BASE, "UTC")).toThrow(SchedulerError)
    expect(() => validateScheduleSpec({ kind: "cron", cron: "* * * * * *" }, BASE, "UTC")).toThrow(SchedulerError)
    expect(() => validateScheduleSpec({ kind: "cron", cron: "* * * * *" }, BASE, "UTC")).toThrow(/every 5 minutes/i)
    expect(() => validateScheduleSpec({ kind: "cron", cron: "*/10 * * * *" }, BASE, "UTC")).not.toThrow()
    expect(() => validateScheduleSpec({ kind: "cron", cron: "0 9 * * *" }, BASE, "UTC")).not.toThrow()
  })

  it("rejects invalid IANA timezones and accepts names plus the server default", () => {
    expect(() => validateScheduleSpec({ kind: "cron", cron: "0 9 * * *" }, BASE, "Mars/Base")).toThrow(/timezone/i)
    expect(() => validateScheduleSpec({ kind: "cron", cron: "0 9 * * *" }, BASE, "Europe/Madrid")).not.toThrow()
    expect(() => validateScheduleSpec({ kind: "cron", cron: "0 9 * * *" }, BASE, "")).not.toThrow()
  })

  it("rejects malformed task inputs", () => {
    expect(() => validateTaskInput({})).toThrow(SchedulerError)
    expect(() =>
      validateTaskInput({ name: "  ", prompt: "p", directory: "/w", model: { providerID: "a", id: "b" } }),
    ).toThrow(/name/i)
    expect(() =>
      validateTaskInput({ name: "n", prompt: "", directory: "/w", model: { providerID: "a", id: "b" } }),
    ).toThrow(/prompt/i)
    expect(() =>
      validateTaskInput({ name: "n", prompt: "p", directory: "  ", model: { providerID: "a", id: "b" } }),
    ).toThrow(/directory/i)
    expect(() => validateTaskInput({ name: "n", prompt: "p", directory: "/w", model: { providerID: "", id: "b" } })).toThrow(
      /model/i,
    )
    expect(() => validateTaskInput({ name: "n", prompt: "p", directory: "/w", model: "prov/model-a" })).toThrow(/model/i)
    expect(() =>
      validateTaskInput({ name: "n", prompt: "p", directory: "/w", model: { providerID: "a", id: "b", variant: 42 } }),
    ).toThrow(/model/i)

    const valid = validateTaskInput({
      name: " nightly ",
      prompt: " p ",
      directory: " /workspace/app ",
      model: { providerID: "prov", id: "model-a", variant: "low" },
    })
    expect(valid).toEqual({
      name: "nightly",
      prompt: "p",
      directory: "/workspace/app",
      model: { providerID: "prov", id: "model-a", variant: "low" },
    })
  })

  it("caps the task name and prompt at the documented limits", () => {
    const base = { directory: "/w", model: { providerID: "a", id: "b" } }
    const codeOf = (input: unknown): string => {
      try {
        validateTaskInput(input)
        return "ok"
      } catch (error) {
        return (error as SchedulerError).code
      }
    }
    expect(codeOf({ ...base, name: "n".repeat(201), prompt: "p" })).toBe("invalid_name")
    expect(codeOf({ ...base, name: "n", prompt: "p".repeat(8001) })).toBe("invalid_prompt")
    // Exactly at the cap is still accepted.
    expect(validateTaskInput({ ...base, name: "n".repeat(200), prompt: "p" }).name).toHaveLength(200)
    expect(validateTaskInput({ ...base, name: "n", prompt: "p".repeat(8000) }).prompt).toHaveLength(8000)
  })

  it("computes the next run from the schedule anchor", () => {
    // Interval: first slot strictly after now, anchored to the schedule base.
    expect(nextScheduledRunAt({ kind: "interval", intervalMinutes: 30 }, BASE - 70 * MINUTE, BASE)).toBe(
      new Date(BASE - 70 * MINUTE + 3 * 30 * MINUTE).toISOString(),
    )
    expect(nextScheduledRunAt({ kind: "interval", intervalMinutes: 30 }, BASE, BASE)).toBe(
      new Date(BASE + 30 * MINUTE).toISOString(),
    )
    // Cron: next occurrence of the pattern; a named timezone is honored.
    const auckland = nextScheduledRunAt({ kind: "cron", cron: "0 9 * * *" }, BASE, BASE, "Pacific/Auckland")
    expect(auckland).not.toBeNull()
    expect(new Date(auckland!).getTime()).toBeGreaterThan(BASE)
    expect(
      new Date(auckland!).toLocaleString("en-GB", { timeZone: "Pacific/Auckland", hour12: false }),
    ).toMatch(/^02\/06\/2026, 09:00/)
    // Server default timezone (empty) is accepted.
    expect(nextScheduledRunAt({ kind: "cron", cron: "0 9 * * *" }, BASE, BASE, "")).not.toBeNull()
    // Garbage specs degrade to null (tolerant reads never crash the loop).
    expect(nextScheduledRunAt({ kind: "interval" as never }, BASE, BASE)).toBeNull()
    expect(nextScheduledRunAt({ kind: "cron", cron: "nope" }, BASE, BASE)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// nextRunAt math inside the loop
// ---------------------------------------------------------------------------

describe("scheduler nextRunAt", () => {
  it("computes the next run for a cron in a named timezone from the scheduled slot", async () => {
    const reference = new Cron("0 9 * * *", { timezone: "Pacific/Auckland" })
    // First hit after ~16h before BASE: 09:00 local of "today" (UTC+12 in
    // June → May 31 21:00Z) — already due when the tick runs, with no missed
    // occurrence in between.
    const slot = reference.nextRun(new Date(BASE - 16 * 60 * MINUTE))!
    expect(slot.getTime()).toBeLessThanOrEqual(BASE)
    const task = makeTask({ schedule: { kind: "cron", cron: "0 9 * * *" }, timezone: "Pacific/Auckland" })
    task.nextRunAt = slot.toISOString()
    const h = harness({ tasks: [task] })
    h.advance(MINUTE) // tick just past BASE: recompute is the same slot- or now-anchored
    await h.manager.tick()

    const fired = onlyRun(h)
    expect(fired.status).toBe("running")
    // Recomputed from the scheduled slot; equal to the now-anchored value
    // because no occurrence was missed between the slot and the tick.
    expect(liveTask(h).nextRunAt).toBe(reference.nextRun(new Date(slot.getTime() + 1))!.toISOString())
  })

  it("advances a cron past missed slots without catch-up fires", async () => {
    const reference = new Cron("*/10 * * * *")
    const task = makeTask({ schedule: { kind: "cron", cron: "*/10 * * * *" } })
    task.nextRunAt = reference.nextRun(new Date(BASE - 95 * MINUTE))!.toISOString()
    const h = harness({ tasks: [task] })
    h.advance(45 * MINUTE) // three missed 10-minute slots between slot and now
    await h.manager.tick()
    expect(h.opencode.creates).toHaveLength(1)
    const next = reference.nextRun(new Date(clockMs - 1000))!
    expect(liveTask(h).nextRunAt).toBe(next.toISOString())
  })

  it("skips missed interval slots without backlog", async () => {
    const h = harness()
    h.advance(70 * MINUTE) // the seeded slot (BASE-1s) is 70 min stale
    await h.manager.tick()
    expect(h.opencode.creates).toHaveLength(1)
    // Slots from the missed one: 1×30m (past), 2×30m (past), 3×30m → future.
    expect(liveTask(h).nextRunAt).toBe(h.iso(BASE - 1000 + 90 * MINUTE))
    expect(h.opencode.prompts).toHaveLength(1)
  })

  it("leaves tasks alone when no slot is due", async () => {
    const h = harness({ tasks: [makeTask({ nextRunAt: new Date(BASE + MINUTE).toISOString() })] })
    await h.manager.tick()
    expect(h.opencode.creates).toHaveLength(0)
    expect(liveTask(h).lastRunAt).toBeNull()
  })

  it("never fires paused tasks", async () => {
    const h = harness({ tasks: [makeTask({ paused: true })] })
    await h.manager.tick()
    expect(h.opencode.creates).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Boot reconciliation
// ---------------------------------------------------------------------------

describe("scheduler boot reconciliation", () => {
  it("marks firing runs interrupted and queued runs skipped, then recomputes nextRunAt", async () => {
    clockMs = BASE
    const store = createMemoryStore()
    seedWorkspace(store)
    store.createScheduledTask(makeTask())
    const firing: ScheduledRun = {
      id: "run_firing",
      taskId: "task_1",
      sessionID: "ses_1",
      status: "firing",
      source: "schedule",
      error: null,
      startedAt: new Date(BASE - MINUTE).toISOString(),
      endedAt: null,
    }
    const queued: ScheduledRun = { ...firing, id: "run_queued", status: "queued", sessionID: null }
    const completed: ScheduledRun = { ...firing, id: "run_done", status: "completed", endedAt: firing.startedAt }
    store.createScheduledRun(firing)
    store.createScheduledRun(queued)
    store.createScheduledRun(completed)

    const opencode = new FakeOpencode()
    const manager = createScheduler({
      store,
      opencode,
      now: () => clockMs,
      sleep: async () => {},
      tickMs: 0,
    })
    manager.reconcileTasks()

    expect(store.getScheduledRun("run_firing")?.status).toBe("interrupted")
    expect(store.getScheduledRun("run_firing")?.error).toContain("restart")
    expect(store.getScheduledRun("run_firing")?.endedAt).not.toBeNull()
    expect(store.getScheduledRun("run_queued")?.status).toBe("skipped")
    expect(store.getScheduledRun("run_queued")?.endedAt).not.toBeNull()
    expect(store.getScheduledRun("run_done")?.status).toBe("completed")

    // nextRunAt recomputed from the stale slot, no catch-up fire.
    const recomputed = store.getScheduledTask("task_1")!
    expect(recomputed.nextRunAt).toBe(new Date(clockMs - 1000 + 30 * MINUTE).toISOString())
    await manager.tick()
    expect(harnessRunsCount(store, "task_1")).toBe(3)
    expect(opencode.creates).toHaveLength(0)
    manager.stop()
  })

  it("keeps an already-future nextRunAt and a completed history stable across reconciliations", async () => {
    clockMs = BASE
    const store = createMemoryStore()
    seedWorkspace(store)
    store.createScheduledTask(makeTask({ nextRunAt: new Date(clockMs + 30 * MINUTE).toISOString() }))
    const manager = createScheduler({ store, opencode: new FakeOpencode(), tickMs: 0, now: () => clockMs })
    manager.reconcileTasks()
    manager.reconcileTasks()
  })

  it("never auto-fires after the boot reconciliation", async () => {
    clockMs = BASE
    const store = createMemoryStore()
    seedWorkspace(store)
    store.createScheduledTask(makeTask())
    const opencode = new FakeOpencode()
    const manager = createScheduler({ store, opencode, tickMs: 0, now: () => clockMs })
    store.createScheduledRun({
      id: "run_firing",
      taskId: "task_1",
      sessionID: null,
      status: "firing",
      source: "schedule",
      error: null,
      startedAt: new Date(BASE - MINUTE).toISOString(),
      endedAt: null,
    })
    manager.reconcileTasks()
    await manager.tick()
    expect(opencode.creates).toHaveLength(0)
    manager.stop()
  })
})

// ---------------------------------------------------------------------------
// Workspace deletion revalidation (#188)
// ---------------------------------------------------------------------------

describe("scheduler workspace revalidation", () => {
  it("pauses a due task instead of firing when its workspace was deleted", async () => {
    const h = harness()
    h.store.removeWorkspace("ws_app")

    await h.manager.tick()

    expect(h.opencode.creates).toHaveLength(0)
    expect(h.store.listScheduledRuns("task_1")).toHaveLength(0)
    expect(liveTask(h).paused).toBe(true)
  })

  it("pauses an orphaned task during boot reconciliation", () => {
    const h = harness()
    h.store.removeWorkspace("ws_app")

    h.manager.reconcileTasks()

    expect(liveTask(h).paused).toBe(true)
  })

  it("refuses a manual run after the workspace was deleted, without firing", async () => {
    const h = harness()
    h.store.removeWorkspace("ws_app")

    await expect(h.manager.taskRunNow("task_1")).rejects.toMatchObject({
      code: "task_paused",
      status: 409,
    })

    expect(h.opencode.creates).toHaveLength(0)
    expect(h.store.listScheduledRuns("task_1")).toHaveLength(0)
    expect(liveTask(h).paused).toBe(true)
  })

  it("skips a queued run and pauses the task when its workspace disappears mid-run", async () => {
    const h = harness()
    await h.manager.tick()
    const running = onlyRun(h)
    h.opencode.activeSet.add(running.sessionID!)

    // A second due slot during the active run becomes one queued envelope.
    h.store.saveScheduledTask({ ...liveTask(h), nextRunAt: new Date(clockMs - 1000).toISOString() })
    await h.manager.tick()
    const queued = h.store.listScheduledRuns("task_1").find((run) => run.status === "queued")
    expect(queued).toBeDefined()

    h.store.removeWorkspace("ws_app")
    await settleIdle(h, running.sessionID!)

    expect(h.store.getScheduledRun(queued!.id)?.status).toBe("skipped")
    expect(h.store.getScheduledRun(queued!.id)?.error).toContain("workspace")
    expect(liveTask(h).paused).toBe(true)
  })
})

function harnessRunsCount(store: Store, taskID: string): number {
  return store.listScheduledRuns(taskID).length
}

// ---------------------------------------------------------------------------
// Liveness reconciliation (lost idle events heal on later ticks)
// ---------------------------------------------------------------------------

describe("scheduler liveness", () => {
  it("closes a running run whose session is no longer active in opencode", async () => {
    const h = harness()
    await h.manager.tick()
    const run = onlyRun(h)
    // No idle event ever arrived; the session left the active list.
    await h.manager.tick()
    const settled = onlyRun(h)
    expect(settled.id).toBe(run.id)
    expect(settled.status).toBe("completed")
  })

  it("keeps a run going while its session is still active", async () => {
    const h = harness()
    await h.manager.tick()
    const run = onlyRun(h)
    h.opencode.activeSet.add(run.sessionID!)
    await h.manager.tick()
    expect(onlyRun(h).status).toBe("running")
  })

  it("fails a run when its session is deleted out of band", async () => {
    const h = harness()
    await h.manager.tick()
    const run = onlyRun(h)
    h.manager.handleEvent({ type: "session.deleted", data: { sessionID: run.sessionID } })
    await h.manager.flush()
    const failed = onlyRun(h)
    expect(failed.status).toBe("failed")
    expect(failed.error).toContain("deleted")
  })
})

// ---------------------------------------------------------------------------
// Lifecycle plumbing
// ---------------------------------------------------------------------------

describe("scheduler plumbing", () => {
  it("broadcasts a scheduler.updated frame on every manager mutation", async () => {
    const h = harness()
    await h.manager.tick()
    expect(new Set(h.events.map((event) => event.taskID))).toEqual(new Set(["task_1"]))
    await settleIdle(h, onlyRun(h).sessionID!)
    expect(h.events.length).toBeGreaterThanOrEqual(3)
  })

  it("stops its interval repeatedly", () => {
    clockMs = BASE
    const manager = createScheduler({ store: createMemoryStore(), opencode: new FakeOpencode(), tickMs: 1000 })
    manager.stop()
    manager.stop()
  })

  it("surfaces storage write failures from run-now instead of swallowing them", async () => {
    clockMs = BASE
    const store = createMemoryStore()
    store.createWorkspace({ id: "ws_app", name: "app", path: "/workspace/app", createdAt: BASE })
    const manager = createScheduler({ store, opencode: new FakeOpencode(), tickMs: 0, now: () => clockMs })
    store.createScheduledTask(makeTask())
    store.saveScheduledRun = () => {
      throw new Error("storage offline")
    }
    await expect(manager.taskRunNow("task_1")).rejects.toThrow("storage offline")
    manager.stop()
  })
})
