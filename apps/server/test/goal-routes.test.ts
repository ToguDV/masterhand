import { afterEach, describe, expect, it } from "vitest"
import { GoalError, type GoalManager } from "../src/goal.js"
import { OpencodeTimeoutError } from "../src/retry.js"
import type { GoalRunRecord } from "../src/store.js"
import { login, startTestApp, type TestApp } from "./helpers.js"

function runRecord(overrides: Partial<GoalRunRecord> = {}): GoalRunRecord {
  return {
    sessionID: "ses_main",
    runToken: "tok_routes",
    goal: "Make it green",
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
    ...overrides,
  }
}

function fakeManager(overrides: Partial<GoalManager> = {}): GoalManager {
  const base: GoalManager = {
    start: async (input) =>
      runRecord({ sessionID: input.sessionID, goal: input.goal, mainModel: input.model ?? null }),
    status: () => null,
    pause: async () => {
      throw new GoalError("goal_not_active", 409, "the run is not active")
    },
    resume: async () => {
      throw new GoalError("goal_not_active", 409, "the run is not paused")
    },
    cancel: async () => {
      throw new GoalError("goal_not_found", 404, "no goal run for this session")
    },
    forget: async () => {},
    handleEvent: () => {},
    reconcile: async () => {},
    reconcileOnBoot: () => {},
    flush: async () => {},
    stop: () => {},
    getSettings: () => ({ maxRounds: 5, criticModel: null, judgeModel: null }),
    saveSettings: async (patch) => {
      if (patch.maxRounds !== undefined && !Number.isInteger(patch.maxRounds)) {
        throw new GoalError("invalid_settings", 400, "max rounds must be an integer between 1 and 50")
      }
      return {
        maxRounds: patch.maxRounds ?? 5,
        criticModel: patch.criticModel === undefined ? null : patch.criticModel,
        judgeModel: patch.judgeModel === undefined ? null : patch.judgeModel,
      }
    },
  }
  return { ...base, ...overrides }
}

let app: TestApp | null = null

afterEach(async () => {
  await app?.close()
  app = null
})

describe("goal routes", () => {
  it("returns the run state (or null) for a session", async () => {
    const status = (sessionID: string) => (sessionID === "ses_main" ? runRecord({ state: "judging", round: 2 }) : null)
    app = await startTestApp({ goals: fakeManager({ status }) })
    const cookie = await login(app.url)

    const empty = await fetch(`${app.url}/api/sessions/ses_other/goal`, { headers: { cookie } })
    expect(await empty.json()).toEqual({ goal: null })

    const found = await fetch(`${app.url}/api/sessions/ses_main/goal`, { headers: { cookie } })
    expect(await found.json()).toMatchObject({ goal: { state: "judging", round: 2 } })
  })

  it("starts a run with the composer model", async () => {
    const seen: Array<{ goal: string; model: string | null }> = []
    app = await startTestApp({
      goals: fakeManager({
        start: async (input) => {
          seen.push({ goal: input.goal, model: input.model ?? null })
          return runRecord({ sessionID: input.sessionID, goal: input.goal })
        },
      }),
    })
    const cookie = await login(app.url)

    const response = await fetch(`${app.url}/api/sessions/ses_main/goal`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ goal: "Fix the flake", model: "test/test-model" }),
    })
    expect(response.status).toBe(201)
    expect(seen).toEqual([{ goal: "Fix the flake", model: "test/test-model" }])
  })

  it("maps GoalError to its typed status", async () => {
    app = await startTestApp({
      goals: fakeManager({
        start: async () => {
          throw new GoalError("goal_running", 409, "a goal run is already active for this session")
        },
      }),
    })
    const cookie = await login(app.url)

    const response = await fetch(`${app.url}/api/sessions/ses_main/goal`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ goal: "again" }),
    })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: "goal_running",
      detail: "a goal run is already active for this session",
    })
  })

  it("answers 504 for a start timeout and 502 for an unexpected failure", async () => {
    app = await startTestApp({
      goals: fakeManager({
        start: async () => {
          throw new OpencodeTimeoutError()
        },
      }),
    })
    let cookie = await login(app.url)
    let response = await fetch(`${app.url}/api/sessions/ses_main/goal`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ goal: "x" }),
    })
    expect(response.status).toBe(504)

    await app.close()
    app = await startTestApp({
      goals: fakeManager({
        start: async () => {
          throw new Error("boom")
        },
      }),
    })
    cookie = await login(app.url)
    response = await fetch(`${app.url}/api/sessions/ses_main/goal`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ goal: "x" }),
    })
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ error: "goal_failed", detail: "boom" })
  })

  it("drives pause, resume and cancel", async () => {
    const calls: string[] = []
    app = await startTestApp({
      goals: fakeManager({
        pause: async (sessionID) => {
          calls.push(`pause:${sessionID}`)
          return runRecord({ state: "paused", pausedPhase: "main" })
        },
        resume: async (sessionID) => {
          calls.push(`resume:${sessionID}`)
          return runRecord({ state: "running" })
        },
        cancel: async (sessionID) => {
          calls.push(`cancel:${sessionID}`)
          return runRecord({ state: "cancelled" })
        },
      }),
    })
    const cookie = await login(app.url)

    for (const action of ["pause", "resume", "cancel"]) {
      const response = await fetch(`${app.url}/api/sessions/ses_main/goal/${action}`, {
        method: "POST",
        headers: { cookie },
      })
      expect(response.status).toBe(200)
    }
    expect(calls).toEqual(["pause:ses_main", "resume:ses_main", "cancel:ses_main"])
  })

  it("reads and validates goal settings", async () => {
    const patches: Array<Record<string, unknown>> = []
    app = await startTestApp({
      goals: fakeManager({
        saveSettings: async (patch) => {
          patches.push(patch as Record<string, unknown>)
          if (patch.criticModel === "") throw new GoalError("invalid_model", 400, "the critic model must be a provider/model reference")
          if (patch.maxRounds !== undefined && !Number.isInteger(patch.maxRounds)) {
            throw new GoalError("invalid_settings", 400, "max rounds must be an integer between 1 and 50")
          }
          return { maxRounds: patch.maxRounds ?? 5, criticModel: patch.criticModel ?? null, judgeModel: patch.judgeModel ?? null }
        },
      }),
    })
    const cookie = await login(app.url)

    const current = await fetch(`${app.url}/api/goal/settings`, { headers: { cookie } })
    expect(await current.json()).toEqual({ settings: { maxRounds: 5, criticModel: null, judgeModel: null } })

    const saved = await fetch(`${app.url}/api/goal/settings`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ maxRounds: 7, criticModel: "test/critic-model" }),
    })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toEqual({ settings: { maxRounds: 7, criticModel: "test/critic-model", judgeModel: null } })

    const badRounds = await fetch(`${app.url}/api/goal/settings`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ maxRounds: "many" }),
    })
    expect(badRounds.status).toBe(400)
    expect(await badRounds.json()).toMatchObject({ error: "invalid_settings" })

    const badModel = await fetch(`${app.url}/api/goal/settings`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ criticModel: 42 }),
    })
    expect(badModel.status).toBe(400)
    expect(await badModel.json()).toMatchObject({ error: "invalid_model" })

    expect(patches).toHaveLength(3)
  })
})
