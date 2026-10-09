import { describe, expect, it } from "vitest"
import {
  CRITIC_INSTRUCTION_KEY,
  GOAL_INSTRUCTION_KEY,
  JUDGE_INSTRUCTION_KEY,
  GoalError,
  createGoalManager,
  parseCritique,
  parseGoalMarker,
  parseVerdict,
  type GoalManager,
  type GoalOpencode,
} from "../src/goal.js"
import { OpencodeTimeoutError, UpstreamStatusError } from "../src/retry.js"
import { createMemoryStore, type GoalRunRecord, type Store } from "../src/store.js"

// ---------------------------------------------------------------------------
// Scripted fake opencode: records calls and holds scripted failures per call.
// Tests drive completions explicitly (append reply + emit idle), so the state
// machine is exercised deterministically without timers.
// ---------------------------------------------------------------------------

interface FakeMessage {
  id: string
  role: "user" | "assistant"
  text: string
  metadata: Record<string, string> | null
}

interface FakeSession {
  id: string
  directory: string
  parentID: string | null
  model: string | null
  marker: string | null
  instructions: Map<string, string>
  messages: FakeMessage[]
  removed: boolean
}

interface ScriptedFailure {
  error: Error
  /** Whether the operation applied before it failed (ambiguous outcome). */
  landed: boolean
}

class FakeOpencode implements GoalOpencode {
  sessions = new Map<string, FakeSession>()
  prompts: Array<{ sessionID: string; text: string; marker: string }> = []
  promptCalls = 0
  interrupts: string[] = []
  removed: string[] = []
  switched: Array<{ sessionID: string; model: string }> = []
  activeSessionsSet = new Set<string>()
  catalog: string[] = ["test/test-model", "test/critic-model", "test/judge-model"]
  failPrompts: ScriptedFailure[] = []
  failCreates: ScriptedFailure[] = []
  failSessionInfo: Error[] = []
  failInstructions: Error[] = []
  failModels: Error[] = []
  failLastAssistant: Error[] = []
  private sequence = 0

  nextID(prefix: string): string {
    this.sequence += 1
    return `${prefix}_${this.sequence}`
  }

  addSession(input: { id: string; directory: string; model?: string | null; parentID?: string | null }): FakeSession {
    const session: FakeSession = {
      id: input.id,
      directory: input.directory,
      parentID: input.parentID ?? null,
      model: input.model ?? null,
      marker: null,
      instructions: new Map(),
      messages: [],
      removed: false,
    }
    this.sessions.set(session.id, session)
    return session
  }

  /** Appends an assistant reply without emitting an event. */
  reply(sessionID: string, text: string): FakeMessage {
    const message: FakeMessage = { id: this.nextID("msg"), role: "assistant", text, metadata: null }
    this.sessions.get(sessionID)?.messages.push(message)
    return message
  }

  sessionWithInstruction(key: string): FakeSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.instructions.has(key)) return session
    }
    return undefined
  }

  async sessionInfo(sessionID: string) {
    const failure = this.failSessionInfo.shift()
    if (failure) throw failure
    const session = this.sessions.get(sessionID)
    if (!session) return null
    return { directory: session.directory, parentID: session.parentID ?? undefined, model: session.model }
  }

  async createSession(input: {
    directory: string
    parentID: string
    title: string
    marker: string
  }): Promise<{ id: string }> {
    const failure = this.failCreates.shift()
    if (failure?.landed) {
      const created = this.addSession({
        id: this.nextID("ses"),
        directory: input.directory,
        parentID: input.parentID,
      })
      created.marker = input.marker
    }
    if (failure) throw failure.error
    const session = this.addSession({ id: this.nextID("ses"), directory: input.directory, parentID: input.parentID })
    session.marker = input.marker
    return { id: session.id }
  }

  async findSessionByMarker(marker: string): Promise<{ id: string } | null> {
    for (const session of this.sessions.values()) {
      if (session.marker === marker && !session.removed) return { id: session.id }
    }
    return null
  }

  async prompt(sessionID: string, text: string, marker: string): Promise<void> {
    this.promptCalls += 1
    const failure = this.failPrompts.shift()
    if (failure?.landed) {
      this.sessions.get(sessionID)?.messages.push({
        id: this.nextID("msg"),
        role: "user",
        text,
        metadata: { "masterhand.goal.delivery": marker },
      })
    }
    if (failure) throw failure.error
    if (!this.sessions.has(sessionID)) throw new Error(`no session ${sessionID}`)
    this.prompts.push({ sessionID, text, marker })
    this.sessions.get(sessionID)?.messages.push({
      id: this.nextID("msg"),
      role: "user",
      text,
      metadata: { "masterhand.goal.delivery": marker },
    })
  }

  async promptLanded(sessionID: string, marker: string): Promise<boolean> {
    return (
      this.sessions.get(sessionID)?.messages.some(
        (message) => message.role === "user" && message.metadata?.["masterhand.goal.delivery"] === marker,
      ) ?? false
    )
  }

  async writeInstruction(sessionID: string, key: string, value: string): Promise<void> {
    const failure = this.failInstructions.shift()
    if (failure) throw failure
    const session = this.sessions.get(sessionID)
    if (!session) throw new Error(`no session ${sessionID}`)
    session.instructions.set(key, value)
  }

  async removeInstruction(sessionID: string, key: string): Promise<void> {
    this.sessions.get(sessionID)?.instructions.delete(key)
  }

  async switchModel(sessionID: string, model: string): Promise<void> {
    this.switched.push({ sessionID, model })
    const session = this.sessions.get(sessionID)
    if (session) session.model = model
  }

  async interrupt(sessionID: string): Promise<void> {
    this.interrupts.push(sessionID)
  }

  async removeSession(sessionID: string): Promise<void> {
    this.removed.push(sessionID)
    const session = this.sessions.get(sessionID)
    if (session) session.removed = true
  }

  async lastAssistant(sessionID: string): Promise<{ id: string; text: string } | null> {
    const failure = this.failLastAssistant.shift()
    if (failure) throw failure
    const messages = this.sessions.get(sessionID)?.messages ?? []
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message?.role === "assistant") return { id: message.id, text: message.text }
    }
    return null
  }

  async activeSessions(): Promise<string[]> {
    return [...this.activeSessionsSet]
  }

  async models(): Promise<string[]> {
    const failure = this.failModels.shift()
    if (failure) throw failure
    return this.catalog
  }
}

function markerText(summary = "done"): string {
  return `Work finished.\n<masterhand:goal status="complete">{"summary": "${summary}", "evidence": ["tests green"]}</masterhand:goal>`
}

function critiqueText(claim = "not verified"): string {
  return `<masterhand:critique>{"argument": "I checked the diff", "issues": [{"severity": "medium", "claim": "${claim}", "evidence": "no test run"}]}</masterhand:critique>`
}

function cleanCritiqueText(): string {
  return `<masterhand:critique>{"argument": "No material issue found", "issues": []}</masterhand:critique>`
}

function verdictText(approved: boolean, change = "add a regression test"): string {
  return `<masterhand:verdict>{"approved": ${approved}, "reasoning": "because", "requiredChanges": ${approved ? "[]" : `["${change}"]`}}</masterhand:verdict>`
}

interface Harness {
  store: Store
  opencode: FakeOpencode
  manager: GoalManager
  events: Array<{ sessionID: string; goal: GoalRunRecord | null }>
  delays: number[]
}

function harness(options: { settings?: { maxRounds?: number; criticModel?: string | null; judgeModel?: string | null } } = {}): Harness {
  const store = createMemoryStore()
  const opencode = new FakeOpencode()
  const events: Harness["events"] = []
  const delays: number[] = []
  if (options.settings) {
    store.saveGoalSettings({
      maxRounds: options.settings.maxRounds ?? 5,
      criticModel: options.settings.criticModel ?? null,
      judgeModel: options.settings.judgeModel ?? null,
    })
  }
  const manager = createGoalManager({
    store,
    opencode,
    emit: (event) => events.push(event.data),
    retry: {
      attempts: 3,
      baseDelayMs: 100,
      jitter: false,
      sleep: async (ms) => {
        delays.push(ms)
      },
    },
    watchdogMs: 0,
  })
  return { store, opencode, manager, events, delays }
}

async function start(h: Harness, sessionID = "ses_main"): Promise<GoalRunRecord> {
  h.opencode.addSession({ id: sessionID, directory: "/workspace/app", model: "test/test-model" })
  const run = await h.manager.start({ sessionID, goal: "Make the suite green" })
  await h.manager.flush()
  return run
}

async function reply(h: Harness, sessionID: string, text: string): Promise<void> {
  h.opencode.reply(sessionID, text)
  h.manager.handleEvent({ type: "session.idle", data: { sessionID } })
  await h.manager.flush()
}

describe("goal protocol parsers", () => {
  it("parses a completion marker surrounded by regular text", () => {
    const parsed = parseGoalMarker(`Everything is done.\n${markerText()}`)
    expect(parsed).toEqual({
      status: "complete",
      summary: "done",
      evidence: ["tests green"],
      reason: null,
    })
  })

  it("takes the last marker when several appear", () => {
    const parsed = parseGoalMarker(`${markerText("first")}\nignore that\n${markerText("second")}`)
    expect(parsed?.summary).toBe("second")
  })

  it("defaults a missing status attribute to complete and reads blocked", () => {
    expect(parseGoalMarker('<masterhand:goal>{"summary": "x"}</masterhand:goal>')?.status).toBe("complete")
    const blocked = parseGoalMarker(
      '<masterhand:goal status="blocked">{"summary": "x", "reason": "missing credentials"}</masterhand:goal>',
    )
    expect(blocked?.status).toBe("blocked")
    expect(blocked?.reason).toBe("missing credentials")
  })

  it("returns null for a malformed or missing marker", () => {
    expect(parseGoalMarker("no marker here")).toBeNull()
    expect(parseGoalMarker("<masterhand:goal>{not json}</masterhand:goal>")).toBeNull()
    expect(parseGoalMarker('<masterhand:goal>{"summary": 1}</masterhand:goal>')).toBeNull()
  })

  it("parses critiques and normalizes unknown severities", () => {
    const parsed = parseCritique(
      'prose <masterhand:critique>{"argument": "a", "issues": [{"severity": "weird", "claim": "c", "evidence": "e"}]}</masterhand:critique>',
    )
    expect(parsed?.issues[0]?.severity).toBe("low")
    expect(parseCritique("nothing")).toBeNull()
    expect(parseCritique("<masterhand:critique>{}</masterhand:critique>")).toBeNull()
  })

  it("parses verdicts and defaults the change list", () => {
    expect(parseVerdict(verdictText(true))).toEqual({ approved: true, reasoning: "because", requiredChanges: [] })
    const rejected = parseVerdict(verdictText(false))
    expect(rejected?.approved).toBe(false)
    expect(rejected?.requiredChanges).toEqual(["add a regression test"])
    expect(parseVerdict('<masterhand:verdict>{"reasoning": "x"}</masterhand:verdict>')).toBeNull()
  })
})

describe("goal manager", () => {
  it("runs the full loop: complete -> critique -> reject -> fix -> approve", async () => {
    const h = harness()
    await start(h)

    expect(h.opencode.prompts).toHaveLength(1)
    expect(h.opencode.prompts[0]?.sessionID).toBe("ses_main")
    expect(h.opencode.prompts[0]?.text).toContain("Make the suite green")
    expect(h.opencode.sessions.get("ses_main")?.instructions.has(GOAL_INSTRUCTION_KEY)).toBe(true)

    await reply(h, "ses_main", markerText("first pass"))
    const critic = h.opencode.sessionWithInstruction(CRITIC_INSTRUCTION_KEY)
    expect(critic).toBeDefined()
    expect(critic?.parentID).toBe("ses_main")
    expect(h.manager.status("ses_main")?.state).toBe("critiquing")
    // No critic model configured: the main session's model is used.
    expect(h.opencode.switched).toContainEqual({ sessionID: critic?.id, model: "test/test-model" })

    await reply(h, critic!.id, critiqueText())
    const judge = h.opencode.sessionWithInstruction(JUDGE_INSTRUCTION_KEY)
    expect(judge).toBeDefined()
    expect(h.manager.status("ses_main")?.state).toBe("judging")

    await reply(h, judge!.id, verdictText(false))
    const afterReject = h.manager.status("ses_main")!
    expect(afterReject.state).toBe("running")
    expect(afterReject.round).toBe(2)
    expect(afterReject.history).toHaveLength(1)
    expect(h.opencode.prompts.at(-1)?.text).toContain("add a regression test")

    await reply(h, "ses_main", markerText("second pass"))
    // The same critic and judge sessions are reused across rounds.
    expect(h.opencode.sessionWithInstruction(CRITIC_INSTRUCTION_KEY)?.id).toBe(critic?.id)
    await reply(h, critic!.id, cleanCritiqueText())
    await reply(h, judge!.id, verdictText(true))

    const approved = h.manager.status("ses_main")!
    expect(approved.state).toBe("approved")
    expect(approved.round).toBe(2)
    expect(approved.history).toHaveLength(2)
    expect(approved.lastVerdict?.approved).toBe(true)
    expect(approved.awaitingSessionID).toBeNull()
    // The goal instruction is removed once the run is over.
    expect(h.opencode.sessions.get("ses_main")?.instructions.has(GOAL_INSTRUCTION_KEY)).toBe(false)
    // Every transition is broadcast for the clients.
    expect(h.events.length).toBeGreaterThan(5)
    expect(h.events.at(-1)?.goal?.state).toBe("approved")
  })

  it("approves on the first round when the critic finds nothing", async () => {
    const h = harness()
    await start(h)
    await reply(h, "ses_main", markerText())
    const critic = h.opencode.sessionWithInstruction(CRITIC_INSTRUCTION_KEY)!
    await reply(h, critic.id, cleanCritiqueText())
    const judge = h.opencode.sessionWithInstruction(JUDGE_INSTRUCTION_KEY)!
    await reply(h, judge.id, verdictText(true))

    expect(h.manager.status("ses_main")?.state).toBe("approved")
    expect(h.manager.status("ses_main")?.history).toHaveLength(1)
  })

  it("pauses at the round cap and resumes with a fresh budget", async () => {
    const h = harness({ settings: { maxRounds: 2 } })
    await start(h)
    const reject = async (): Promise<void> => {
      await reply(h, "ses_main", markerText())
      const critic = h.opencode.sessionWithInstruction(CRITIC_INSTRUCTION_KEY)!
      await reply(h, critic.id, critiqueText())
      const judge = h.opencode.sessionWithInstruction(JUDGE_INSTRUCTION_KEY)!
      await reply(h, judge.id, verdictText(false, "fix the flake"))
    }

    await reject()
    await reject()
    const paused = h.manager.status("ses_main")!
    expect(paused.state).toBe("paused")
    expect(paused.pausedPhase).toBe("cap")
    expect(paused.round).toBe(2)

    const resumed = await h.manager.resume("ses_main")
    await h.manager.flush()
    expect(resumed.state).toBe("running")
    expect(resumed.round).toBe(3)
    expect(resumed.maxRounds).toBe(4)
    expect(h.opencode.prompts.at(-1)?.text).toContain("fix the flake")

    await reply(h, "ses_main", markerText())
    const critic = h.opencode.sessionWithInstruction(CRITIC_INSTRUCTION_KEY)!
    await reply(h, critic.id, cleanCritiqueText())
    const judge = h.opencode.sessionWithInstruction(JUDGE_INSTRUCTION_KEY)!
    await reply(h, judge.id, verdictText(true))
    expect(h.manager.status("ses_main")?.state).toBe("approved")
    expect(h.manager.status("ses_main")?.round).toBe(3)
  })

  it("nudges once when the marker is missing and errors after a second miss", async () => {
    const h = harness()
    await start(h)

    await reply(h, "ses_main", "I think it is done!")
    let run = h.manager.status("ses_main")!
    expect(run.state).toBe("running")
    expect(run.nudged).toBe(true)
    expect(h.opencode.prompts.at(-1)?.text.toLowerCase()).toContain("completion marker")

    await reply(h, "ses_main", "Really, it is done!")
    run = h.manager.status("ses_main")!
    expect(run.state).toBe("error")
    expect(run.error?.toLowerCase()).toContain("marker")

    // The error is recoverable: resume re-prompts and a valid marker continues.
    await h.manager.resume("ses_main")
    await h.manager.flush()
    expect(h.manager.status("ses_main")?.state).toBe("running")
    await reply(h, "ses_main", markerText())
    expect(h.manager.status("ses_main")?.state).toBe("critiquing")
  })

  it("retries a failed phase with incremental delays and then errors", async () => {
    const h = harness()
    await start(h)

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      h.manager.handleEvent({ type: "session.execution.failed", data: { sessionID: "ses_main", error: { message: "rate limited" } } })
      await h.manager.flush()
    }
    let run = h.manager.status("ses_main")!
    expect(run.state).toBe("running")
    expect(run.attempt).toBe(3)
    expect(h.delays).toEqual([2000, 4000, 8000])
    expect(h.opencode.prompts).toHaveLength(4)

    h.manager.handleEvent({ type: "session.execution.failed", data: { sessionID: "ses_main", error: { message: "rate limited" } } })
    await h.manager.flush()
    run = h.manager.status("ses_main")!
    expect(run.state).toBe("error")
    expect(run.error).toContain("rate limited")
    expect(run.error).toContain("3 retries")
    expect(h.delays).toEqual([2000, 4000, 8000])
  })

  it("reflects opencode's own retry schedule without failing the phase", async () => {
    const h = harness()
    await start(h)
    h.manager.handleEvent({
      type: "session.retry.scheduled",
      data: { sessionID: "ses_main", attempt: 2, error: { message: "provider rate limit" } },
    })
    await h.manager.flush()

    const run = h.manager.status("ses_main")!
    expect(run.state).toBe("running")
    expect(run.attempt).toBe(0)
    expect(run.lastError).toContain("provider rate limit")

    // The turn still completes normally afterwards.
    await reply(h, "ses_main", markerText())
    expect(h.manager.status("ses_main")?.state).toBe("critiquing")
  })

  it("retries transient prompt failures with backoff and persists the prompt once", async () => {
    const h = harness()
    h.opencode.failPrompts.push(
      { error: new UpstreamStatusError(429), landed: false },
      { error: new UpstreamStatusError(503), landed: false },
    )
    await start(h)

    expect(h.opencode.promptCalls).toBe(3)
    expect(h.opencode.prompts).toHaveLength(1)
    expect(h.delays).toEqual([100, 200])
    expect(h.manager.status("ses_main")?.lastError).toBeNull()
    await reply(h, "ses_main", markerText())
    expect(h.manager.status("ses_main")?.state).toBe("critiquing")
  })

  it("treats an ambiguous prompt timeout as landed when the marker is found", async () => {
    const h = harness()
    h.opencode.failPrompts.push({ error: new OpencodeTimeoutError(), landed: true })
    await start(h)

    expect(h.opencode.promptCalls).toBe(1)
    expect(h.opencode.prompts).toHaveLength(0)
    expect(h.manager.status("ses_main")?.state).toBe("running")
    await reply(h, "ses_main", markerText())
    expect(h.manager.status("ses_main")?.state).toBe("critiquing")
  })

  it("reuses a critic session created before an ambiguous create failure", async () => {
    const h = harness()
    h.opencode.failCreates.push({ error: new UpstreamStatusError(503), landed: true })
    await start(h)
    await reply(h, "ses_main", markerText())

    const critics = [...h.opencode.sessions.values()].filter((session) => session.instructions.has(CRITIC_INSTRUCTION_KEY))
    expect(critics).toHaveLength(1)
    expect(h.manager.status("ses_main")?.state).toBe("critiquing")
  })

  it("recovers a lost idle event through reconciliation", async () => {
    const h = harness()
    await start(h)
    h.opencode.reply("ses_main", markerText())
    // No session.idle was observed: the awaited session is idle and the
    // watchdog reconciliation must pick the reply up.
    h.opencode.activeSessionsSet.clear()
    await h.manager.reconcile()
    await h.manager.flush()
    expect(h.manager.status("ses_main")?.state).toBe("critiquing")

    // While the session is still active, reconciliation leaves it alone.
    h.opencode.activeSessionsSet.add("ses_main")
    await h.manager.reconcile()
    expect(h.manager.status("ses_main")?.state).toBe("critiquing")
  })

  it("also wakes on execution.succeeded (servers that skip idle)", async () => {
    const h = harness()
    await start(h)
    h.opencode.reply("ses_main", markerText())
    h.manager.handleEvent({ type: "session.execution.succeeded", data: { sessionID: "ses_main" } })
    await h.manager.flush()
    expect(h.manager.status("ses_main")?.state).toBe("critiquing")
  })

  it("pauses in-flight runs on boot instead of auto-resuming them", async () => {
    const store = createMemoryStore()
    const running: GoalRunRecord = {
      sessionID: "ses_main",
      goal: "g",
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
      awaitingKind: "main",
      awaitingSessionID: "ses_main",
      awaitingAssistantID: null,
      attempt: 0,
      nudged: false,
      lastError: null,
      pausedPhase: null,
      promptSerial: 1,
      createdAt: 1,
      updatedAt: 1,
    }
    store.saveGoalRun(running)
    const manager = createGoalManager({
      store,
      opencode: new FakeOpencode(),
      emit: () => {},
      retry: { sleep: async () => {} },
      watchdogMs: 0,
    })

    manager.reconcileOnBoot()
    const paused = manager.status("ses_main")!
    expect(paused.state).toBe("paused")
    expect(paused.pausedPhase).toBe("main")
    expect(paused.error).toContain("restart")
  })

  it("cancels a run, interrupts the awaited session and removes internal sessions", async () => {
    const h = harness()
    await start(h)
    await reply(h, "ses_main", markerText())
    const critic = h.opencode.sessionWithInstruction(CRITIC_INSTRUCTION_KEY)!
    await reply(h, critic.id, critiqueText())
    const judge = h.opencode.sessionWithInstruction(JUDGE_INSTRUCTION_KEY)!

    const cancelled = await h.manager.cancel("ses_main")
    expect(cancelled.state).toBe("cancelled")
    expect(h.opencode.interrupts).toContain(judge.id)
    expect(h.opencode.removed).toEqual(expect.arrayContaining([critic.id, judge.id]))
    expect(h.opencode.sessions.get("ses_main")?.instructions.has(GOAL_INSTRUCTION_KEY)).toBe(false)
  })

  it("pauses manually and resumes the interrupted phase", async () => {
    const h = harness()
    await start(h)
    const paused = await h.manager.pause("ses_main")
    expect(paused.state).toBe("paused")
    expect(paused.pausedPhase).toBe("main")
    expect(h.opencode.interrupts).toContain("ses_main")

    const resumed = await h.manager.resume("ses_main")
    await h.manager.flush()
    expect(resumed.state).toBe("running")
    expect(h.opencode.prompts).toHaveLength(2)
    await reply(h, "ses_main", markerText())
    expect(h.manager.status("ses_main")?.state).toBe("critiquing")
  })

  it("refuses a second run and a busy session", async () => {
    const h = harness()
    await start(h)
    await expect(h.manager.start({ sessionID: "ses_main", goal: "again" })).rejects.toMatchObject({
      code: "goal_running",
    })

    h.opencode.addSession({ id: "ses_busy", directory: "/workspace/app", model: "test/test-model" })
    h.opencode.activeSessionsSet.add("ses_busy")
    await expect(h.manager.start({ sessionID: "ses_busy", goal: "work" })).rejects.toMatchObject({
      code: "session_busy",
    })
  })

  it("coalesces two concurrent starts into a single run", async () => {
    const h = harness()
    h.opencode.addSession({ id: "ses_main", directory: "/workspace/app", model: "test/test-model" })

    const results = await Promise.allSettled([
      h.manager.start({ sessionID: "ses_main", goal: "first" }),
      h.manager.start({ sessionID: "ses_main", goal: "second" }),
    ])
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    const rejected = results.find((result) => result.status === "rejected")
    expect(rejected && rejected.status === "rejected" && rejected.reason).toMatchObject({ code: "goal_running" })
    expect(h.opencode.prompts).toHaveLength(1)
  })

  it("validates goal settings against the model catalog", async () => {
    const h = harness()
    await expect(h.manager.saveSettings({ maxRounds: 0 })).rejects.toBeInstanceOf(GoalError)
    await expect(h.manager.saveSettings({ maxRounds: 51 })).rejects.toMatchObject({ code: "invalid_settings" })
    await expect(h.manager.saveSettings({ criticModel: "ghost/model" })).rejects.toMatchObject({
      code: "invalid_model",
    })

    const saved = await h.manager.saveSettings({ maxRounds: 7, criticModel: "test/critic-model", judgeModel: null })
    expect(saved).toEqual({ maxRounds: 7, criticModel: "test/critic-model", judgeModel: null })
    expect(h.manager.getSettings().maxRounds).toBe(7)
    // Empty catalog: a well-formed ref is accepted (opencode may not be up yet).
    h.opencode.catalog = []
    await expect(h.manager.saveSettings({ judgeModel: "other/judge" })).resolves.toMatchObject({
      judgeModel: "other/judge",
    })
  })

  it("forgets the run when its session is deleted", async () => {
    const h = harness()
    await start(h)
    await h.manager.forget("ses_main")
    expect(h.manager.status("ses_main")).toBeNull()
    expect(h.events.at(-1)?.goal).toBeNull()
  })

  it("fails the run when an internal session it waits on is deleted", async () => {
    const h = harness()
    await start(h)
    await reply(h, "ses_main", markerText())
    const critic = h.opencode.sessionWithInstruction(CRITIC_INSTRUCTION_KEY)!
    h.manager.handleEvent({ type: "session.deleted", data: { sessionID: critic.id } })
    await h.manager.flush()
    const run = h.manager.status("ses_main")!
    expect(run.state).toBe("error")
    expect(run.error?.toLowerCase()).toContain("deleted")
  })

  it("rejects an empty goal and a missing session", async () => {
    const h = harness()
    await expect(h.manager.start({ sessionID: "ses_main", goal: "   " })).rejects.toMatchObject({
      code: "invalid_goal",
    })
    await expect(h.manager.start({ sessionID: "ghost", goal: "x" })).rejects.toMatchObject({
      code: "session_not_found",
    })
  })
})

describe("goal manager reliability", () => {
  it("surfaces the retry note while a network prompt failure is being retried", async () => {
    const h = harness()
    h.opencode.failPrompts.push({ error: new TypeError("fetch failed"), landed: false })
    await start(h)

    expect(h.opencode.promptCalls).toBe(2)
    expect(h.events.some((entry) => entry.goal?.lastError?.includes("unreachable"))).toBe(true)
  })

  it("surfaces the ambiguity note when a prompt times out and has not landed", async () => {
    const h = harness()
    h.opencode.failPrompts.push({ error: new OpencodeTimeoutError(), landed: false })
    await start(h)

    expect(h.opencode.promptCalls).toBe(2)
    expect(h.events.some((entry) => entry.goal?.lastError?.includes("did not respond"))).toBe(true)
  })

  it("notes a transient internal-session create failure before retrying", async () => {
    const h = harness()
    h.opencode.failCreates.push({ error: new UpstreamStatusError(503), landed: false })
    await start(h)
    await reply(h, "ses_main", markerText())

    expect(h.opencode.promptCalls).toBe(2)
    expect(h.events.some((entry) => entry.goal?.lastError?.includes("503"))).toBe(true)
    expect(h.manager.status("ses_main")?.state).toBe("critiquing")
  })

  it("errors the run when the agent reports it blocked", async () => {
    const h = harness()
    await start(h)
    await reply(
      h,
      "ses_main",
      '<masterhand:goal status="blocked">{"summary": "stuck", "reason": "no credentials"}</masterhand:goal>',
    )

    const run = h.manager.status("ses_main")!
    expect(run.state).toBe("error")
    expect(run.error).toContain("no credentials")
  })

  it("retries a critic that replied without a marker", async () => {
    const h = harness()
    await start(h)
    await reply(h, "ses_main", markerText())
    const critic = h.opencode.sessionWithInstruction(CRITIC_INSTRUCTION_KEY)!

    await reply(h, critic.id, "Everything looks fine to me")
    expect(h.manager.status("ses_main")?.state).toBe("critiquing")
    expect(h.delays).toEqual([2000])
    expect(h.opencode.prompts.filter((prompt) => prompt.sessionID === critic.id)).toHaveLength(2)

    await reply(h, critic.id, cleanCritiqueText())
    expect(h.manager.status("ses_main")?.state).toBe("judging")
  })

  it("retries a malformed verdict and approves afterwards", async () => {
    const h = harness()
    await start(h)
    await reply(h, "ses_main", markerText())
    const critic = h.opencode.sessionWithInstruction(CRITIC_INSTRUCTION_KEY)!
    await reply(h, critic.id, cleanCritiqueText())
    const judge = h.opencode.sessionWithInstruction(JUDGE_INSTRUCTION_KEY)!

    await reply(h, judge.id, "I approve, no marker though")
    expect(h.manager.status("ses_main")?.state).toBe("judging")
    expect(h.delays).toEqual([2000])
    expect(h.opencode.prompts.filter((prompt) => prompt.sessionID === judge.id)).toHaveLength(2)

    await reply(h, judge.id, verdictText(true))
    expect(h.manager.status("ses_main")?.state).toBe("approved")
  })

  it("re-drives the judge after an execution failure", async () => {
    const h = harness()
    await start(h)
    await reply(h, "ses_main", markerText())
    const critic = h.opencode.sessionWithInstruction(CRITIC_INSTRUCTION_KEY)!
    await reply(h, critic.id, cleanCritiqueText())
    const judge = h.opencode.sessionWithInstruction(JUDGE_INSTRUCTION_KEY)!

    h.manager.handleEvent({
      type: "session.execution.failed",
      data: { sessionID: judge.id, error: { message: "provider blew up" } },
    })
    await h.manager.flush()
    expect(h.delays).toEqual([2000])
    expect(h.opencode.prompts.filter((prompt) => prompt.sessionID === judge.id)).toHaveLength(2)

    await reply(h, judge.id, verdictText(true))
    expect(h.manager.status("ses_main")?.state).toBe("approved")
  })

  it("retries a prompt after a failed lastAssistant read", async () => {
    const h = harness()
    await start(h)
    h.opencode.failLastAssistant.push(
      new TypeError("read failed"),
      new TypeError("read failed"),
      new TypeError("read failed"),
    )

    h.manager.handleEvent({ type: "session.idle", data: { sessionID: "ses_main" } })
    await h.manager.flush()

    const run = h.manager.status("ses_main")!
    expect(run.error).toBeNull()
    expect(run.state).toBe("running")
    expect(run.attempt).toBe(1)
    expect(h.opencode.prompts).toHaveLength(2)
  })

  it("fails the run when internal session creation keeps failing", async () => {
    const h = harness()
    await start(h)
    h.opencode.failCreates.push(
      ...Array.from({ length: 15 }, () => ({ error: new UpstreamStatusError(503), landed: false })),
    )

    await reply(h, "ses_main", markerText())
    const run = h.manager.status("ses_main")!
    expect(run.state).toBe("error")
    expect(run.error).toContain("503")
    expect(run.pausedPhase).toBe("critic")
  })

  it("fails the run when the judge session cannot be created", async () => {
    const h = harness()
    await start(h)
    await reply(h, "ses_main", markerText())
    const critic = h.opencode.sessionWithInstruction(CRITIC_INSTRUCTION_KEY)!
    h.opencode.failCreates.push(
      ...Array.from({ length: 15 }, () => ({ error: new UpstreamStatusError(503), landed: false })),
    )

    await reply(h, critic.id, cleanCritiqueText())
    const run = h.manager.status("ses_main")!
    expect(run.state).toBe("error")
    expect(run.pausedPhase).toBe("judge")
  })

  it("fails a retired critic phase whose report is gone instead of looping", async () => {
    const h = harness()
    const record: GoalRunRecord = {
      sessionID: "ses_main",
      goal: "g",
      state: "critiquing",
      round: 1,
      maxRounds: 5,
      mainModel: null,
      criticModel: null,
      judgeModel: null,
      criticSessionID: "ses_critic",
      judgeSessionID: null,
      lastReport: null,
      lastCritique: null,
      lastVerdict: null,
      history: [],
      error: null,
      awaitingKind: "critic",
      awaitingSessionID: "ses_critic",
      awaitingAssistantID: null,
      attempt: 0,
      nudged: false,
      lastError: null,
      pausedPhase: "critic",
      promptSerial: 2,
      createdAt: 1,
      updatedAt: 1,
    }
    h.store.saveGoalRun(record)

    h.manager.handleEvent({
      type: "session.execution.failed",
      data: { sessionID: "ses_critic", error: { message: "boom" } },
    })
    await h.manager.flush()
    expect(h.manager.status("ses_main")?.state).toBe("error")
  })

  it("resumes a run paused while the critic was working", async () => {
    const h = harness()
    await start(h)
    await reply(h, "ses_main", markerText())
    const critic = h.opencode.sessionWithInstruction(CRITIC_INSTRUCTION_KEY)!
    expect(h.manager.status("ses_main")?.state).toBe("critiquing")

    const paused = await h.manager.pause("ses_main")
    expect(paused.pausedPhase).toBe("critic")
    await h.manager.resume("ses_main")
    await h.manager.flush()
    expect(h.opencode.prompts.filter((prompt) => prompt.sessionID === critic.id)).toHaveLength(2)

    await reply(h, critic.id, cleanCritiqueText())
    expect(h.manager.status("ses_main")?.state).toBe("judging")
  })

  it("resumes a run paused while the judge was working", async () => {
    const h = harness()
    await start(h)
    await reply(h, "ses_main", markerText())
    const critic = h.opencode.sessionWithInstruction(CRITIC_INSTRUCTION_KEY)!
    await reply(h, critic.id, cleanCritiqueText())
    const judge = h.opencode.sessionWithInstruction(JUDGE_INSTRUCTION_KEY)!

    const paused = await h.manager.pause("ses_main")
    expect(paused.pausedPhase).toBe("judge")
    await h.manager.resume("ses_main")
    await h.manager.flush()
    expect(h.opencode.prompts.filter((prompt) => prompt.sessionID === judge.id)).toHaveLength(2)

    await reply(h, judge.id, verdictText(true))
    expect(h.manager.status("ses_main")?.state).toBe("approved")
  })

  it("rejects pause/resume/cancel when the run state does not allow them", async () => {
    const h = harness()
    await expect(h.manager.pause("ghost")).rejects.toMatchObject({ code: "goal_not_found" })
    await start(h)
    await reply(h, "ses_main", markerText())
    const critic = h.opencode.sessionWithInstruction(CRITIC_INSTRUCTION_KEY)!
    await reply(h, critic.id, cleanCritiqueText())
    const judge = h.opencode.sessionWithInstruction(JUDGE_INSTRUCTION_KEY)!
    await reply(h, judge.id, verdictText(true))

    await expect(h.manager.pause("ses_main")).rejects.toMatchObject({ code: "goal_not_active" })
    await expect(h.manager.resume("ses_main")).rejects.toMatchObject({ code: "goal_not_active" })
    await expect(h.manager.cancel("ses_main")).rejects.toMatchObject({ code: "goal_not_active" })
  })

  it("handles a main session deleted through an event", async () => {
    const h = harness()
    await start(h)
    h.manager.handleEvent({ type: "session.deleted", data: { sessionID: "ses_main" } })
    await h.manager.flush()
    expect(h.manager.status("ses_main")).toBeNull()
  })

  it("errors the run when the awaited turn is interrupted out of band", async () => {
    const h = harness()
    await start(h)
    h.manager.handleEvent({ type: "session.execution.interrupted", data: { sessionID: "ses_main" } })
    await h.manager.flush()

    const run = h.manager.status("ses_main")!
    expect(run.state).toBe("error")
    expect(run.error).toContain("interrupted")
  })

  it("uses a string event error and a generic fallback", async () => {
    const h = harness()
    await start(h)
    h.manager.handleEvent({
      type: "session.execution.failed",
      data: { sessionID: "ses_main", error: "quota exceeded" },
    })
    await h.manager.flush()
    expect(h.manager.status("ses_main")?.attempt).toBe(1)

    h.manager.handleEvent({ type: "session.execution.failed", data: { sessionID: "ses_main" } })
    await h.manager.flush()
    expect(h.manager.status("ses_main")?.attempt).toBe(2)
  })

  it("fails the start when opencode is unreachable", async () => {
    const h = harness()
    h.opencode.addSession({ id: "ses_main", directory: "/workspace/app" })
    h.opencode.failSessionInfo.push(new Error("down"), new Error("down"), new Error("down"))

    await expect(h.manager.start({ sessionID: "ses_main", goal: "x" })).rejects.toMatchObject({
      code: "opencode_unreachable",
    })
  })

  it("fails visibly when the goal instruction cannot be stored", async () => {
    const h = harness()
    h.opencode.addSession({ id: "ses_main", directory: "/workspace/app" })
    h.opencode.failInstructions.push(new Error("down"), new Error("down"), new Error("down"))

    await expect(h.manager.start({ sessionID: "ses_main", goal: "x" })).rejects.toMatchObject({
      code: "opencode_unreachable",
    })
    const run = h.manager.status("ses_main")!
    expect(run.state).toBe("error")
    expect(run.error).toContain("could not start")
  })

  it("validates settings refs and reports an unreachable catalog", async () => {
    const h = harness()
    await expect(h.manager.saveSettings({ criticModel: "" })).rejects.toMatchObject({ code: "invalid_model" })
    await expect(h.manager.saveSettings({ judgeModel: "  " })).rejects.toMatchObject({ code: "invalid_model" })

    h.opencode.failModels.push(new Error("down"))
    await expect(h.manager.saveSettings({ criticModel: "test/critic-model" })).rejects.toMatchObject({
      code: "opencode_unreachable",
    })
  })

  it("stops its watchdog", () => {
    const store = createMemoryStore()
    const manager: GoalManager = createGoalManager({
      store,
      opencode: new FakeOpencode(),
      emit: () => {},
      retry: { sleep: async () => {} },
      watchdogMs: 1000,
    })
    manager.stop()
    manager.stop()
  })
})
