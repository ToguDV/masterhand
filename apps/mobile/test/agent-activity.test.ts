import { decideAgentActivity } from "../src/agent-activity"

function session(overrides = {}) {
  return {
    id: "ses_1",
    title: "My session",
    parentID: null,
    fork: null,
    goalRole: undefined,
    ...overrides,
  }
}

describe("decideAgentActivity", () => {
  it("notifies finished when a busy session goes idle in background", () => {
    const result = decideAgentActivity(
      { type: "session.idle", data: { sessionID: "ses_1" } },
      { isAppActive: false, wasBusy: true, session: session() },
    )
    expect(result).toEqual(
      expect.objectContaining({ kind: "finished", sessionID: "ses_1" }),
    )
  })

  it("stays silent when the app is active", () => {
    const result = decideAgentActivity(
      { type: "session.idle", data: { sessionID: "ses_1" } },
      { isAppActive: true, wasBusy: true, session: session() },
    )
    expect(result).toBeNull()
  })

  it("stays silent for idle events of already-idle sessions", () => {
    const result = decideAgentActivity(
      { type: "session.idle", data: { sessionID: "ses_1" } },
      { isAppActive: false, wasBusy: false, session: session() },
    )
    expect(result).toBeNull()
  })

  it("ignores internal critic/judge and fork sessions", () => {
    expect(
      decideAgentActivity(
        { type: "session.idle", data: { sessionID: "ses_1" } },
        { isAppActive: false, wasBusy: true, session: session({ goalRole: "critic" }) },
      ),
    ).toBeNull()
    expect(
      decideAgentActivity(
        { type: "session.idle", data: { sessionID: "ses_1" } },
        { isAppActive: false, wasBusy: true, session: session({ parentID: "ses_parent" }) },
      ),
    ).toBeNull()
  })

  it("notifies failed in background", () => {
    const result = decideAgentActivity(
      { type: "session.execution.failed", data: { sessionID: "ses_1" } },
      { isAppActive: false, wasBusy: true, session: session() },
    )
    expect(result).toEqual(
      expect.objectContaining({ kind: "failed", sessionID: "ses_1" }),
    )
  })

  it("never notifies for user-interrupted turns", () => {
    const result = decideAgentActivity(
      { type: "session.execution.interrupted", data: { sessionID: "ses_1" } },
      { isAppActive: false, wasBusy: true, session: session() },
    )
    expect(result).toBeNull()
  })

  it("notifies permission requests once", () => {
    const first = decideAgentActivity(
      { type: "permission.asked", data: { id: "perm_1", sessionID: "ses_1" } },
      { isAppActive: false, wasBusy: false, session: session(), alreadyNotified: false },
    )
    expect(first).toEqual(
      expect.objectContaining({ kind: "permission", sessionID: "ses_1" }),
    )
    const second = decideAgentActivity(
      { type: "permission.asked", data: { id: "perm_1", sessionID: "ses_1" } },
      { isAppActive: false, wasBusy: false, session: session(), alreadyNotified: true },
    )
    expect(second).toBeNull()
  })

  it("notifies question forms but ignores other form kinds", () => {
    expect(
      decideAgentActivity(
        {
          type: "form.created",
          data: { form: { id: "frm_1", sessionID: "ses_1", metadata: { kind: "question" } } },
        },
        { isAppActive: false, wasBusy: false, session: session() },
      ),
    ).toEqual(expect.objectContaining({ kind: "question", formID: "frm_1" }))
    expect(
      decideAgentActivity(
        {
          type: "form.created",
          data: { form: { id: "frm_2", sessionID: "ses_1", metadata: { kind: "websearch.provider" } } },
        },
        { isAppActive: false, wasBusy: false, session: session() },
      ),
    ).toBeNull()
    expect(
      decideAgentActivity(
        {
          type: "form.created",
          data: { form: { id: "frm_1", sessionID: "ses_1" } },
        },
        { isAppActive: false, wasBusy: false, session: session(), alreadyNotified: true },
      ),
    ).toBeNull()
  })

  it("handles missing ids, unknown types and title fallbacks", () => {
    expect(
      decideAgentActivity({ type: "session.idle", data: {} }, { isAppActive: false, wasBusy: true, session: null }),
    ).toBeNull()
    expect(
      decideAgentActivity(
        { type: "something.else", data: { sessionID: "ses_1" } },
        { isAppActive: false, wasBusy: true, session: session() },
      ),
    ).toBeNull()
    expect(
      decideAgentActivity(
        { type: "session.execution.succeeded", data: { sessionID: "ses_1" } },
        { isAppActive: false, wasBusy: true, session: { id: "ses_1", title: "  " } },
      ),
    ).toEqual(expect.objectContaining({ kind: "finished", title: "ses_1" }))
    expect(
      decideAgentActivity(
        { type: "session.execution.succeeded", data: { sessionID: "ses_1" } },
        { isAppActive: false, wasBusy: true, session: { id: "ses_1" } },
      ),
    ).toEqual(expect.objectContaining({ title: "ses_1" }))
    // Session id can come from the context when the event carries none.
    expect(
      decideAgentActivity(
        { type: "permission.asked", data: { id: "perm_9" } },
        { isAppActive: false, wasBusy: false, session: session() },
      ),
    ).toEqual(expect.objectContaining({ sessionID: "ses_1", permissionID: "perm_9" }))
    // Fork sessions are internal too.
    expect(
      decideAgentActivity(
        { type: "session.idle", data: { sessionID: "ses_1" } },
        { isAppActive: false, wasBusy: true, session: session({ fork: { id: "f" } }) },
      ),
    ).toBeNull()
  })

  it("accepts requestID permission ids and id-less permissions", () => {
    expect(
      decideAgentActivity(
        { type: "permission.asked", data: { requestID: "req_1", sessionID: "ses_1" } },
        { isAppActive: false, wasBusy: false, session: session() },
      ),
    ).toEqual(expect.objectContaining({ kind: "permission", permissionID: "req_1" }))
    expect(
      decideAgentActivity(
        { type: "permission.asked", data: { sessionID: "ses_1" } },
        { isAppActive: false, wasBusy: false, session: session() },
      ),
    ).toEqual(expect.objectContaining({ kind: "permission", sessionID: "ses_1" }))
  })
})
