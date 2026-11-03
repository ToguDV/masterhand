import { describe, expect, it } from "vitest"
import { createScheduler, type SchedulerOpencode } from "../src/scheduler.js"
import { createSqliteStore, type Store } from "../src/store.js"

const NOW = 1_700_000_000_000

function setup(options: { assistant?: { id: string; completed: boolean; createdAt: number | null } | null } = {}) {
  const store: Store = createSqliteStore(":memory:")
  let clock = NOW
  const prompts: Array<{ sessionID: string; text: string; marker: string }> = []
  const active = new Set<string>()
  let created = 0
  let assistant = options.assistant ?? null
  const opencode: SchedulerOpencode = {
    async createSession() {
      created += 1
      return { id: `ses_new_${created}` }
    },
    async findSessionByMarker() {
      return null
    },
    async prompt(sessionID, text, marker) {
      prompts.push({ sessionID, text, marker })
      active.add(sessionID)
    },
    async promptLanded() {
      return true
    },
    async switchModel() {},
    async activeSessions() {
      return [...active]
    },
    async lastAssistant() {
      return assistant
    },
  }
  store.createWorkspace({ id: "ws_1", name: "app", path: "/workspace/app", createdAt: NOW })
  const startedAt = new Date(NOW).toISOString()
  store.createScheduledTask({
    id: "task_1",
    name: "nightly",
    prompt: "Run the checks",
    model: { providerID: "test", id: "model" },
    schedule: { kind: "interval", intervalMinutes: 5 },
    timezone: "",
    directory: "/workspace/app",
    paused: false,
    lastRunAt: null,
    nextRunAt: new Date(NOW + 300_000).toISOString(),
    createdAt: startedAt,
  })
  store.createScheduledRun({
    id: "run_1",
    taskId: "task_1",
    sessionID: "ses_old",
    status: "running",
    source: "schedule",
    error: null,
    startedAt,
    endedAt: null,
  })
  const scheduler = createScheduler({
    store,
    opencode,
    now: () => clock,
    sleep: async () => {},
    tickMs: 0,
    retry: { attempts: 1, baseDelayMs: 0, jitter: false },
    recoveryGapMs: 0,
    engineGraceMs: 30_000,
  })
  return {
    store,
    prompts,
    scheduler,
    startedAt,
    advance(ms: number) {
      clock += ms
    },
    setAssistant(value: typeof assistant) {
      assistant = value
    },
  }
}

describe("scheduler recovery", () => {
  it("finds the newest run that used a session (recovery ownership)", () => {
    const h = setup()
    expect(h.store.getScheduledRunBySession("ses_old")).toMatchObject({ id: "run_1", taskId: "task_1" })
    expect(h.store.getScheduledRunBySession("ses_missing")).toBeNull()
  })

  it("marks a dead turn interrupted and re-fires it once with the recovery note", async () => {
    const h = setup({ assistant: { id: "msg_old", completed: true, createdAt: NOW - 10_000 } })
    await h.scheduler.recoverInterruptedRuns()

    expect(h.store.getScheduledRun("run_1")).toMatchObject({ status: "interrupted" })
    expect(h.store.getScheduledRun("run_1")?.error).toContain("previous turn ended")
    const runs = h.store.listScheduledRuns("task_1", { limit: 10 })
    expect(runs).toHaveLength(2)
    const recovered = runs.find((run) => run.id !== "run_1")!
    expect(recovered.status).toBe("running")
    expect(h.prompts).toHaveLength(1)
    expect(h.prompts[0]!.text).toContain("MasterHand restarted or your previous turn was interrupted")
    expect(h.prompts[0]!.text).toContain("Run the checks")
  })

  it("closes a turn that actually completed as completed and does not re-fire", async () => {
    const h = setup({ assistant: { id: "msg_new", completed: true, createdAt: NOW + 1_000 } })
    await h.scheduler.recoverInterruptedRuns()
    expect(h.store.getScheduledRun("run_1")).toMatchObject({ status: "completed" })
    expect(h.store.listScheduledRuns("task_1", { limit: 10 })).toHaveLength(1)
    expect(h.prompts).toHaveLength(0)
  })

  it("re-fires from the tick path and the later recovery does not double-drive it", async () => {
    const h = setup({ assistant: { id: "msg_old", completed: true, createdAt: NOW - 10_000 } })
    await h.scheduler.tick()
    expect(h.store.getScheduledRun("run_1")).toMatchObject({ status: "interrupted" })
    expect(h.prompts).toHaveLength(1)
    await h.scheduler.recoverInterruptedRuns()
    expect(h.store.listScheduledRuns("task_1", { limit: 10 })).toHaveLength(2)
    expect(h.prompts).toHaveLength(1)
  })

  it("defers a tick re-fire during the engine health grace", async () => {
    const h = setup({ assistant: { id: "msg_old", completed: true, createdAt: NOW - 10_000 } })
    h.scheduler.engineRestarted()
    await h.scheduler.tick()
    expect(h.prompts).toHaveLength(0)
    expect(h.store.getScheduledRun("run_1")).toMatchObject({ status: "running" })
    h.advance(30_001)
    await h.scheduler.tick()
    expect(h.prompts).toHaveLength(1)
  })

  it("does not re-fire a paused task", async () => {
    const h = setup({ assistant: null })
    const task = h.store.getScheduledTask("task_1")!
    h.store.saveScheduledTask({ ...task, paused: true })
    await h.scheduler.recoverInterruptedRuns()
    expect(h.store.getScheduledRun("run_1")).toMatchObject({ status: "interrupted" })
    expect(h.store.listScheduledRuns("task_1", { limit: 10 })).toHaveLength(1)
    expect(h.prompts).toHaveLength(0)
  })
})
