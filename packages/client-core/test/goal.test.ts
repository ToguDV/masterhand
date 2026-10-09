import { describe, expect, it } from "vitest"
import {
  GOAL_EVENT_TYPE,
  goalPayloadOf,
  goalResultLine,
  goalStateLabel,
  isGoalActive,
  normalizeGoalRun,
  normalizeGoalSettings,
  type GoalRun,
} from "../src/goal"

function goalRun(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    sessionID: "ses_1",
    goal: "Make the suite green",
    state: "running",
    round: 1,
    maxRounds: 5,
    mainModel: "test/test-model",
    criticModel: null,
    judgeModel: null,
    lastReport: null,
    lastCritique: null,
    lastVerdict: null,
    history: [],
    error: null,
    awaitingKind: "main",
    attempt: 0,
    lastError: null,
    pausedPhase: null,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

describe("normalizeGoalRun", () => {
  it("normalizes a full payload", () => {
    const run = normalizeGoalRun(goalRun())
    expect(run).toMatchObject({ sessionID: "ses_1", state: "running", awaitingKind: "main", maxRounds: 5 })
  })

  it("degrades an unknown state to error and fills defaults", () => {
    const run = normalizeGoalRun(goalRun({ state: "weird", round: "x", maxRounds: undefined }))
    expect(run?.state).toBe("error")
    expect(run?.round).toBe(1)
    expect(run?.maxRounds).toBe(5)
    expect(run?.history).toEqual([])
  })

  it("returns null for payloads without identity", () => {
    expect(normalizeGoalRun(null)).toBeNull()
    expect(normalizeGoalRun("nope")).toBeNull()
    expect(normalizeGoalRun(goalRun({ sessionID: "" }))).toBeNull()
    expect(normalizeGoalRun(goalRun({ goal: "  " }))).toBeNull()
  })

  it("normalizes report, critiques, verdicts and history", () => {
    const run = normalizeGoalRun(
      goalRun({
        state: "paused",
        pausedPhase: "cap",
        lastReport: { status: "blocked", summary: "stuck", reason: "no key", evidence: ["x"] },
        lastCritique: {
          argument: "weak",
          issues: [{ severity: "weird", claim: "c", evidence: "e" }],
        },
        lastVerdict: { approved: false, reasoning: "r", requiredChanges: ["fix it"] },
        history: [{ round: 1, critique: { argument: "a", issues: [] }, verdict: { approved: false, reasoning: "r", requiredChanges: [] } }],
      }),
    )
    expect(run?.pausedPhase).toBe("cap")
    expect(run?.lastReport).toMatchObject({ status: "blocked", reason: "no key" })
    expect(run?.lastCritique?.issues[0]?.severity).toBe("low")
    expect(run?.lastVerdict?.requiredChanges).toEqual(["fix it"])
    expect(run?.history).toHaveLength(1)
  })
})

describe("goalPayloadOf", () => {
  it("extracts the run from a goal.updated frame", () => {
    const payload = goalPayloadOf({ type: GOAL_EVENT_TYPE, data: { sessionID: "ses_1", goal: goalRun() } })
    expect(payload?.sessionID).toBe("ses_1")
    expect(payload?.goal?.state).toBe("running")
  })

  it("accepts a null run (the session was deleted)", () => {
    expect(goalPayloadOf({ type: GOAL_EVENT_TYPE, data: { sessionID: "ses_1", goal: null } })).toEqual({
      sessionID: "ses_1",
      goal: null,
    })
  })

  it("ignores other events and malformed frames", () => {
    expect(goalPayloadOf({ type: "session.idle", data: { sessionID: "ses_1" } })).toBeNull()
    expect(goalPayloadOf({ type: GOAL_EVENT_TYPE, data: {} })).toBeNull()
    expect(goalPayloadOf({ type: GOAL_EVENT_TYPE, data: { sessionID: "ses_1" } })).toBeNull()
    // A malformed payload is NOT a deletion: only an explicit null is.
    expect(goalPayloadOf({ type: GOAL_EVENT_TYPE, data: { sessionID: "ses_1", goal: { nope: true } } })).toBeNull()
    expect(goalPayloadOf({ type: GOAL_EVENT_TYPE, data: { sessionID: "ses_1", goal: "garbage" } })).toBeNull()
    expect(goalPayloadOf(null)).toBeNull()
    expect(goalPayloadOf("goal.updated")).toBeNull()
  })
})

describe("goal presentation helpers", () => {
  it("labels every state", () => {
    expect(goalStateLabel("running")).toBe("Working")
    expect(goalStateLabel("critiquing")).toBe("Under review")
    expect(goalStateLabel("judging")).toBe("Judging")
    expect(goalStateLabel("approved")).toBe("Goal approved")
    expect(goalStateLabel("paused")).toBe("Paused")
    expect(goalStateLabel("cancelled")).toBe("Cancelled")
    expect(goalStateLabel("error")).toBe("Failed")
  })

  it("knows the active states", () => {
    expect(isGoalActive("running")).toBe(true)
    expect(isGoalActive("critiquing")).toBe(true)
    expect(isGoalActive("judging")).toBe(true)
    expect(isGoalActive("paused")).toBe(false)
    expect(isGoalActive("approved")).toBe(false)
  })

  it("summarizes the latest review for the strip", () => {
    const base = normalizeGoalRun(goalRun()) as GoalRun
    expect(goalResultLine(base)).toBeNull()

    const critiqued = normalizeGoalRun(
      goalRun({ lastCritique: { argument: "tests are missing", issues: [] } }),
    ) as GoalRun
    expect(goalResultLine(critiqued)).toBe("tests are missing")

    const rejected = normalizeGoalRun(
      goalRun({
        lastVerdict: { approved: false, reasoning: "not done", requiredChanges: ["add a test"] },
      }),
    ) as GoalRun
    expect(goalResultLine(rejected)).toBe("add a test")

    const approved = normalizeGoalRun(
      goalRun({ state: "approved", lastVerdict: { approved: true, reasoning: "verified", requiredChanges: [] } }),
    ) as GoalRun
    expect(goalResultLine(approved)).toBe("verified")
  })
})

describe("normalizeGoalSettings", () => {
  it("fills missing fields with defaults", () => {
    expect(normalizeGoalSettings({})).toEqual({ maxRounds: 5, criticModel: null, judgeModel: null })
    expect(normalizeGoalSettings({ maxRounds: 3, criticModel: "test/critic-model" })).toEqual({
      maxRounds: 3,
      criticModel: "test/critic-model",
      judgeModel: null,
    })
    expect(normalizeGoalSettings("nope")).toBeNull()
  })
})
