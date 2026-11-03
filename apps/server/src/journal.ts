import type { Store, TurnRecord, TurnState } from "./store.js"

/**
 * Durable turn journal (resilience, migration v6).
 *
 * opencode persists sessions and messages, but not the process executing a
 * turn: when the engine (or the BFF) dies mid-turn there is no terminal event
 * and no record of which sessions were busy. The hub already receives
 * `session.execution.*`, so the BFF keeps one row per session and closes it on
 * the authoritative terminal event. A row still `running` after a reconnect is
 * the exact definition of "this turn died" that the recovery pass consumes.
 *
 * The journal never decides to resume anything by itself: `engine.ts` owns the
 * policy/caps and sends the continuation prompt through the marker-reconciled
 * retry engine. User aborts close as `cancelled` (never auto-continued); a
 * reported failure closes as `failed`; only a missing terminal event leaves
 * `running`, which recovery classifies as `interrupted`.
 */

/** Prompt metadata key of an automatic/manual continuation (never replayed blind). */
export const TURN_RESUME_MARKER_KEY = "masterhand.resume"

export interface TurnJournalOptions {
  store: Store
  emit?: (event: unknown) => void
  now?: () => number
  /** Terminal rows kept for diagnostics (default 24 h). */
  terminalTtlMs?: number
  /** An open row older than this is stale and pruned (default 7 days). */
  openTtlMs?: number
  /** Retention pass interval; 0 disables the timer (tests drive `prune`). */
  pruneIntervalMs?: number
}

export interface TurnJournal {
  handleEvent(event: unknown): void
  get(sessionID: string): TurnRecord | null
  list(states?: TurnState[], limit?: number): TurnRecord[]
  /** Closes an open row; a no-op when it is missing or already terminal. */
  close(sessionID: string, state: TurnState, reason?: string | null): void
  /** Marks a continuation as sent (automatic or manual). */
  markResumed(sessionID: string, automatic: boolean): void
  /** The continuation outcome is unknown: never retry it blind. */
  markAmbiguous(sessionID: string, reason: string): void
  /** A continuation failed definitively; keep the turn resumable but spend the attempt. */
  markResumeFailed(sessionID: string, reason: string): void
  remove(sessionID: string): void
  prune(): void
  stop(): void
}

const DEFAULT_TERMINAL_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_OPEN_TTL_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000

function eventData(event: unknown): Record<string, unknown> | null {
  const data = (event as { data?: unknown } | null)?.data
  return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null
}

function eventType(event: unknown): string | null {
  const type = (event as { type?: unknown } | null)?.type
  return typeof type === "string" ? type : null
}

function errorReason(data: Record<string, unknown>): string {
  const error = data.error
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const message = (error as { message?: unknown }).message
    if (typeof message === "string" && message.trim()) return message.trim()
    const type = (error as { type?: unknown }).type
    if (typeof type === "string" && type.trim()) return type.trim()
  }
  if (typeof error === "string" && error.trim()) return error.trim()
  return "the agent turn failed"
}

export function createTurnJournal(options: TurnJournalOptions): TurnJournal {
  const { store } = options
  const emit = options.emit ?? (() => {})
  const now = options.now ?? Date.now
  const terminalTtlMs = options.terminalTtlMs ?? DEFAULT_TERMINAL_TTL_MS
  const openTtlMs = options.openTtlMs ?? DEFAULT_OPEN_TTL_MS
  const pruneIntervalMs = options.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS

  function announce(sessionID: string, state: TurnState, reason: string | null): void {
    emit({
      type: state === "interrupted" ? "turn.interrupted" : "turn.updated",
      data: { sessionID, state, reason },
    })
  }

  function startTurn(sessionID: string, workspacePath: string | null): void {
    const current = store.getTurn(sessionID)
    if (current && current.state === "running") {
      // Duplicate start for the same turn: keep the original boundary.
      store.saveTurn({
        ...current,
        workspacePath: current.workspacePath ?? workspacePath,
        lastEventAt: now(),
      })
      return
    }
    // A continuation's `execution.started` may arrive before or after the
    // prompt response that marks it resumed. Preserve its counters so the
    // per-turn/per-incident budget survives the new execution boundary.
    const preserve = current?.state === "resumed"
    store.saveTurn({
      sessionID,
      workspacePath,
      startedAt: now(),
      lastEventAt: now(),
      state: "running",
      origin: "chat",
      reason: null,
      resumeAttempts: preserve ? current.resumeAttempts : 0,
      lastResumeAt: preserve ? current.lastResumeAt : null,
    })
  }

  function close(sessionID: string, state: TurnState, reason: string | null = null): void {
    const current = store.getTurn(sessionID)
    if (!current) return
    // Terminal events close a running/resumed turn. A late success may also
    // correct an interrupted/ambiguous classification (the assistant actually
    // finished while the BFF was down); the reverse never overwrites a
    // completed turn.
    const closable =
      current.state === "running" ||
      current.state === "resumed" ||
      (state === "completed" && (current.state === "interrupted" || current.state === "ambiguous"))
    if (!closable) return
    store.saveTurn({ ...current, state, reason, lastEventAt: now() })
    if (state === "interrupted" || state === "failed" || state === "cancelled") {
      announce(sessionID, state, reason)
    }
  }

  function handleEvent(event: unknown): void {
    const type = eventType(event)
    if (!type) return
    const data = eventData(event)
    const sessionID = typeof data?.sessionID === "string" ? data.sessionID : ""
    if (!sessionID) return

    if (type === "session.deleted") {
      store.removeTurn(sessionID)
      return
    }
    if (type === "session.execution.started") {
      const location = (event as { location?: { directory?: unknown } } | null)?.location
      const directory = typeof location?.directory === "string" ? location.directory : null
      startTurn(sessionID, directory)
      return
    }
    if (type === "session.execution.succeeded") {
      close(sessionID, "completed")
      return
    }
    if (type === "session.execution.interrupted") {
      // A user abort has a terminal event: never auto-continue it.
      close(sessionID, "cancelled", "the turn was interrupted by the user")
      return
    }
    if (type === "session.execution.failed") {
      close(sessionID, "failed", errorReason(data ?? {}))
      return
    }
    if (type === "session.idle" || type === "session.status" || type === "session.retry.scheduled") {
      const current = store.getTurn(sessionID)
      if (current && current.state === "running") {
        store.saveTurn({ ...current, lastEventAt: now() })
      }
    }
  }

  function prune(): void {
    const current = now()
    store.pruneTurns(current - terminalTtlMs, current - openTtlMs)
  }

  prune()
  const timer = pruneIntervalMs > 0 ? setInterval(prune, pruneIntervalMs) : null
  ;(timer as { unref?: () => void } | null)?.unref?.()

  return {
    handleEvent,
    get(sessionID) {
      return store.getTurn(sessionID)
    },
    list(states, limit) {
      return store.listTurns(states, limit)
    },
    close,
    markResumed(sessionID, automatic) {
      const current = store.getTurn(sessionID)
      if (!current) return
      const next: TurnRecord = {
        ...current,
        // If the continuation already emitted `execution.started`, the row is
        // running: keep it running and only record the budget/attribution.
        state: current.state === "running" ? "running" : "resumed",
        reason: automatic ? "the continuation was sent automatically" : "the continuation was requested by the user",
        resumeAttempts: current.resumeAttempts + 1,
        lastResumeAt: now(),
        lastEventAt: now(),
      }
      store.saveTurn(next)
      emit({ type: "turn.resumed", data: { sessionID, automatic } })
    },
    markAmbiguous(sessionID, reason) {
      const current = store.getTurn(sessionID)
      if (!current) return
      store.saveTurn({ ...current, state: "ambiguous", reason, lastEventAt: now() })
      announce(sessionID, "ambiguous", reason)
    },
    markResumeFailed(sessionID, reason) {
      const current = store.getTurn(sessionID)
      if (!current) return
      store.saveTurn({
        ...current,
        state: "interrupted",
        reason,
        resumeAttempts: current.resumeAttempts + 1,
        lastResumeAt: now(),
        lastEventAt: now(),
      })
    },
    remove(sessionID) {
      store.removeTurn(sessionID)
    },
    prune,
    stop() {
      if (timer) clearInterval(timer)
    },
  }
}

/** Only root, user-facing chat turns are safe to auto-continue. */
export function isChatTurn(record: TurnRecord): boolean {
  return record.origin === "chat"
}
