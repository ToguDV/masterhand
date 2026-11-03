import { act, fireEvent, render, screen } from "@testing-library/react-native"
import { queryKeys, type BffStatus } from "@masterhand/client-core"
import { EngineBanner } from "../src/components/EngineBanner"
import { fakeClient, makeQueryClient, QueryWrapper } from "./support/render"

function status(engine: NonNullable<BffStatus["engine"]>): BffStatus {
  return { ok: true, engine }
}

const HEALTHY = {
  supervisor: true,
  healthy: true,
  restarting: false,
  circuitOpen: false,
  state: "running",
  memoryWarning: false,
  attempts: 0,
  maxAttempts: 3,
  lastIncident: null,
  memory: null,
  serverIncident: null,
  serverCircuitOpen: false,
  interruptedTurns: 0,
  autoResume: true,
  autoContinueChats: true,
}

async function setup(engine: BffStatus["engine"]) {
  const client = fakeClient()
  const payload = status(engine!)
  client.auth.status.mockResolvedValue(payload)
  const queryClient = makeQueryClient()
  queryClient.setQueryData(queryKeys.status, payload)
  await render(<EngineBanner client={client} />, {
    wrapper: ({ children }) => <QueryWrapper client={queryClient}>{children}</QueryWrapper>,
  })
  await act(async () => {})
  return { client, queryClient }
}

describe("EngineBanner (mobile resilience)", () => {
  it("stays hidden while everything is healthy", async () => {
    await setup(HEALTHY)
    expect(screen.toJSON()).toBeNull()
  })

  it("shows the restarting state", async () => {
    await setup({ ...HEALTHY, restarting: true, state: "restarting" })
    expect(screen.getByText(/agent engine is restarting/i)).toBeTruthy()
  })

  it("shows the circuit and starts the engine", async () => {
    const { client } = await setup({ ...HEALTHY, circuitOpen: true, state: "exited", attempts: 3 })
    expect(screen.getByText(/stopped after repeated crashes/i)).toBeTruthy()
    jest.useFakeTimers()
    try {
      await act(async () => {
        fireEvent.press(screen.getByText("Start engine"))
      })
      await act(async () => {
        jest.advanceTimersByTime(1_500)
      })
    } finally {
      jest.useRealTimers()
    }
    expect(client.api.restartEngine).toHaveBeenCalledTimes(1)
  })

  it("offers Start when the engine is stopped but the circuit was reset", async () => {
    await setup({ ...HEALTHY, state: "exited" })
    expect(screen.getByText(/agent engine is stopped/i)).toBeTruthy()
    expect(screen.getByText("Start engine")).toBeTruthy()
  })

  it("surfaces the last incident, memory pressure and the BFF circuit", async () => {
    await setup({
      ...HEALTHY,
      lastIncident: { at: Date.now(), service: "opencode", reason: "oom", attempt: 2, memory: null },
    })
    expect(screen.getByText(/restarted \(attempt 2 of 3\)/i)).toBeTruthy()
  })

  it("surfaces memory pressure", async () => {
    await setup({ ...HEALTHY, memoryWarning: true })
    expect(screen.getByText(/near its memory limit/i)).toBeTruthy()
  })

  it("surfaces the BFF restart circuit", async () => {
    await setup({ ...HEALTHY, serverCircuitOpen: true })
    expect(screen.getByText(/MasterHand restarted after repeated crashes/i)).toBeTruthy()
  })
})
