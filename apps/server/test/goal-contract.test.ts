import { describe, expect, it } from "vitest"
import { CREATE_MARKER_KEY } from "../src/app.js"
import {
  createGoalManager,
  GOAL_DELIVERY_MARKER_KEY,
  GOAL_INTERNAL_MARKER_KEY,
  GOAL_SESSION_MARKER_KEY,
  toGoalRun,
  type GoalEvent,
  type GoalOpencode,
} from "../src/goal.js"
import { DELIVERY_MARKER_KEY } from "../src/proxy.js"
import { SCHEDULER_MARKER_KEY } from "../src/scheduler.js"
import { createSqliteStore, type GoalRunRecord } from "../src/store.js"
import { login, startTestApp, type TestApp } from "./helpers.js"

/** Internal orchestration state that must never reach HTTP or SSE (#206). */
const INTERNALS = ["runToken", "awaitingSessionID", "awaitingAssistantID", "nudged", "promptSerial"] as const

function fullRun(): GoalRunRecord {
  return {
    sessionID: "ses_main",
    runToken: "tok_contract",
    goal: "Make the suite green",
    state: "critiquing",
    round: 2,
    maxRounds: 5,
    mainModel: "test/test-model",
    criticModel: "test/critic-model",
    judgeModel: "test/judge-model",
    criticSessionID: "ses_critic",
    judgeSessionID: "ses_judge",
    lastReport: { status: "complete", summary: "done", evidence: ["tests pass"], reason: null },
    lastCritique: { argument: "prove it", issues: [] },
    lastVerdict: null,
    history: [{ round: 1, critique: null, verdict: { approved: false, reasoning: "no", requiredChanges: ["x"] } }],
    error: null,
    awaitingKind: "critic",
    awaitingSessionID: "ses_critic",
    awaitingAssistantID: "msg_1",
    attempt: 1,
    nudged: true,
    lastError: "retrying",
    pausedPhase: null,
    promptSerial: 3,
    createdAt: 1,
    updatedAt: 2,
  }
}

describe("goal run contract", () => {
  it("projects only documented fields, never internal orchestration state", () => {
    const view = toGoalRun(fullRun())
    for (const key of INTERNALS) expect(view).not.toHaveProperty(key)
    expect(Object.keys(view).sort()).toEqual(
      [
        "sessionID",
        "goal",
        "state",
        "round",
        "maxRounds",
        "mainModel",
        "criticModel",
        "judgeModel",
        "lastReport",
        "lastCritique",
        "lastVerdict",
        "criticSessionID",
        "judgeSessionID",
        "history",
        "error",
        "awaitingKind",
        "attempt",
        "lastError",
        "pausedPhase",
        "createdAt",
        "updatedAt",
      ].sort(),
    )
    // Documented values pass through untouched.
    expect(view).toMatchObject({
      sessionID: "ses_main",
      goal: "Make the suite green",
      state: "critiquing",
      round: 2,
      awaitingKind: "critic",
      attempt: 1,
      criticSessionID: "ses_critic",
    })
    expect(view.history).toEqual([
      { round: 1, critique: null, verdict: { approved: false, reasoning: "no", requiredChanges: ["x"] } },
    ])
  })

  it("omits internals from GET payloads", async () => {
    let app: TestApp | null = null
    try {
      app = await startTestApp()
      app.store.saveGoalRun(fullRun())
      const cookie = await login(app.url)
      const response = await fetch(`${app.url}/api/sessions/ses_main/goal`, { headers: { cookie } })
      expect(response.status).toBe(200)
      const body = (await response.json()) as { goal: Record<string, unknown> | null }
      expect(body.goal).not.toBeNull()
      for (const key of INTERNALS) expect(body.goal).not.toHaveProperty(key)
      expect(body.goal).toMatchObject({ sessionID: "ses_main", state: "critiquing" })
    } finally {
      await app?.close()
    }
  })

  it("omits internals from goal.updated SSE frames", () => {
    const store = createSqliteStore(":memory:")
    try {
      store.saveGoalRun({ ...fullRun(), state: "running" })
      const frames: GoalEvent[] = []
      const manager = createGoalManager({
        store,
        opencode: {} as GoalOpencode,
        emit: (event) => frames.push(event),
      })
      // Boot reconciliation persists the in-flight run (paused) and emits it.
      manager.reconcileOnBoot()
      expect(frames).toHaveLength(1)
      const frame = frames[0]
      expect(frame?.type).toBe("goal.updated")
      const goal = frame && frame.type === "goal.updated" ? frame.data.goal : null
      expect(goal).not.toBeNull()
      for (const key of INTERNALS) expect(goal).not.toHaveProperty(key)
      expect(goal).toMatchObject({ sessionID: "ses_main", state: "paused" })
    } finally {
      store.close()
    }
  })

  it("pins the marker literals on the server side", () => {
    // A typo in any of these breaks duplicate reconciliation across the BFF
    // and the clients; the client-core mirror assertions pin the other side
    // (a shared package is more infrastructure than this repo needs).
    expect(CREATE_MARKER_KEY).toBe("masterhand.create")
    expect(DELIVERY_MARKER_KEY).toBe("masterhand.delivery")
    expect(GOAL_SESSION_MARKER_KEY).toBe("masterhand.goal.role")
    expect(GOAL_DELIVERY_MARKER_KEY).toBe("masterhand.goal.delivery")
    expect(GOAL_INTERNAL_MARKER_KEY).toBe("masterhand.goal.internal")
    expect(SCHEDULER_MARKER_KEY).toBe("masterhand.scheduler")
  })
})
