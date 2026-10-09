import { act, fireEvent, render, screen } from "@testing-library/react-native"
import type { GoalRun } from "@masterhand/client-core"
import { GoalReview } from "../src/components/GoalReview"
import { fakeClient, makeQueryClient, QueryWrapper } from "./support/render"

function makeRun(overrides: Partial<GoalRun> = {}): GoalRun {
  return {
    sessionID: "s1",
    goal: "Ship the feature",
    state: "running",
    round: 1,
    maxRounds: 5,
    mainModel: null,
    criticModel: null,
    judgeModel: null,
    lastReport: null,
    lastCritique: null,
    lastVerdict: null,
    history: [],
    error: null,
    awaitingKind: null,
    attempt: 0,
    lastError: null,
    pausedPhase: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

async function setup(run: GoalRun | null) {
  const client = fakeClient()
  client.api.goal.status.mockResolvedValue(run)
  const queryClient = makeQueryClient()
  await render(<GoalReview client={client} sessionID="s1" />, {
    wrapper: ({ children }) => <QueryWrapper client={queryClient}>{children}</QueryWrapper>,
  })
  return { client }
}

describe("GoalReview", () => {
  it("renders nothing without a run", async () => {
    await setup(null)
    await act(async () => {})
    expect(screen.queryByTestId("goal-review")).toBeNull()
  })

  it("renders the latest round open with the critic and judge content", async () => {
    await setup(
      makeRun({
        state: "approved",
        history: [
          {
            round: 1,
            critique: {
              argument: "The retry path is untested",
              issues: [{ severity: "high", claim: "no coverage", evidence: "no test found" }],
            },
            verdict: { approved: true, reasoning: "verified", requiredChanges: [] },
          },
        ],
      }),
    )

    // The internal sessions never list; their markers render here.
    expect(await screen.findByText("Goal review")).toBeOnTheScreen()
    expect(screen.getByText("Round 1")).toBeOnTheScreen()
    // The argument and the verdict reasoning appear both as the collapsed
    // round summary and in the expanded body: assert at least one.
    expect(screen.getAllByText("The retry path is untested").length).toBeGreaterThan(0)
    expect(screen.getByText("no coverage")).toBeOnTheScreen()
    expect(screen.getAllByText("verified").length).toBeGreaterThan(0)
  })

  it("collapses older rounds and expands them on demand", async () => {
    await setup(
      makeRun({
        round: 2,
        state: "judging",
        lastCritique: { argument: "round two critique", issues: [] },
        history: [
          {
            round: 1,
            critique: { argument: "round one critique", issues: [] },
            verdict: { approved: false, reasoning: "not yet", requiredChanges: ["fix it"] },
          },
        ],
      }),
    )

    // Only the in-flight round is open by default.
    expect((await screen.findAllByText("round two critique")).length).toBeGreaterThan(0)
    expect(screen.queryByText("round one critique")).toBeNull()

    await fireEvent.press(screen.getByLabelText("Round 1"))
    expect(screen.getByText("round one critique")).toBeOnTheScreen()
    expect(screen.getAllByText("not yet").length).toBeGreaterThan(0)
  })
})
