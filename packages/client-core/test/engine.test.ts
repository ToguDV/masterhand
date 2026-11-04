import { describe, expect, it } from "vitest"
import { engineAvailability } from "../src/engine"
import type { EngineStatusView } from "../src/types"

function engine(overrides: Partial<EngineStatusView> = {}): EngineStatusView {
  return {
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
    ...overrides,
  }
}

describe("engineAvailability", () => {
  it("is unmanaged without a supervisor or before the first status", () => {
    expect(engineAvailability(undefined)).toBe("unmanaged")
    expect(engineAvailability(engine({ supervisor: false, state: "exited" }))).toBe("unmanaged")
  })

  it("reports running, restarting and the circuit", () => {
    expect(engineAvailability(engine())).toBe("running")
    expect(engineAvailability(engine({ restarting: true }))).toBe("restarting")
    expect(engineAvailability(engine({ state: "restarting" }))).toBe("restarting")
    expect(engineAvailability(engine({ circuitOpen: true, state: "exited" }))).toBe("circuit")
  })

  it("only treats real Docker stop states as stopped", () => {
    for (const state of ["exited", "dead", "created", "paused"]) {
      expect(engineAvailability(engine({ state }))).toBe("stopped")
    }
  })

  it("treats an unknown or unrecognized state as unknown, never stopped", () => {
    // Regression: a watchdog configured for the wrong Compose project reports
    // `state: "unknown"`; the UI claimed the engine was stopped and its Start
    // button answered 404 not_found.
    expect(engineAvailability(engine({ state: "unknown" }))).toBe("unknown")
    expect(engineAvailability(engine({ state: "removing" }))).toBe("unknown")
  })
})
