/**
 * Ordered shutdown for the BFF process (issue #192).
 *
 * Order matters: the HTTP server stops first (its long-lived SSE streams
 * would otherwise hold `server.close` open forever), then the scheduler and
 * goal managers stop producing work and drain against a deadline while the
 * store is still live, and the store closes last. A forced-exit timer installs
 * first so a stalled step can never hang a SIGTERM (docker stop, tests).
 */
export interface ShutdownResources {
  scheduler?: { stop(): void; flush(): Promise<void> } | null
  goals?: { stop(): void; flush(): Promise<void> } | null
  preview: { stopAll(): void }
  hub: { stop(): void }
  store: { close(): void }
  server: {
    close(callback: (err?: Error) => void): unknown
    closeAllConnections?: () => void
  }
  /** Single-instance lock (issue #208): released after the managers stop. */
  lock?: { release(): void | Promise<void> } | null
  /**
   * In-flight request work (issue #192 follow-up): finishes and releases that
   * started before the shutdown must settle against a live store instead of
   * waking up after `store.close()` to a closed database handle.
   */
  drainInFlight?: () => Promise<void>
}

export interface ShutdownOptions {
  exit?: (code: number) => void
  schedule?: (fn: () => void, ms: number) => unknown
  /** Bound for `server.close` (default {@link SHUTDOWN_SERVER_CLOSE_MS}). */
  serverCloseMs?: number
  /** Bound for the scheduler/goal drain (default {@link SHUTDOWN_FLUSH_MS}). */
  flushMs?: number
  /** Backstop exit (default {@link SHUTDOWN_FORCED_EXIT_MS}). */
  forcedExitMs?: number
}

/** `server.close` never waits on a client longer than this. */
export const SHUTDOWN_SERVER_CLOSE_MS = 5_000
/** In-flight scheduler/goal transitions drain no longer than this. */
export const SHUTDOWN_FLUSH_MS = 5_000
/** SIGTERM always ends the process by this deadline, however stuck it is. */
export const SHUTDOWN_FORCED_EXIT_MS = 10_000

export async function shutdownServer(
  resources: ShutdownResources,
  code = 0,
  options: ShutdownOptions = {},
): Promise<void> {
  const exit = options.exit ?? ((status: number) => process.exit(status))
  const schedule = options.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const serverCloseMs = options.serverCloseMs ?? SHUTDOWN_SERVER_CLOSE_MS
  const flushMs = options.flushMs ?? SHUTDOWN_FLUSH_MS
  const forcedExitMs = options.forcedExitMs ?? SHUTDOWN_FORCED_EXIT_MS

  // First: never hang a SIGTERM. Every step below is bounded too, but a
  // wedged runtime must still exit (docker stop, tests).
  schedule(() => exit(code), forcedExitMs)

  // Stop accepting new connections, then drop the open ones: the SSE stream
  // to every connected client is long-lived and would otherwise hold
  // `server.close` open until this process is killed.
  try {
    resources.server.closeAllConnections?.()
  } catch {
    // best effort: the bounded close below still runs
  }
  await new Promise<void>((resolve) => {
    let settled = false
    const done = (): void => {
      if (!settled) {
        settled = true
        resolve()
      }
    }
    try {
      resources.server.close(() => done())
    } catch {
      done()
      return
    }
    schedule(done, serverCloseMs)
  })

  // No new manager work from here (timers stopped first); the in-flight
  // chains drain against a deadline while the store they write to is live.
  for (const manager of [resources.scheduler, resources.goals]) {
    try {
      manager?.stop()
    } catch {
      // best effort: the remaining steps still run
    }
  }
  await Promise.race([
    Promise.allSettled([
      resources.scheduler ? resources.scheduler.flush().catch(() => {}) : undefined,
      resources.goals ? resources.goals.flush().catch(() => {}) : undefined,
      resources.drainInFlight ? resources.drainInFlight().catch(() => {}) : undefined,
    ]),
    new Promise<void>((resolve) => schedule(resolve, flushMs)),
  ])

  try {
    resources.preview.stopAll()
  } catch {
    // best effort
  }
  try {
    resources.hub.stop()
  } catch {
    // best effort
  }
  try {
    await Promise.race([
      Promise.resolve(resources.lock?.release()).catch(() => {}),
      new Promise<void>((resolve) => schedule(resolve, flushMs)),
    ])
  } catch {
    // best effort: the bind dies with the process either way
  }
  try {
    resources.store.close()
  } catch (error) {
    console.error("[masterhand] shutdown store close failed:", error)
  }
  exit(code)
}
