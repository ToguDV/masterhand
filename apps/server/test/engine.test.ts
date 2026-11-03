import { describe, expect, it, vi } from "vitest"
import { createEngineMonitor, resumePrompt } from "../src/engine.js"
import { createTurnJournal } from "../src/journal.js"
import type { TurnOpencode } from "../src/opencode.js"
import { OpencodeTimeoutError } from "../src/retry.js"
import type { GoalManager } from "../src/goal.js"
import type { SchedulerManager } from "../src/scheduler.js"
import { createSqliteStore, type Store, type TurnRecord } from "../src/store.js"
import type { SupervisorClient, SupervisorServiceSnapshot, SupervisorStatus } from "../src/supervisor.js"

class FakeTurnOpencode implements TurnOpencode {
  active = new Set<string>()
  sessions = new Map<string, { directory: string; parentID: string | null; metadata: Record<string, unknown> | null }>()
  assistants = new Map<string, { id: string; text: string; completed: boolean; createdAt: number | null }>()
  prompts: Array<{ sessionID: string; text: string; marker: string }> = []
  landed = new Set<string>()
  promptError: Error | null = null
  landedError: Error | null = null
  activeError: Error | null = null
  assistantError: Error | null = null

  add(sessionID: string, options: { parentID?: string; directories?: string; metadata?: Record<string, unknown> } = {}) {
    this.sessions.set(sessionID, {
      directory: options.directories ?? "/workspace/app",
      parentID: options.parentID ?? null,
      metadata: options.metadata ?? null,
    })
  }

  async activeSessions(): Promise<string[]> {
    if (this.activeError) throw this.activeError
    return [...this.active]
  }

  async sessionInfo(sessionID: string) {
    return this.sessions.get(sessionID) ?? null
  }

  async lastAssistant(sessionID: string) {
    if (this.assistantError) throw this.assistantError
    return this.assistants.get(sessionID) ?? null
  }

  async prompt(sessionID: string, text: string, marker: string): Promise<void> {
    if (this.promptError) {
      if (this.promptError instanceof OpencodeTimeoutError) this.landed.add(marker)
      throw this.promptError
    }
    this.prompts.push({ sessionID, text, marker })
    this.landed.add(marker)
  }

  async promptLanded(_sessionID: string, marker: string): Promise<boolean> {
    if (this.landedError) throw this.landedError
    return this.landed.has(marker)
  }
}

function healthyService(overrides: Partial<SupervisorServiceSnapshot> = {}): SupervisorServiceSnapshot {
  return {
    service: "opencode",
    state: "running",
    health: "healthy",
    memory: { usedBytes: 100, limitBytes: 1000 },
    attempts: 0,
    maxAttempts: 3,
    circuitOpen: false,
    restarting: false,
    memoryWarning: false,
    lastIncident: null,
    ...overrides,
  }
}

function harness(options: {
  service?: Partial<SupervisorServiceSnapshot>
  autoContinueChats?: boolean
  maxChatResumes?: number
  recoveryTimeoutMs?: number
  recoveryMinOutageMs?: number
  statusPollMs?: number
  probe?: () => Promise<boolean>
} = {}) {
  const store: Store = createSqliteStore(":memory:")
  const events: unknown[] = []
  const listeners = new Set<(event: unknown) => void>()
  let connected = true
  let clock = 1_000
  const hub = {
    start() {},
    stop() {},
    subscribe(listener: (event: unknown) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit(event: unknown) {
      for (const listener of listeners) listener(event)
    },
    get connected() {
      return connected
    },
  }
  const journal = createTurnJournal({ store, now: () => clock, pruneIntervalMs: 0, emit: (event) => events.push(event) })
  const opencode = new FakeTurnOpencode()
  const goals = {
    recoverInterrupted: vi.fn(async () => {}),
    pauseInterrupted: vi.fn(),
  } as unknown as GoalManager
  const scheduler = {
    recoverInterruptedRuns: vi.fn(async () => {}),
    engineRestarted: vi.fn(),
  } as unknown as SchedulerManager
  const service = healthyService(options.service)
  const status: SupervisorStatus = { services: { opencode: service } }
  const supervisor: SupervisorClient = {
    enabled: true,
    status: vi.fn(async () => status),
    restart: vi.fn(async () => ({ ok: true })),
    reset: vi.fn(async () => ({ ok: true })),
  }
  const engine = createEngineMonitor({
    store,
    hub,
    journal,
    goals,
    scheduler,
    opencode,
    supervisor,
    probeOpencode: options.probe ?? (async () => true),
    emit: (event) => events.push(event),
    now: () => clock,
    sleep: async (ms) => {
      clock += Math.max(1, ms)
    },
    autoResume: true,
    autoContinueChats: options.autoContinueChats ?? true,
    maxChatResumes: options.maxChatResumes ?? 3,
    resumeGapMs: 0,
    recoveryTimeoutMs: options.recoveryTimeoutMs ?? 1_000,
    recoveryMinOutageMs: options.recoveryMinOutageMs ?? 0,
    healthGraceMs: 0,
    statusPollMs: options.statusPollMs ?? 0,
    retry: { attempts: 1, baseDelayMs: 0 },
    log: () => {},
  })
  function openTurn(sessionID: string, startedAt = 1_000): TurnRecord {
    const turn: TurnRecord = {
      sessionID,
      workspacePath: "/workspace/app",
      startedAt,
      lastEventAt: startedAt,
      state: "running",
      origin: "chat",
      reason: null,
      resumeAttempts: 0,
      lastResumeAt: null,
    }
    store.saveTurn(turn)
    opencode.add(sessionID)
    return turn
  }
  return {
    store,
    hub,
    journal,
    opencode,
    goals,
    scheduler,
    supervisor,
    engine,
    events,
    openTurn,
    service,
    status,
    advance(ms: number) {
      clock += ms
    },
    setConnected(value: boolean) {
      connected = value
    },
  }
}

describe("engine recovery", () => {
  it("classifies a dead chat turn as interrupted and auto-continues it with the safe prompt", async () => {
    const h = harness({
      service: { lastIncident: { at: 900, service: "opencode", reason: "oom", attempt: 1, memory: null } },
    })
    h.openTurn("ses_chat")

    await h.engine.recoverNow()

    expect(h.opencode.prompts).toHaveLength(1)
    const prompt = h.opencode.prompts[0]!
    expect(prompt.sessionID).toBe("ses_chat")
    expect(prompt.text).toContain("automatic continuation sent by MasterHand")
    expect(prompt.text).toContain("ran out of memory")
    expect(prompt.text).toContain("may be lost or left half-finished")
    expect(prompt.text).toContain("Check the current state")
    expect(prompt.text).toContain("heavy")
    expect(prompt.text).toContain("force another restart")
    expect(h.journal.get("ses_chat")).toMatchObject({ state: "resumed", resumeAttempts: 1 })
    expect(h.events).toContainEqual(expect.objectContaining({ type: "turn.interrupted" }))
  })

  it("does not continue a turn whose assistant reply completed after it started", async () => {
    const h = harness()
    h.openTurn("ses_done")
    h.opencode.assistants.set("ses_done", { id: "msg_1", text: "done", completed: true, createdAt: 1_500 })

    await h.engine.recoverNow()

    expect(h.opencode.prompts).toHaveLength(0)
    expect(h.journal.get("ses_done")?.state).toBe("completed")
  })

  it("never continues a user-cancelled turn", async () => {
    const h = harness()
    h.openTurn("ses_cancelled")
    h.journal.close("ses_cancelled", "cancelled")
    await h.engine.recoverNow()
    expect(h.opencode.prompts).toHaveLength(0)
  })

  it("skips internal goal sessions", async () => {
    const h = harness()
    h.store.saveGoalRun({
      sessionID: "ses_goal",
      runToken: "t",
      goal: "x",
      state: "running",
      round: 1,
      maxRounds: 5,
      mainModel: null,
      criticModel: null,
      judgeModel: null,
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
      createdAt: 1,
      updatedAt: 1,
    })
    h.openTurn("ses_goal")
    await h.engine.recoverNow()
    expect(h.journal.get("ses_goal")).toBeNull()
    expect(h.opencode.prompts).toHaveLength(0)
  })

  it("guards the manual continuation against an internal session by metadata/store", async () => {
    const h = harness()
    h.openTurn("ses_metadata")
    h.opencode.sessions.set("ses_metadata", {
      directory: "/workspace/app",
      parentID: null,
      metadata: { "masterhand.scheduler": "x" },
    })
    h.journal.close("ses_metadata", "interrupted", "engine")
    expect((await h.engine.resumeTurn("ses_metadata")).reason).toBe("internal_turn")
    expect(h.opencode.prompts).toHaveLength(0)
    expect(h.journal.get("ses_metadata")).toBeNull()

    h.store.saveGoalRun({
      sessionID: "ses_goal_main",
      runToken: "t",
      goal: "x",
      state: "running",
      round: 1,
      maxRounds: 5,
      mainModel: null,
      criticModel: null,
      judgeModel: null,
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
      createdAt: 1,
      updatedAt: 1,
    })
    h.openTurn("ses_goal_main")
    h.journal.close("ses_goal_main", "interrupted", "engine")
    expect((await h.engine.resumeTurn("ses_goal_main")).reason).toBe("internal_turn")
    expect(h.opencode.prompts).toHaveLength(0)
  })

  it("caps automatic continuations at maxChatResumes", async () => {
    const h = harness({ maxChatResumes: 3 })
    for (const id of ["ses_1", "ses_2", "ses_3", "ses_4"]) h.openTurn(id)
    await h.engine.recoverNow()
    expect(h.opencode.prompts).toHaveLength(3)
  })

  it("counts the per-incident chat budget across recovery passes", async () => {
    const h = harness({ maxChatResumes: 1 })
    h.openTurn("ses_1")
    await h.engine.recoverNow()
    expect(h.opencode.prompts).toHaveLength(1)
    h.openTurn("ses_2")
    h.journal.close("ses_2", "interrupted", "engine")
    await h.engine.recoverNow()
    expect(h.opencode.prompts).toHaveLength(1)
  })

  it("pauses goals and never continues when the supervisor circuit is open", async () => {
    const h = harness({ service: { circuitOpen: true } })
    h.openTurn("ses_chat")
    await h.engine.recoverNow()
    expect(h.goals.pauseInterrupted).toHaveBeenCalled()
    expect(h.opencode.prompts).toHaveLength(0)
    expect(h.journal.get("ses_chat")?.state).toBe("interrupted")
  })

  it("coalesces two manual continuation taps into one prompt", async () => {
    const h = harness()
    h.openTurn("ses_chat")
    await h.engine.recoverNow()
    // Simulate a failed continuation state without sending: reset to interrupted.
    const turn = h.journal.get("ses_chat")!
    h.store.saveTurn({ ...turn, state: "interrupted", resumeAttempts: 1 })
    h.opencode.prompts = []
    const first = h.engine.resumeTurn("ses_chat", { automatic: false })
    const second = h.engine.resumeTurn("ses_chat", { automatic: false })
    const [a, b] = await Promise.all([first, second])
    expect(a).toEqual(b)
    expect(h.opencode.prompts).toHaveLength(1)
  })

  it("marks an ambiguous continuation and does not retry blind", async () => {
    const h = harness()
    h.openTurn("ses_chat")
    h.opencode.promptError = new OpencodeTimeoutError()
    h.opencode.landedError = new TypeError("network down")
    await h.engine.recoverNow()
    expect(h.journal.get("ses_chat")?.state).toBe("ambiguous")
    expect(h.opencode.prompts).toHaveLength(0)
  })

  it("reports supervisor state and interrupted turns", async () => {
    const h = harness({ service: { attempts: 2, lastIncident: { at: 900, service: "opencode", reason: "oom", attempt: 2, memory: null } } })
    h.openTurn("ses_chat")
    await h.engine.recoverNow()
    h.store.saveTurn({ ...h.journal.get("ses_chat")!, state: "interrupted" })
    const status = await h.engine.status()
    expect(status).toMatchObject({
      supervisor: true,
      healthy: true,
      attempts: 2,
      maxAttempts: 3,
      circuitOpen: false,
      interruptedTurns: 1,
    })
    expect(status.lastIncident?.reason).toBe("oom")
  })

  it("recovers on a hub reconnect after a real outage", async () => {
    const h = harness({ maxChatResumes: 0 })
    h.engine.start()
    h.openTurn("ses_chat")
    h.hub.emit({ type: "hub.disconnected", data: {} })
    h.hub.emit({ type: "hub.connected", data: {} })
    await vi.waitFor(() => expect(h.goals.recoverInterrupted).toHaveBeenCalled())
    h.engine.stop()
  })

  it("builds the manual prompt without claiming it was automatic", () => {
    expect(resumePrompt("engine", false)).toContain("MasterHand is continuing this turn")
    expect(resumePrompt("server", true)).toContain("MasterHand restarted while your turn was running")
  })
})

describe("engine continuation guards", () => {
  function interrupted(h: ReturnType<typeof harness>, sessionID = "ses_chat") {
    h.openTurn(sessionID)
    h.journal.close(sessionID, "interrupted", "engine")
    return h.journal.get(sessionID)!
  }

  it("skips missing, completed, internal and already-attempted turns", async () => {
    const h = harness()
    expect((await h.engine.resumeTurn("missing")).reason).toBe("no_turn")

    h.openTurn("ses_running")
    expect((await h.engine.resumeTurn("ses_running")).reason).toBe("not_interrupted")

    const internal = interrupted(h, "ses_goal")
    h.store.saveTurn({ ...internal, origin: "goal" })
    expect((await h.engine.resumeTurn("ses_goal")).reason).toBe("internal_turn")

    const attempted = interrupted(h, "ses_attempted")
    h.store.saveTurn({ ...attempted, resumeAttempts: 1 })
    expect((await h.engine.resumeTurn("ses_attempted", { automatic: true })).reason).toBe("already_attempted")
  })

  it("skips when the circuit is open or the session is busy, and fails when the engine is unreachable", async () => {
    const h = harness()
    interrupted(h, "ses_circuit")
    h.supervisor.status = vi.fn(async () => ({
      services: { opencode: healthyService({ circuitOpen: true }) },
    }))
    expect((await h.engine.resumeTurn("ses_circuit")).reason).toBe("circuit_open")

    h.supervisor.status = vi.fn(async () => ({ services: { opencode: healthyService() } }))
    interrupted(h, "ses_busy")
    h.opencode.active.add("ses_busy")
    expect((await h.engine.resumeTurn("ses_busy")).reason).toBe("session_busy")

    interrupted(h, "ses_down")
    h.opencode.activeError = new TypeError("connection refused")
    expect((await h.engine.resumeTurn("ses_down")).reason).toBe("engine_unreachable")
  })

  it("fails when the last-assistant lookup is unreachable", async () => {
    const h = harness()
    interrupted(h, "ses_chat")
    h.opencode.assistantError = new TypeError("connection refused")
    expect((await h.engine.resumeTurn("ses_chat")).reason).toBe("engine_unreachable")
  })

  it("closes a turn whose assistant reply completed after it started", async () => {
    const h = harness()
    interrupted(h, "ses_chat")
    h.opencode.assistants.set("ses_chat", {
      id: "msg_1",
      text: "done",
      completed: true,
      createdAt: 2_000,
    })
    expect((await h.engine.resumeTurn("ses_chat")).reason).toBe("already_completed")
    expect(h.journal.get("ses_chat")?.state).toBe("completed")
  })

  it("spends the attempt when the continuation fails definitively", async () => {
    const h = harness()
    interrupted(h, "ses_chat")
    h.opencode.promptError = new Error("rejected")
    const result = await h.engine.resumeTurn("ses_chat")
    expect(result).toMatchObject({ status: "failed", reason: "rejected" })
    expect(h.journal.get("ses_chat")).toMatchObject({ state: "interrupted", resumeAttempts: 1 })
  })

  it("restarts/reset through the supervisor and reports failures", async () => {
    const h = harness()
    expect(await h.engine.restartEngine()).toEqual({ ok: true })
    expect(await h.engine.resetEngine()).toEqual({ ok: true })
    h.supervisor.restart = vi.fn(async () => ({ ok: false, error: "supervisor_unavailable" }))
    expect(await h.engine.restartEngine()).toEqual({ ok: false, error: "supervisor_unavailable" })
  })

  it("reports supervisor: false when no sidecar is configured", async () => {
    const h = harness()
    ;(h.supervisor as { enabled: boolean }).enabled = false
    h.supervisor.status = vi.fn(async () => null)
    const status = await h.engine.status()
    expect(status.supervisor).toBe(false)
    expect(status.lastIncident).toBeNull()
  })

  it("does not recover while the hub is disconnected, and coalesces concurrent passes", async () => {
    const h = harness()
    h.setConnected(false)
    await h.engine.recover()
    expect(h.goals.recoverInterrupted).not.toHaveBeenCalled()

    h.setConnected(true)
    const first = h.engine.recover()
    const second = h.engine.recover()
    expect(first).toBe(second)
    await first
    expect(h.goals.recoverInterrupted).toHaveBeenCalledTimes(1)
  })

  it("pauses goals when the engine does not answer and the supervisor opens the circuit", async () => {
    const h = harness({ probe: async () => false })
    h.supervisor.status = vi
      .fn()
      .mockResolvedValueOnce({ services: { opencode: healthyService() } })
      .mockResolvedValueOnce({ services: { opencode: healthyService({ circuitOpen: true }) } })
    await h.engine.recoverNow()
    expect(h.goals.pauseInterrupted).toHaveBeenCalled()
  })

  it("skips a short SSE blip when there is no recoverable work", async () => {
    const h = harness({ recoveryMinOutageMs: 5_000, maxChatResumes: 0 })
    h.engine.start()
    await vi.waitFor(() => expect(h.goals.recoverInterrupted).toHaveBeenCalled())
    vi.mocked(h.goals.recoverInterrupted).mockClear()
    h.hub.emit({ type: "hub.disconnected", data: {} })
    h.hub.emit({ type: "hub.connected", data: {} })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(h.goals.recoverInterrupted).not.toHaveBeenCalled()
    h.engine.stop()
  })

  it("pauses on the status poll when the circuit opens", async () => {
    const h = harness({ statusPollMs: 5 })
    h.engine.start()
    await vi.waitFor(() => expect(h.goals.recoverInterrupted).toHaveBeenCalled())
    h.service.circuitOpen = true
    await vi.waitFor(() => expect(h.goals.pauseInterrupted).toHaveBeenCalled())
    h.engine.stop()
  })
})
