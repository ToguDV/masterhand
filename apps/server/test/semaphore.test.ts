import { describe, expect, it } from "vitest"
import { SemaphoreBusyError, createSemaphore } from "../src/semaphore.js"

function deferred() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("semaphore", () => {
  it("admits at most `limit` tasks at once and rejects the overflow", async () => {
    const semaphore = createSemaphore(2)
    const gates = [deferred(), deferred()]
    let active = 0
    let peak = 0
    const task = async (gate: Promise<void>) =>
      semaphore.run(async () => {
        active += 1
        peak = Math.max(peak, active)
        await gate
        active -= 1
      })

    const first = task(gates[0]!.promise)
    const second = task(gates[1]!.promise)
    // Two slots are busy; the next two queue, the fifth is refused.
    const thirdGate = deferred()
    const third = task(thirdGate.promise)
    const fourthGate = deferred()
    const fourth = task(fourthGate.promise)
    await expect(semaphore.run(async () => {}, { maxWaiters: 0 })).rejects.toBeInstanceOf(SemaphoreBusyError)

    gates[0]!.resolve()
    gates[1]!.resolve()
    await Promise.all([first, second])
    expect(semaphore.active).toBe(2) // third/fourth were admitted in order
    thirdGate.resolve()
    fourthGate.resolve()
    await Promise.all([third, fourth])
    expect(peak).toBe(2)
    expect(semaphore.active).toBe(0)
  })

  it("releases the slot when the task throws", async () => {
    const semaphore = createSemaphore(1)
    await expect(
      semaphore.run(async () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
    expect(semaphore.active).toBe(0)
    await expect(semaphore.run(async () => 42)).resolves.toBe(42)
  })
})
