/**
 * Per-entity serialization chains (issue #205): the single-flight queues that
 * keep non-idempotent check→create transitions from interleaving. Goal Mode
 * (`goal.ts`) and the scheduler (`scheduler.ts`) had byte-identical copies —
 * `enqueue` swallowing failures into a log line, `runExclusive` propagating
 * them — differing only in the log scope. There is exactly one now.
 *
 * Semantics, preserved verbatim (rule 12):
 *
 * - `enqueue` appends fire-and-forget work: a failure is logged and the chain
 *   stays alive for the next task. Callers that need the outcome use
 *   `runExclusive`.
 * - `runExclusive` serializes a check→create behind the same tail but hands
 *   the rejection to the caller, while still advancing the chain for waiters.
 * - `flush` settles every pending tail (tests).
 */
export interface EntityChain {
  enqueue(id: string, task: () => Promise<void>): Promise<void>
  runExclusive<T>(id: string, task: () => Promise<T>): Promise<T>
  flush(): Promise<void>
}

export function createEntityChain(scope: string): EntityChain {
  const chains = new Map<string, Promise<unknown>>()

  function enqueue(id: string, task: () => Promise<void>): Promise<void> {
    const tail = chains.get(id) ?? Promise.resolve()
    const next = tail.then(task).catch((error) => {
      console.error(`[${scope}] ${id} transition failed:`, error)
    })
    chains.set(id, next)
    void next.finally(() => {
      if (chains.get(id) === next) chains.delete(id)
    })
    return next
  }

  function runExclusive<T>(id: string, task: () => Promise<T>): Promise<T> {
    const tail = chains.get(id) ?? Promise.resolve()
    const next = tail.then(task)
    const settled = next.then(
      () => undefined,
      () => undefined,
    )
    chains.set(id, settled)
    void settled.finally(() => {
      if (chains.get(id) === settled) chains.delete(id)
    })
    return next
  }

  async function flush(): Promise<void> {
    while (chains.size > 0) await Promise.allSettled([...chains.values()])
  }

  return { enqueue, runExclusive, flush }
}
