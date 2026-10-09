import { describe, expect, it } from "vitest"
import {
  GOAL_EVENT_TYPE,
  goalActivityLabel,
  goalPayloadOf,
  goalResultLine,
  goalReviewRounds,
  goalStateLabel,
  isGoalActive,
  normalizeGoalRun,
  normalizeGoalSettings,
  splitGoalMarkers,
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

describe("splitGoalMarkers", () => {
  it("splits prose from a parsed completion report", () => {
    const text = [
      "Working on it.",
      '<masterhand:goal status="complete">{"summary": "done", "evidence": ["npm test"]}</masterhand:goal>',
    ].join("\n")
    const segments = splitGoalMarkers(text)
    expect(segments).toHaveLength(2)
    expect(segments[0]).toEqual({ kind: "text", text: "Working on it.\n" })
    expect(segments[1]).toEqual({
      kind: "report",
      report: { status: "complete", summary: "done", evidence: ["npm test"], reason: null },
    })
  })

  it("parses critique and verdict blocks", () => {
    const critique = splitGoalMarkers(
      '<masterhand:critique>{"argument": "weak", "issues": [{"severity": "high", "claim": "c", "evidence": "e"}]}</masterhand:critique>',
    )
    expect(critique).toEqual([
      {
        kind: "critique",
        critique: { argument: "weak", issues: [{ severity: "high", claim: "c", evidence: "e" }] },
      },
    ])

    const verdict = splitGoalMarkers(
      '<masterhand:verdict>{"approved": false, "reasoning": "not yet", "requiredChanges": ["fix it"]}</masterhand:verdict>',
    )
    expect(verdict).toEqual([
      {
        kind: "verdict",
        verdict: { approved: false, reasoning: "not yet", requiredChanges: ["fix it"] },
      },
    ])
  })

  it("reads a blocked status from the marker attribute", () => {
    const segments = splitGoalMarkers(
      '<masterhand:goal status="blocked">{"summary": "stuck", "reason": "no key"}</masterhand:goal>',
    )
    expect(segments).toEqual([
      {
        kind: "report",
        report: { status: "blocked", summary: "stuck", evidence: [], reason: "no key" },
      },
    ])
  })

  it("keeps a malformed block visible instead of dropping text", () => {
    const text = '<masterhand:goal>{not json}</masterhand:goal>'
    expect(splitGoalMarkers(text)).toEqual([{ kind: "text", text }])
  })

  it("hides a trailing marker that is still streaming", () => {
    const segments = splitGoalMarkers(
      'All done.\n<masterhand:goal status="complete">{"summary": "str',
    )
    expect(segments).toEqual([{ kind: "text", text: "All done.\n" }])
  })

  it("keeps a prose mention of the protocol visible when no tag was opened", () => {
    const text = "Finish by writing <masterhand:goal in your last message."
    expect(splitGoalMarkers(text)).toEqual([{ kind: "text", text }])
  })

  it("returns the whole text when no marker is present", () => {
    expect(splitGoalMarkers("plain reply")).toEqual([{ kind: "text", text: "plain reply" }])
  })
})

describe("goalReviewRounds", () => {
  it("appends the in-flight round after the settled history", () => {
    const run = normalizeGoalRun(
      goalRun({
        round: 2,
        state: "judging",
        lastCritique: { argument: "still broken", issues: [] },
        history: [
          {
            round: 1,
            critique: { argument: "old", issues: [] },
            verdict: { approved: false, reasoning: "r", requiredChanges: [] },
          },
        ],
      }),
    ) as GoalRun
    const rounds = goalReviewRounds(run)
    expect(rounds).toHaveLength(2)
    expect(rounds[0]).toMatchObject({ round: 1, current: false })
    expect(rounds[1]).toMatchObject({ round: 2, current: true })
    expect(rounds[1]?.critique?.argument).toBe("still broken")
  })

  it("does not repeat the previous round's critique while the next one runs", () => {
    const run = normalizeGoalRun(
      goalRun({
        round: 2,
        state: "running",
        lastCritique: { argument: "old", issues: [] },
        history: [
          {
            round: 1,
            critique: { argument: "old", issues: [] },
            verdict: { approved: false, reasoning: "r", requiredChanges: [] },
          },
        ],
      }),
    ) as GoalRun
    const rounds = goalReviewRounds(run)
    expect(rounds.at(-1)).toMatchObject({ round: 2, current: true, critique: null, verdict: null })
  })

  it("returns the settled history only when the run is over", () => {
    const run = normalizeGoalRun(
      goalRun({
        state: "approved",
        round: 1,
        lastCritique: { argument: "none", issues: [] },
        lastVerdict: { approved: true, reasoning: "verified", requiredChanges: [] },
        history: [
          {
            round: 1,
            critique: { argument: "none", issues: [] },
            verdict: { approved: true, reasoning: "verified", requiredChanges: [] },
          },
        ],
      }),
    ) as GoalRun
    const rounds = goalReviewRounds(run)
    expect(rounds).toHaveLength(1)
    expect(rounds[0]?.current).toBe(false)
  })
})

describe("goalActivityLabel", () => {
  it("describes the awaited phase", () => {
    const base = normalizeGoalRun(goalRun()) as GoalRun
    expect(goalActivityLabel({ ...base, state: "critiquing", awaitingKind: "critic" })).toContain("critic")
    expect(goalActivityLabel({ ...base, state: "judging", awaitingKind: "judge" })).toContain("judge")
    expect(goalActivityLabel({ ...base, state: "running", awaitingKind: "main" })).toContain("main agent")
    expect(goalActivityLabel({ ...base, state: "running", awaitingKind: null })).toContain("main agent")
  })

  it("prefers the transient error note and falls back to the state label", () => {
    const base = normalizeGoalRun(goalRun()) as GoalRun
    expect(goalActivityLabel({ ...base, lastError: "retrying the provider" })).toBe("retrying the provider")
    expect(goalActivityLabel({ ...base, state: "approved", awaitingKind: null })).toBe("Goal approved")
  })
})
