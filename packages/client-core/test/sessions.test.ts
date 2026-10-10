import { describe, expect, it } from "vitest"
import {
  CREATE_MARKER_KEY,
  createSessionMarker,
  filterSessions,
  finishResultFromIsolation,
  rootSessions,
  sessionCreateMarker,
  shouldAutoAccept,
} from "../src/sessions"
import type { Session } from "../src/types"

function session(id: string, isolation?: Session["isolation"]): Session {
  return { id, isolation } as Session
}

const isolated = session("ses_iso", {
  isolated: true,
  worktreePath: "/workspace/.worktrees/app/abc",
  branch: "masterhand/app-abc",
  baseRef: "main",
})

describe("session create markers", () => {
  it("creates unique, prefixed markers", () => {
    const first = createSessionMarker()
    const second = createSessionMarker()
    expect(first).toMatch(/^session_/)
    expect(first).not.toBe(second)
  })

  it("reads only the MasterHand marker from session metadata", () => {
    const withMarker = (metadata: Record<string, unknown>): Session =>
      ({ id: "ses_1", metadata } as unknown as Session)
    expect(sessionCreateMarker(withMarker({ [CREATE_MARKER_KEY]: "m1" }))).toBe("m1")
    expect(sessionCreateMarker(withMarker({ other: "x" }))).toBeNull()
    expect(sessionCreateMarker(withMarker({ [CREATE_MARKER_KEY]: 42 }))).toBeNull()
    expect(sessionCreateMarker({ id: "ses_4" } as unknown as Session)).toBeNull()
  })
})

describe("filterSessions", () => {
  const sessions = [session("ses_plain"), isolated]

  it("returns every session for the all filter", () => {
    expect(filterSessions(sessions, "all")).toHaveLength(2)
  })

  it("keeps only isolated or only standard sessions", () => {
    expect(filterSessions(sessions, "isolated").map((item) => item.id)).toEqual(["ses_iso"])
    expect(filterSessions(sessions, "standard").map((item) => item.id)).toEqual(["ses_plain"])
  })
})

describe("rootSessions", () => {
  it("hides subagent children from the list", () => {
    const parent = session("ses_parent")
    const child = { id: "ses_child", parentID: "ses_parent" } as Session
    expect(rootSessions([parent, child]).map((item) => item.id)).toEqual(["ses_parent"])
  })

  it("hides temporary /btw forks from the list", () => {
    const parent = session("ses_parent")
    const fork = {
      id: "ses_fork",
      fork: { sessionID: "ses_parent", boundary: { type: "through" as const, messageID: "msg_1" } },
    } as Session
    expect(rootSessions([parent, fork]).map((item) => item.id)).toEqual(["ses_parent"])
  })

  it("hides Goal Mode's internal critic/judge sessions", () => {
    const parent = session("ses_parent")
    // The pinned opencode drops `parentID` on create, so the BFF marks these
    // with a role instead: they must never render as top-level sessions.
    const critic = { id: "ses_critic", goalRole: "critic" } as Session
    const judge = { id: "ses_judge", goalRole: "judge" } as Session
    expect(rootSessions([parent, critic, judge]).map((item) => item.id)).toEqual(["ses_parent"])
  })
})

describe("shouldAutoAccept", () => {
  const parent = session("ses_parent")
  const child = { id: "ses_child", parentID: "ses_parent" } as Session
  const grandchild = { id: "ses_grandchild", parentID: "ses_child" } as Session
  const unrelated = session("ses_other")
  const sessions = [parent, child, grandchild, unrelated]

  it("honors the session's own setting", () => {
    expect(shouldAutoAccept("ses_parent", sessions, ["ses_parent"])).toBe(true)
    expect(shouldAutoAccept("ses_parent", sessions, [])).toBe(false)
  })

  it("inherits the setting from a subagent's ancestor", () => {
    expect(shouldAutoAccept("ses_child", sessions, ["ses_parent"])).toBe(true)
    expect(shouldAutoAccept("ses_grandchild", sessions, ["ses_parent"])).toBe(true)
    expect(shouldAutoAccept("ses_child", sessions, ["ses_other"])).toBe(false)
  })

  it("always forces Goal Mode critic/judge sessions", () => {
    const critic = { id: "ses_critic", goalRole: "critic" } as Session
    const judge = { id: "ses_judge", goalRole: "judge" } as Session
    expect(shouldAutoAccept("ses_critic", [critic, judge], [])).toBe(true)
    expect(shouldAutoAccept("ses_judge", [critic, judge], [])).toBe(true)
  })

  it("falls back to the direct list for a session the list has not caught up with", () => {
    expect(shouldAutoAccept("ses_unknown", [], ["ses_unknown"])).toBe(true)
    expect(shouldAutoAccept("ses_unknown", [], [])).toBe(false)
  })

  it("does not loop on a malformed parent cycle", () => {
    const a = { id: "ses_a", parentID: "ses_b" } as Session
    const b = { id: "ses_b", parentID: "ses_a" } as Session
    expect(shouldAutoAccept("ses_a", [a, b], ["ses_missing"])).toBe(false)
  })
})

describe("finishResultFromIsolation", () => {
  it("rebuilds the result once the record shows the push happened", () => {
    expect(
      finishResultFromIsolation({
        ...isolated.isolation!,
        pushed: true,
        prUrl: "https://github.com/acme/app/pull/1",
      }),
    ).toEqual({
      committed: true,
      pushed: true,
      prUrl: "https://github.com/acme/app/pull/1",
      branch: "masterhand/app-abc",
      path: "/workspace/.worktrees/app/abc",
      error: null,
    })
  })

  it("accepts a PR URL without a push flag and rejects records without evidence", () => {
    expect(finishResultFromIsolation({ ...isolated.isolation!, prUrl: "https://example.com/pr/1" })).toMatchObject({
      pushed: false,
      prUrl: "https://example.com/pr/1",
    })
    expect(finishResultFromIsolation(isolated.isolation)).toBeNull()
    expect(finishResultFromIsolation(undefined)).toBeNull()
    expect(finishResultFromIsolation(null)).toBeNull()
  })
})
