import { describe, expect, it } from "vitest"
import { createTurnJournal, TURN_RESUME_MARKER_KEY } from "../src/journal.js"
import { createSqliteStore, type Store } from "../src/store.js"

function setup(options: { now?: () => number } = {}) {
  const store: Store = createSqliteStore(":memory:")
  const events: unknown[] = []
  let clock = 1_000
  const now = options.now ?? (() => clock)
  const journal = createTurnJournal({
    store,
    emit: (event) => events.push(event),
    now,
    pruneIntervalMs: 0,
  })
  return {
    store,
    journal,
    events,
    advance(ms: number) {
      clock += ms
    },
    setClock(value: number) {
      clock = value
    },
    now,
  }
}

describe("turn journal", () => {
  it("opens a running turn on execution.started and records the directory", () => {
    const h = setup()
    h.journal.handleEvent({
      type: "session.execution.started",
      location: { directory: "/workspace/app" },
      data: { sessionID: "ses_1" },
    })
    const turn = h.journal.get("ses_1")!
    expect(turn).toMatchObject({
      sessionID: "ses_1",
      workspacePath: "/workspace/app",
      state: "running",
      origin: "chat",
      resumeAttempts: 0,
    })
    expect(turn.startedAt).toBe(1_000)
  })

  it("keeps the original start on a duplicate started event", () => {
    const h = setup()
    h.journal.handleEvent({ type: "session.execution.started", data: { sessionID: "ses_1" } })
    h.advance(500)
    h.journal.handleEvent({
      type: "session.execution.started",
      location: { directory: "/workspace/app" },
      data: { sessionID: "ses_1" },
    })
    expect(h.journal.get("ses_1")).toMatchObject({ startedAt: 1_000, workspacePath: "/workspace/app" })
  })

  it("closes as completed on success", () => {
    const h = setup()
    h.journal.handleEvent({ type: "session.execution.started", data: { sessionID: "ses_1" } })
    h.journal.handleEvent({ type: "session.execution.succeeded", data: { sessionID: "ses_1" } })
    expect(h.journal.get("ses_1")?.state).toBe("completed")
  })

  it("records a failed turn with the upstream reason", () => {
    const h = setup()
    h.journal.handleEvent({ type: "session.execution.started", data: { sessionID: "ses_1" } })
    h.journal.handleEvent({
      type: "session.execution.failed",
      data: { sessionID: "ses_1", error: { message: "provider exploded" } },
    })
    expect(h.journal.get("ses_1")).toMatchObject({ state: "failed", reason: "provider exploded" })
  })

  it("treats a user abort as cancelled (never auto-continued)", () => {
    const h = setup()
    h.journal.handleEvent({ type: "session.execution.started", data: { sessionID: "ses_1" } })
    h.journal.handleEvent({ type: "session.execution.interrupted", data: { sessionID: "ses_1" } })
    expect(h.journal.get("ses_1")?.state).toBe("cancelled")
    expect(h.journal.list(["interrupted"])).toHaveLength(0)
  })

  it("does not close on idle (a missing terminal event is the crash signal)", () => {
    const h = setup()
    h.journal.handleEvent({ type: "session.execution.started", data: { sessionID: "ses_1" } })
    h.advance(200)
    h.journal.handleEvent({ type: "session.idle", data: { sessionID: "ses_1" } })
    expect(h.journal.get("ses_1")).toMatchObject({ state: "running", lastEventAt: 1_200 })
  })

  it("removes the row when the session is deleted", () => {
    const h = setup()
    h.journal.handleEvent({ type: "session.execution.started", data: { sessionID: "ses_1" } })
    h.journal.handleEvent({ type: "session.deleted", data: { sessionID: "ses_1" } })
    expect(h.journal.get("ses_1")).toBeNull()
  })

  it("closes an open row as interrupted and announces it", () => {
    const h = setup()
    h.journal.handleEvent({ type: "session.execution.started", data: { sessionID: "ses_1" } })
    h.journal.close("ses_1", "interrupted", "the engine restarted")
    expect(h.journal.get("ses_1")).toMatchObject({ state: "interrupted", reason: "the engine restarted" })
    expect(h.events).toContainEqual({
      type: "turn.interrupted",
      data: { sessionID: "ses_1", state: "interrupted", reason: "the engine restarted" },
    })
  })

  it("marks a continuation and spends the attempt on a definite failure", () => {
    const h = setup()
    h.journal.handleEvent({ type: "session.execution.started", data: { sessionID: "ses_1" } })
    h.journal.close("ses_1", "interrupted", "engine")
    h.journal.markResumed("ses_1", true)
    expect(h.journal.get("ses_1")).toMatchObject({ state: "resumed", resumeAttempts: 1, lastResumeAt: 1_000 })

    h.journal.handleEvent({ type: "session.execution.started", data: { sessionID: "ses_1" } })
    h.journal.close("ses_1", "interrupted", "engine again")
    h.journal.markResumeFailed("ses_1", "did not land")
    expect(h.journal.get("ses_1")).toMatchObject({
      state: "interrupted",
      resumeAttempts: 2,
      reason: "did not land",
    })
  })

  it("preserves the continuation budget across the continuation's started event", () => {
    const h = setup()
    h.journal.handleEvent({ type: "session.execution.started", data: { sessionID: "ses_1" } })
    h.journal.close("ses_1", "interrupted", "engine")
    h.journal.markResumed("ses_1", true)
    h.journal.handleEvent({ type: "session.execution.started", data: { sessionID: "ses_1" } })
    expect(h.journal.get("ses_1")).toMatchObject({ state: "running", resumeAttempts: 1, lastResumeAt: 1_000 })
    // A resumed turn that finishes is terminal, not stuck as `resumed`.
    h.journal.handleEvent({ type: "session.execution.succeeded", data: { sessionID: "ses_1" } })
    expect(h.journal.get("ses_1")?.state).toBe("completed")
  })

  it("marks an ambiguous continuation so it is never retried blind", () => {
    const h = setup()
    h.journal.handleEvent({ type: "session.execution.started", data: { sessionID: "ses_1" } })
    h.journal.close("ses_1", "interrupted", "engine")
    h.journal.markAmbiguous("ses_1", "unknown")
    expect(h.journal.get("ses_1")?.state).toBe("ambiguous")
    expect(h.journal.list(["ambiguous"])).toHaveLength(1)
  })

  it("prunes terminal rows after the TTL and stale open rows after the longer TTL", () => {
    const h = setup()
    h.journal.handleEvent({ type: "session.execution.started", data: { sessionID: "ses_open" } })
    h.journal.handleEvent({ type: "session.execution.started", data: { sessionID: "ses_done" } })
    h.journal.handleEvent({ type: "session.execution.succeeded", data: { sessionID: "ses_done" } })
    // 25 h later: the terminal row is gone, the open one is still recent.
    h.setClock(1_000 + 25 * 60 * 60 * 1000)
    h.journal.prune()
    expect(h.journal.get("ses_done")).toBeNull()
    expect(h.journal.get("ses_open")).not.toBeNull()
    // 8 days after the open turn: it is stale too.
    h.setClock(1_000 + 8 * 24 * 60 * 60 * 1000)
    h.journal.prune()
    expect(h.journal.get("ses_open")).toBeNull()
  })

  it("exposes the continuation marker key", () => {
    expect(TURN_RESUME_MARKER_KEY).toBe("masterhand.resume")
  })

  it("extracts a reason from a typed error, a string error or no error", () => {
    const h = setup()
    h.journal.handleEvent({ type: "session.execution.started", data: { sessionID: "ses_type" } })
    h.journal.handleEvent({
      type: "session.execution.failed",
      data: { sessionID: "ses_type", error: { type: "ProviderError" } },
    })
    expect(h.journal.get("ses_type")?.reason).toBe("ProviderError")

    h.journal.handleEvent({ type: "session.execution.started", data: { sessionID: "ses_string" } })
    h.journal.handleEvent({ type: "session.execution.failed", data: { sessionID: "ses_string", error: "boom" } })
    expect(h.journal.get("ses_string")?.reason).toBe("boom")

    h.journal.handleEvent({ type: "session.execution.started", data: { sessionID: "ses_none" } })
    h.journal.handleEvent({ type: "session.execution.failed", data: { sessionID: "ses_none" } })
    expect(h.journal.get("ses_none")?.reason).toBe("the agent turn failed")
  })

  it("does not overwrite a completed turn and ignores marks for missing rows", () => {
    const h = setup()
    h.journal.handleEvent({ type: "session.execution.started", data: { sessionID: "ses_done" } })
    h.journal.handleEvent({ type: "session.execution.succeeded", data: { sessionID: "ses_done" } })
    h.journal.close("ses_done", "interrupted", "late")
    expect(h.journal.get("ses_done")?.state).toBe("completed")

    h.journal.markResumed("missing", true)
    h.journal.markAmbiguous("missing", "x")
    h.journal.markResumeFailed("missing", "x")
    expect(h.journal.get("missing")).toBeNull()
  })

  it("lists every row when no state filter is given", () => {
    const h = setup()
    h.journal.handleEvent({ type: "session.execution.started", data: { sessionID: "ses_1" } })
    h.journal.handleEvent({ type: "session.execution.started", data: { sessionID: "ses_2" } })
    h.journal.handleEvent({ type: "session.execution.succeeded", data: { sessionID: "ses_2" } })
    expect(h.journal.list().map((turn) => turn.sessionID).sort()).toEqual(["ses_1", "ses_2"])
    h.journal.stop()
  })
})
