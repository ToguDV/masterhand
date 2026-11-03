import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native"
import { queryKeys, type InterruptedTurn } from "@masterhand/client-core"
import { InterruptedTurnCard } from "../src/components/InterruptedTurnCard"
import { fakeClient, makeQueryClient, QueryWrapper } from "./support/render"

async function setup(options: { state?: "interrupted" | "ambiguous"; reject?: boolean } = {}) {
  const client = fakeClient()
  const turns: InterruptedTurn[] = [
    {
      sessionID: "s1",
      startedAt: 1,
      state: options.state ?? "interrupted",
      reason: "engine",
    },
  ]
  client.api.turns.mockResolvedValue(turns)
  if (options.reject) client.api.resumeTurn.mockRejectedValue(new Error("failed"))
  const queryClient = makeQueryClient()
  queryClient.setQueryData(queryKeys.turns, turns)
  await render(<InterruptedTurnCard client={client} sessionID="s1" />, {
    wrapper: ({ children }) => <QueryWrapper client={queryClient}>{children}</QueryWrapper>,
  })
  await act(async () => {})
  return { client, queryClient }
}

describe("InterruptedTurnCard (mobile resilience)", () => {
  it("renders nothing for a session without an interrupted turn", async () => {
    const client = fakeClient()
    client.api.turns.mockResolvedValue([])
    const queryClient = makeQueryClient()
    queryClient.setQueryData(queryKeys.turns, [])
    await render(<InterruptedTurnCard client={client} sessionID="s1" />, {
      wrapper: ({ children }) => <QueryWrapper client={queryClient}>{children}</QueryWrapper>,
    })
    await act(async () => {})
    expect(screen.toJSON()).toBeNull()
  })

  it("offers Continue and sends the marker-reconciled continuation", async () => {
    const { client } = await setup()
    expect(screen.getByText(/interrupted by a restart/i)).toBeTruthy()
    await act(async () => {
      fireEvent.press(screen.getByText("Continue"))
    })
    expect(client.api.resumeTurn).toHaveBeenCalledWith("s1")
  })

  it("shows the unknown-outcome copy for an ambiguous turn", async () => {
    await setup({ state: "ambiguous" })
    expect(screen.getByText(/could not confirm whether the continuation landed/i)).toBeTruthy()
  })

  it("shows an error when the continuation does not start", async () => {
    await setup({ reject: true })
    await act(async () => {
      fireEvent.press(screen.getByText("Continue"))
    })
    await waitFor(() => expect(screen.getByText(/continuation did not start/i)).toBeTruthy())
  })
})
