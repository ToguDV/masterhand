import { describe, expect, it } from "vitest"
import {
  SHUTDOWN_FLUSH_MS,
  SHUTDOWN_FORCED_EXIT_MS,
  SHUTDOWN_SERVER_CLOSE_MS,
  shutdownServer,
  type ShutdownResources,
} from "../src/shutdown.js"

interface ScheduledCall {
  fn: () => void
  ms: number
}

function setup(overrides: Partial<ShutdownResources> = {}) {
  const order: string[] = []
  const scheduled: ScheduledCall[] = []
  const exits: number[] = []
  const resources: ShutdownResources = {
    scheduler: {
      stop: () => void order.push("scheduler.stop"),
      flush: async () => void order.push("scheduler.flush"),
    },
    goals: {
      stop: () => void order.push("goals.stop"),
      flush: async () => void order.push("goals.flush"),
    },
    preview: {
      stopAll: async () => void order.push("preview.stopAll"),
    },
    hub: { stop: () => void order.push("hub.stop") },
    store: { close: () => void order.push("store.close") },
    server: {
      close: (callback: (err?: Error) => void) => {
        order.push("server.close")
        callback()
      },
      closeAllConnections: () => void order.push("server.closeAllConnections"),
    },
    ...overrides,
  }
  const options = {
    exit: (code: number) => void exits.push(code),
    schedule: (fn: () => void, ms: number) => void scheduled.push({ fn, ms }),
  }
  return { order, scheduled, exits, resources, options }
}

/** Lets the shutdown run to its next parked await (fake timers never advance). */
async function tick(times = 5): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function fire(scheduled: ScheduledCall[], ms: number): void {
  const call = scheduled.find((entry) => entry.ms === ms)
  if (!call) throw new Error(`no scheduled call at ${ms}ms`)
  call.fn()
}

describe("shutdownServer (issue #192)", () => {
  it("closes HTTP before the store, and the store closes last", async () => {
    const { order, resources, options, scheduled } = setup()
    const pending = shutdownServer(resources, 0, options)
    await tick()
    for (const call of scheduled.filter((entry) => entry.ms !== SHUTDOWN_FORCED_EXIT_MS)) call.fn()
    await pending
    expect(order.indexOf("server.close")).toBeLessThan(order.indexOf("store.close"))
    expect(order.indexOf("server.closeAllConnections")).toBeLessThan(order.indexOf("store.close"))
    expect(order[order.length - 1]).toBe("store.close")
  })

  it("stops and flushes the scheduler and the goals", async () => {
    const { order, resources, options, scheduled } = setup()
    const pending = shutdownServer(resources, 0, options)
    await tick()
    for (const call of scheduled.filter((entry) => entry.ms !== SHUTDOWN_FORCED_EXIT_MS)) call.fn()
    await pending
    for (const step of ["scheduler.stop", "scheduler.flush", "goals.stop", "goals.flush"]) {
      expect(order).toContain(step)
    }
    expect(order.indexOf("scheduler.stop")).toBeLessThan(order.indexOf("scheduler.flush"))
    expect(order.indexOf("goals.stop")).toBeLessThan(order.indexOf("goals.flush"))
  })

  it("bounds the manager flush instead of waiting forever", async () => {
    const { resources, options, scheduled, exits } = setup({
      scheduler: { stop: () => {}, flush: () => new Promise<void>(() => {}) },
      goals: { stop: () => {}, flush: () => new Promise<void>(() => {}) },
    })
    const pending = shutdownServer(resources, 0, { ...options, flushMs: 50 })
    await tick()
    expect(exits).toEqual([])
    fire(scheduled, 50)
    await pending
    expect(exits).toEqual([0])
  })

  it("bounds server.close instead of waiting on long-lived SSE streams", async () => {
    const { resources, options, scheduled, exits } = setup({
      server: {
        close: () => undefined,
        closeAllConnections: () => {},
      },
    })
    const pending = shutdownServer(resources, 0, { ...options, serverCloseMs: 50 })
    await tick()
    expect(exits).toEqual([])
    fire(scheduled, 50)
    // The flush race parks next; release it too so the shutdown completes.
    await tick()
    fire(scheduled, SHUTDOWN_FLUSH_MS)
    await pending
    expect(exits).toEqual([0])
  })

  it("installs the forced-exit timer first, before server.close runs", async () => {
    const { resources, options, scheduled } = setup()
    let scheduledBeforeClose = false
    const server = resources.server
    resources.server = {
      ...server,
      close: (callback: (err?: Error) => void) => {
        scheduledBeforeClose = scheduled.length > 0
        callback()
      },
    }
    const pending = shutdownServer(resources, 0, options)
    await tick()
    for (const call of scheduled.filter((entry) => entry.ms !== SHUTDOWN_FORCED_EXIT_MS)) call.fn()
    await pending
    expect(scheduledBeforeClose).toBe(true)
    expect(scheduled[0]?.ms).toBe(SHUTDOWN_FORCED_EXIT_MS)
  })

  it("forced-exits with the code even when close and flush never settle", async () => {
    const { resources, options, scheduled, exits } = setup({
      scheduler: { stop: () => {}, flush: () => new Promise<void>(() => {}) },
      goals: { stop: () => {}, flush: () => new Promise<void>(() => {}) },
      server: { close: () => undefined, closeAllConnections: () => {} },
    })
    const pending = shutdownServer(resources, 1, {
      ...options,
      serverCloseMs: 10_000,
      flushMs: 10_000,
      forcedExitMs: 25,
    })
    await tick()
    // The graceful path is still stuck on its bounds; only the forced timer exits.
    expect(exits).toEqual([])
    fire(scheduled, 25)
    expect(exits).toEqual([1])
    // Release the parked graceful path so the test leaves nothing hanging.
    // The flush bound only schedules after the close bound fires, so sweep twice.
    for (let sweep = 0; sweep < 2; sweep += 1) {
      for (const call of scheduled.filter((entry) => entry.ms !== 25)) call.fn()
      await tick()
    }
    await pending
  })

  it("exits with the requested code after a graceful shutdown", async () => {
    const { resources, options, scheduled, exits } = setup()
    const pending = shutdownServer(resources, 1, options)
    await tick()
    for (const call of scheduled.filter((entry) => entry.ms !== SHUTDOWN_FORCED_EXIT_MS)) call.fn()
    await pending
    // The graceful path exits on its own: the forced timer never had to fire.
    expect(exits).toEqual([1])
  })

  it("uses the documented default budgets", () => {
    expect(SHUTDOWN_SERVER_CLOSE_MS).toBe(5_000)
    expect(SHUTDOWN_FLUSH_MS).toBe(5_000)
    expect(SHUTDOWN_FORCED_EXIT_MS).toBe(10_000)
  })

  it("drains in-flight finishes and releases before closing the store", async () => {
    const { order, resources, options, scheduled } = setup({
      drainInFlight: async () => void order.push("drainInFlight"),
    })
    const pending = shutdownServer(resources, 0, options)
    await tick()
    for (const call of scheduled.filter((entry) => entry.ms !== SHUTDOWN_FORCED_EXIT_MS)) call.fn()
    await pending
    expect(order).toContain("drainInFlight")
    expect(order.indexOf("drainInFlight")).toBeLessThan(order.indexOf("store.close"))
  })

  it("still closes the store when the in-flight drain never settles", async () => {
    const { resources, options, scheduled, exits } = setup({
      drainInFlight: () => new Promise<void>(() => {}),
    })
    const pending = shutdownServer(resources, 0, { ...options, flushMs: 50 })
    await tick()
    expect(exits).toEqual([])
    fire(scheduled, 50)
    await pending
    expect(exits).toEqual([0])
  })

  it("still exits when close steps throw (best effort)", async () => {
    const { resources, options, scheduled, exits } = setup({
      server: {
        close: () => {
          throw new Error("already closed")
        },
        closeAllConnections: () => {
          throw new Error("no connections")
        },
      },
      store: {
        close: () => {
          throw new Error("disk gone")
        },
      },
    })
    const error = console.error
    console.error = () => {}
    try {
      const pending = shutdownServer(resources, 2, options)
      await tick()
      for (const call of scheduled.filter((entry) => entry.ms !== SHUTDOWN_FORCED_EXIT_MS)) call.fn()
      await pending
      expect(exits).toEqual([2])
    } finally {
      console.error = error
    }
  })

  it("releases the instance lock before closing the store (issue #208)", async () => {
    const { order, resources, options, scheduled, exits } = setup()
    let releaseResolve!: () => void
    const releaseGate = new Promise<void>((resolve) => {
      releaseResolve = resolve
    })
    resources.lock = {
      release: async () => {
        order.push("lock.release")
        await releaseGate
      },
    }
    const pending = shutdownServer(resources, 0, options)
    await tick()
    // The shutdown parks on the lock release: the store must not close first.
    expect(order).toContain("lock.release")
    expect(order).not.toContain("store.close")
    releaseResolve()
    for (const call of scheduled.filter((entry) => entry.ms !== SHUTDOWN_FORCED_EXIT_MS)) call.fn()
    await pending
    expect(order.indexOf("lock.release")).toBeLessThan(order.indexOf("store.close"))
    expect(exits).toEqual([0])
  })
})
