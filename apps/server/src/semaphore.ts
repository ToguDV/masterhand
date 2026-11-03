/**
 * Tiny counting semaphore for bounded in-process work.
 *
 * Uploads are the one route that materializes a caller-sized buffer in the
 * BFF: `parseBody()` plus `arrayBuffer()` can peak at several times the file
 * size per request. Two concurrent 50 MB uploads against a 1 GB container are
 * already a significant spike, so the route admits a fixed number and rejects
 * the rest with `429` instead of queueing without bound (failure class A).
 */
export interface Semaphore {
  /** Runs `task` with a slot, releasing it when the task settles. */
  run<T>(task: () => Promise<T>, options?: { maxWaiters?: number }): Promise<T>
  readonly active: number
  readonly waiting: number
}

export class SemaphoreBusyError extends Error {
  constructor() {
    super("too many concurrent operations")
    this.name = "SemaphoreBusyError"
  }
}

export function createSemaphore(limit: number): Semaphore {
  const capacity = Math.max(1, Math.trunc(limit))
  let active = 0
  const waiters: Array<() => void> = []

  function release(): void {
    active = Math.max(0, active - 1)
    const next = waiters.shift()
    if (next) {
      active += 1
      next()
    }
  }

  async function acquire(maxWaiters: number): Promise<() => void> {
    if (active < capacity) {
      active += 1
      return release
    }
    if (waiters.length >= maxWaiters) throw new SemaphoreBusyError()
    await new Promise<void>((resolve) => waiters.push(resolve))
    // The releasing side already incremented `active` for this waiter.
    return release
  }

  return {
    async run(task, options = {}) {
      const releaseSlot = await acquire(Math.max(0, options.maxWaiters ?? 4))
      try {
        return await task()
      } finally {
        releaseSlot()
      }
    },
    get active() {
      return active
    },
    get waiting() {
      return waiters.length
    },
  }
}
