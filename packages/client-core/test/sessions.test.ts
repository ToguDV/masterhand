import { describe, expect, it } from "vitest"
import {
  CREATE_MARKER_KEY,
  createSessionMarker,
  filterSessions,
  finishResultFromIsolation,
  rootSessions,
  sessionCreateMarker,
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
