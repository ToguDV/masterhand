import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native"
import type { GoalRun } from "@masterhand/client-core"
import { GoalStrip } from "../src/components/GoalStrip"
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
    criticSessionID: null,
    judgeSessionID: null,
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
  await render(<GoalStrip client={client} sessionID="s1" />, {
    wrapper: ({ children }) => <QueryWrapper client={queryClient}>{children}</QueryWrapper>,
  })
  return { client, queryClient }
}

describe("GoalStrip (#130)", () => {
  it("renders nothing without a run", async () => {
    const { client } = await setup(null)

    await waitFor(() => expect(client.api.goal.status).toHaveBeenCalledWith("s1"))
    await act(async () => {})
    expect(screen.toJSON()).toBeNull()
  })

  it("shows the phase, round and last review result", async () => {
    await setup(
      makeRun({
        state: "critiquing",
        round: 2,
        lastCritique: { argument: "The tests do not cover the retry path", issues: [] },
      }),
    )

    expect(await screen.findByText("Under review")).toBeOnTheScreen()
    expect(screen.getByText("2/5")).toBeOnTheScreen()
    expect(screen.getByText("The tests do not cover the retry path")).toBeOnTheScreen()
  })

  it("shows a result line and the transient error while active", async () => {
    const run = makeRun({ lastError: "retrying the provider" })
    await setup(run)

    expect(await screen.findByText("retrying the provider")).toBeOnTheScreen()
  })

  it("pauses an active run and reconciles the state", async () => {
    const { client } = await setup(makeRun())

    await fireEvent.press(await screen.findByText("Pause"))

    expect(client.api.goal.pause).toHaveBeenCalledWith("s1")
    // The mutation invalidates the run query instead of trusting the response.
    await waitFor(() => expect(client.api.goal.status).toHaveBeenCalledTimes(2))
  })

  it("cancels an active run", async () => {
    const { client } = await setup(makeRun())

    await fireEvent.press(await screen.findByText("Cancel"))

    expect(client.api.goal.cancel).toHaveBeenCalledWith("s1")
  })

  it("resumes a paused run", async () => {
    const { client } = await setup(makeRun({ state: "paused" }))

    await fireEvent.press(await screen.findByText("Resume"))

    expect(client.api.goal.resume).toHaveBeenCalledWith("s1")
    expect(screen.queryByText("Pause")).toBeNull()
  })

  it("labels the resume action Retry on error and shows the run error", async () => {
    const { client } = await setup(makeRun({ state: "error", error: "The judge crashed" }))

    expect(await screen.findByText("The judge crashed")).toBeOnTheScreen()
    expect(screen.queryByText("Resume")).toBeNull()
    await fireEvent.press(screen.getByText("Retry"))

    expect(client.api.goal.resume).toHaveBeenCalledWith("s1")
  })

  it("surfaces a failed action with the goal error message", async () => {
    const { client } = await setup(makeRun({ state: "paused" }))
    client.api.goal.resume.mockRejectedValue(new Error("offline"))

    await fireEvent.press(await screen.findByText("Resume"))

    expect(await screen.findByText("The goal action failed")).toBeOnTheScreen()
  })

  it("shows the round chip and no history controls (the thread owns the review)", async () => {
    await setup(makeRun({ round: 3, maxRounds: 7, state: "approved" }))

    expect(await screen.findByText("3/7")).toBeOnTheScreen()
    // The review history moved into the chat thread (GoalReview); the strip is
    // only the control/status line.
    expect(screen.queryByText("Details")).toBeNull()
    expect(screen.queryByText("Hide")).toBeNull()
  })
})
