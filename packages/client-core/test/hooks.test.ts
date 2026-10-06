import { describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { toChatMessage } from "../src/chat"
import { createEventHandler, invalidateOnReconnect, mergeStatuses, queryKeys, transitionPollInterval } from "../src/hooks"
import type { ChatMessage, ChatPart, ChatToolPart, Permission, SessionStatuses, TokenUsageInfo } from "../src/types"

const SESSION = "ses_1"

function message(id = "msg_1", sessionID = SESSION): ChatMessage {
  return { info: { id, sessionID, role: "assistant", time: { created: 1 } }, parts: [] }
}

function textPart(id: string, text: string, messageID = "msg_1"): ChatPart {
  return { id, sessionID: SESSION, messageID, type: "text", text }
}

function toolPart(id: string, state: ChatToolPart["state"], tool = "bash"): ChatToolPart {
  return { id, sessionID: SESSION, messageID: "msg_1", type: "tool", tool, callID: id, state }
}

function tokens(output: number): TokenUsageInfo {
  return { input: 0, output, reasoning: 0, cache: { read: 0, write: 0 } }
}

function makeQueryClient(): { qc: QueryClient; invalidate: ReturnType<typeof vi.spyOn> } {
  const qc = new QueryClient()
  const invalidate = vi.spyOn(qc, "invalidateQueries")
  return { qc, invalidate }
}

function cachedParts(qc: QueryClient, sessionID = SESSION): ChatPart[] {
  return qc.getQueryData<ChatMessage[]>(queryKeys.messages(sessionID))?.[0]?.parts ?? []
}

function emit(handler: (event: unknown) => void, type: string, data: unknown): void {
  handler({ type, data })
}

describe("queryKeys", () => {
  it("scopes message keys by session", () => {
    expect(queryKeys.messages("ses_1")).toEqual(["messages", "ses_1"])
    expect(queryKeys.sessions).toEqual(["sessions"])
    expect(queryKeys.statuses).toEqual(["statuses"])
  })

  it("scopes session keys by workspace and directory keys", () => {
    expect(queryKeys.sessionsFor("ws_1")).toEqual(["sessions", "ws_1"])
    expect(queryKeys.sessionsFor()).toEqual(["sessions", null])
    expect(queryKeys.sessionsFor(null)).toEqual(["sessions", null])
    expect(queryKeys.directories("ws_1")).toEqual(["directories", "ws_1"])
    expect(queryKeys.directories()).toEqual(["directories", null])
    expect(queryKeys.commands("/app")).toEqual(["commands", "/app"])
    expect(queryKeys.commands()).toEqual(["commands", null])
    expect(queryKeys.preview("ses_1")).toEqual(["preview", "ses_1"])
    expect(queryKeys.branches("ws_1")).toEqual(["branches", "ws_1"])
    expect(queryKeys.branches()).toEqual(["branches", null])
  })
})

describe("createEventHandler", () => {
  it("invalidates the session list on session lifecycle events", () => {
    const { qc, invalidate } = makeQueryClient()
    const handler = createEventHandler(qc)
    for (const type of [
      "session.created",
      "session.renamed",
      "session.metadata.updated",
      "session.deleted",
      "session.agent.selected",
      "session.model.selected",
      "session.permissions",
    ]) {
      emit(handler, type, { sessionID: SESSION })
    }
    expect(invalidate).toHaveBeenCalledTimes(7)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.sessions })
  })

  it("recovers missed state when opencode (re)connects", () => {
    const { qc, invalidate } = makeQueryClient()
    const onServerConnected = vi.fn()
    const handler = createEventHandler(qc, { onServerConnected })
    emit(handler, "server.connected", {})
    expect(onServerConnected).toHaveBeenCalledTimes(1)
    expect(invalidate).toHaveBeenCalledTimes(7)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.sessions })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["messages"] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.statuses })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["directories"] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.agents })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.models })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["commands"] })
  })

  it("refreshes the health status when the BFF hub connection changes", () => {
    const { qc, invalidate } = makeQueryClient()
    const handler = createEventHandler(qc)
    emit(handler, "hub.disconnected", { connected: false })
    emit(handler, "hub.connected", { connected: true })
    expect(invalidate).toHaveBeenCalledTimes(2)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.status })
  })

  it("coalesces catalog refreshes when opencode hot-reloads them", () => {
    vi.useFakeTimers()
    try {
      const { qc, invalidate } = makeQueryClient()
      const handler = createEventHandler(qc)
      for (const type of ["agent.updated", "model.updated", "provider.updated", "command.updated", "config.updated", "models-dev.refreshed"]) {
        emit(handler, type, {})
      }
      expect(invalidate).not.toHaveBeenCalled()
      vi.advanceTimersByTime(250)
      expect(invalidate).toHaveBeenCalledTimes(3)
      expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.agents })
      expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.models })
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["commands"] })
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(["agent.updated", "model.updated", "provider.updated", "command.updated", "config.updated", "models-dev.refreshed"])(
    "refreshes the catalogs once per %s event",
    (type) => {
      vi.useFakeTimers()
      try {
        const { qc, invalidate } = makeQueryClient()
        const handler = createEventHandler(qc)
        emit(handler, type, {})
        vi.advanceTimersByTime(250)
        expect(invalidate).toHaveBeenCalledTimes(3)
        expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.agents })
        expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.models })
        expect(invalidate).toHaveBeenCalledWith({ queryKey: ["commands"] })
      } finally {
        vi.useRealTimers()
      }
    },
  )

  it("restarts the catalog window so a burst spanning it still refetches once", () => {
    vi.useFakeTimers()
    try {
      const { qc, invalidate } = makeQueryClient()
      const handler = createEventHandler(qc)
      emit(handler, "agent.updated", {})
      vi.advanceTimersByTime(200)
      emit(handler, "provider.updated", {})
      vi.advanceTimersByTime(200)
      // A throttle would have fired at t=250; the debounce waits 250 ms after
      // the last event of the burst.
      expect(invalidate).not.toHaveBeenCalled()
      vi.advanceTimersByTime(50)
      expect(invalidate).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it("caches session.status updates, tolerating an empty cache", () => {
    const { qc } = makeQueryClient()
    const handler = createEventHandler(qc)
    emit(handler, "session.status", { sessionID: SESSION, status: { type: "busy" } })
    expect(qc.getQueryData(queryKeys.statuses)).toEqual({ [SESSION]: { type: "busy" } })

    emit(handler, "session.status", { sessionID: "ses_2", status: { type: "idle" } })
    expect(qc.getQueryData(queryKeys.statuses)).toEqual({
      [SESSION]: { type: "busy" },
      ses_2: { type: "idle" },
    })
  })

  it("marks a session idle and refreshes its messages", () => {
    const { qc, invalidate } = makeQueryClient()
    qc.setQueryData(queryKeys.statuses, { [SESSION]: { type: "busy" } })
    const handler = createEventHandler(qc)

    emit(handler, "session.idle", { sessionID: SESSION })
    expect(qc.getQueryData(queryKeys.statuses)).toEqual({ [SESSION]: { type: "idle" } })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.messages(SESSION) })
  })

  it("marks a session busy when execution starts and refreshes its messages", () => {
    const { qc, invalidate } = makeQueryClient()
    const handler = createEventHandler(qc)

    emit(handler, "session.execution.started", { sessionID: SESSION })
    expect(qc.getQueryData(queryKeys.statuses)).toEqual({ [SESSION]: { type: "busy" } })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.messages(SESSION) })
  })

  it("marks a session idle when execution succeeds or is interrupted", () => {
    for (const type of ["session.execution.succeeded", "session.execution.interrupted"]) {
      const { qc, invalidate } = makeQueryClient()
      qc.setQueryData(queryKeys.statuses, { [SESSION]: { type: "busy" } })
      const handler = createEventHandler(qc)

      emit(handler, type, { sessionID: SESSION })
      expect(qc.getQueryData(queryKeys.statuses)).toEqual({ [SESSION]: { type: "idle" } })
      expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.messages(SESSION) })
    }
  })

  it("reports execution failures with a concise message", () => {
    const { qc, invalidate } = makeQueryClient()
    const onSessionError = vi.fn()
    const handler = createEventHandler(qc, { onSessionError })

    emit(handler, "session.execution.failed", {
      sessionID: SESSION,
      error: { type: "ProviderError", message: "boom\nstack trace" },
    })
    expect(onSessionError).toHaveBeenCalledWith("boom")
    expect(qc.getQueryData(queryKeys.statuses)).toEqual({ [SESSION]: { type: "idle" } })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.messages(SESSION) })
  })

  it("ignores aborted executions and tolerates missing callbacks", () => {
    const { qc } = makeQueryClient()
    const onSessionError = vi.fn()
    const handler = createEventHandler(qc, { onSessionError })

    emit(handler, "session.execution.failed", {
      sessionID: SESSION,
      error: { type: "MessageAbortedError", message: "aborted" },
    })
    expect(onSessionError).not.toHaveBeenCalled()

    const bare = createEventHandler(qc)
    expect(() =>
      emit(bare, "session.execution.failed", { sessionID: SESSION, error: { type: "X", message: "x" } }),
    ).not.toThrow()
  })

  it("caches retry schedules", () => {
    const { qc } = makeQueryClient()
    const handler = createEventHandler(qc)
    emit(handler, "session.retry.scheduled", {
      sessionID: SESSION,
      attempt: 2,
      at: 1234,
      error: { type: "ProviderError", message: "overloaded" },
    })
    expect(qc.getQueryData(queryKeys.statuses)).toEqual({
      [SESSION]: { type: "retry", attempt: 2, message: "overloaded", next: 1234 },
    })
  })

  it("dispatches permission callbacks", () => {
    const { qc } = makeQueryClient()
    const onPermission = vi.fn()
    const onPermissionReplied = vi.fn()
    const handler = createEventHandler(qc, { onPermission, onPermissionReplied })

    const permission = {
      id: "per_1",
      sessionID: SESSION,
      action: "bash",
      resources: ["ls"],
    } as Permission
    emit(handler, "permission.asked", permission)
    expect(onPermission).toHaveBeenCalledWith(permission)

    emit(handler, "permission.replied", { sessionID: SESSION, requestID: "per_1", reply: "once" })
    expect(onPermissionReplied).toHaveBeenCalledWith("per_1")
  })

  it("dispatches form callbacks", () => {
    const { qc } = makeQueryClient()
    const onForm = vi.fn()
    const onFormSettled = vi.fn()
    const handler = createEventHandler(qc, { onForm, onFormSettled })

    const form = { id: "frm_1", sessionID: SESSION, title: "Questions", fields: [{ key: "a", type: "string" }] }
    emit(handler, "form.created", { form })
    expect(onForm).toHaveBeenCalledWith(form)

    emit(handler, "form.replied", { id: "frm_1", sessionID: SESSION, answer: { a: "x" } })
    expect(onFormSettled).toHaveBeenCalledWith("frm_1")

    emit(handler, "form.cancelled", { id: "frm_2", sessionID: SESSION })
    expect(onFormSettled).toHaveBeenCalledWith("frm_2")
  })

  it("works without callbacks", () => {
    const { qc } = makeQueryClient()
    const handler = createEventHandler(qc)
    expect(() => emit(handler, "permission.asked", {})).not.toThrow()
    expect(() => emit(handler, "permission.replied", {})).not.toThrow()
    expect(() => emit(handler, "form.created", {})).not.toThrow()
    expect(() => emit(handler, "form.replied", {})).not.toThrow()
    expect(() => emit(handler, "form.cancelled", {})).not.toThrow()
  })

  it("appends streamed text deltas only when the session is cached", () => {
    const { qc } = makeQueryClient()
    const handler = createEventHandler(qc)

    emit(handler, "session.text.delta", {
      sessionID: SESSION,
      assistantMessageID: "msg_1",
      ordinal: 0,
      delta: "ignored",
    })
    expect(qc.getQueryData(queryKeys.messages(SESSION))).toBeUndefined()

    qc.setQueryData(queryKeys.messages(SESSION), [message()])
    emit(handler, "session.text.delta", { sessionID: SESSION, assistantMessageID: "msg_1", ordinal: 0, delta: "hel" })
    emit(handler, "session.text.delta", { sessionID: SESSION, assistantMessageID: "msg_1", ordinal: 0, delta: "lo" })
    expect(cachedParts(qc)).toEqual([
      { id: "msg_1:text:0", sessionID: SESSION, messageID: "msg_1", type: "text", text: "hello" },
    ])
  })

  it("merges deltas into a projected history snapshot fetched mid-stream", () => {
    const { qc } = makeQueryClient()
    const handler = createEventHandler(qc)
    const projected = toChatMessage(
      {
        type: "assistant",
        id: "msg_1",
        time: { created: 1 },
        agent: "build",
        model: { id: "test-model", providerID: "test" },
        content: [
          { type: "text", text: "Working" },
          { type: "reasoning", text: "thinking" },
        ],
      },
      SESSION,
    )
    qc.setQueryData(queryKeys.messages(SESSION), [projected!])

    emit(handler, "session.text.delta", { sessionID: SESSION, assistantMessageID: "msg_1", ordinal: 0, delta: "…" })

    const parts = cachedParts(qc)
    expect(parts.filter((part) => part.type === "text")).toEqual([
      { id: "msg_1:text:0", sessionID: SESSION, messageID: "msg_1", type: "text", text: "Working…" },
    ])
  })

  it("appends reasoning deltas and finalizes streamed text", () => {
    const { qc } = makeQueryClient()
    qc.setQueryData(queryKeys.messages(SESSION), [message()])
    const handler = createEventHandler(qc)

    emit(handler, "session.reasoning.delta", {
      sessionID: SESSION,
      assistantMessageID: "msg_1",
      ordinal: 1,
      delta: "why",
    })
    expect(cachedParts(qc)[0]).toMatchObject({ id: "msg_1:reasoning:1", type: "reasoning", text: "why" })

    emit(handler, "session.text.ended", {
      sessionID: SESSION,
      assistantMessageID: "msg_1",
      ordinal: 0,
      text: "final text",
    })
    expect(cachedParts(qc)).toContainEqual({
      id: "msg_1:text:0",
      sessionID: SESSION,
      messageID: "msg_1",
      type: "text",
      text: "final text",
    })

    emit(handler, "session.reasoning.ended", {
      sessionID: SESSION,
      assistantMessageID: "msg_1",
      ordinal: 1,
      text: "final reasoning",
    })
    expect(cachedParts(qc)).toContainEqual({
      id: "msg_1:reasoning:1",
      sessionID: SESSION,
      messageID: "msg_1",
      type: "reasoning",
      text: "final reasoning",
    })
  })

  it("stores step cost and tokens and marks the message completed", () => {
    const { qc } = makeQueryClient()
    qc.setQueryData(queryKeys.messages(SESSION), [message()])
    const handler = createEventHandler(qc)

    emit(handler, "session.step.ended", {
      sessionID: SESSION,
      assistantMessageID: "msg_1",
      finish: "stop",
      cost: 0.5,
      tokens: tokens(12),
    })

    const entry = qc.getQueryData<ChatMessage[]>(queryKeys.messages(SESSION))?.[0]
    expect(entry?.info.cost).toBe(0.5)
    expect(entry?.info.tokens).toEqual(tokens(12))
    expect(entry?.info.time.completed).toBeTypeOf("number")
  })

  it("tracks the tool input lifecycle", () => {
    const { qc } = makeQueryClient()
    qc.setQueryData(queryKeys.messages(SESSION), [message()])
    const handler = createEventHandler(qc)

    emit(handler, "session.tool.input.started", {
      sessionID: SESSION,
      assistantMessageID: "msg_1",
      id: "call_1",
      name: "bash",
    })
    expect(cachedParts(qc)[0]).toMatchObject({
      type: "tool",
      tool: "bash",
      callID: "call_1",
      state: { status: "pending", input: {}, raw: "" },
    })

    emit(handler, "session.tool.input.delta", {
      sessionID: SESSION,
      assistantMessageID: "msg_1",
      id: "call_1",
      delta: '{"command"',
    })
    emit(handler, "session.tool.input.delta", {
      sessionID: SESSION,
      assistantMessageID: "msg_1",
      id: "call_1",
      delta: ':"ls"}',
    })
    expect((cachedParts(qc)[0] as ChatToolPart).state.raw).toBe('{"command":"ls"}')

    emit(handler, "session.tool.input.ended", {
      sessionID: SESSION,
      assistantMessageID: "msg_1",
      id: "call_1",
      text: '{"command":"ls"}',
    })
    expect((cachedParts(qc)[0] as ChatToolPart).state).toEqual({
      status: "running",
      input: { command: "ls" },
      raw: undefined,
    })
  })

  it("creates missing tool parts from delta and ended events", () => {
    const { qc } = makeQueryClient()
    qc.setQueryData(queryKeys.messages(SESSION), [message()])
    const handler = createEventHandler(qc)

    emit(handler, "session.tool.input.delta", {
      sessionID: SESSION,
      assistantMessageID: "msg_1",
      id: "call_missing",
      delta: "partial",
    })
    expect((cachedParts(qc)[0] as ChatToolPart).state).toMatchObject({ status: "pending", raw: "partial" })

    emit(handler, "session.tool.input.ended", {
      sessionID: SESSION,
      assistantMessageID: "msg_1",
      id: "call_bad",
      text: "not-json",
    })
    const bad = cachedParts(qc).find((part) => part.type === "tool" && part.callID === "call_bad") as ChatToolPart
    expect(bad.state).toEqual({ status: "running", input: {} })
  })

  it("normalizes non-object tool input payloads", () => {
    const { qc } = makeQueryClient()
    qc.setQueryData(queryKeys.messages(SESSION), [message()])
    const handler = createEventHandler(qc)

    for (const [id, text] of [
      ["call_array", "[]"],
      ["call_string", '"text"'],
      ["call_missing", undefined],
    ] as const) {
      emit(handler, "session.tool.input.ended", {
        sessionID: SESSION,
        assistantMessageID: "msg_1",
        id,
        text,
      })
    }

    for (const id of ["call_array", "call_string", "call_missing"]) {
      const part = cachedParts(qc).find((entry) => entry.type === "tool" && entry.callID === id) as ChatToolPart
      expect(part.state.input).toEqual({})
    }
  })

  it("tracks tool calls, progress, success and failure", () => {
    const { qc } = makeQueryClient()
    qc.setQueryData(queryKeys.messages(SESSION), [message()])
    const handler = createEventHandler(qc)

    emit(handler, "session.tool.called", {
      sessionID: SESSION,
      assistantMessageID: "msg_1",
      id: "call_1",
      input: { command: "ls" },
      executed: true,
    })
    expect((cachedParts(qc)[0] as ChatToolPart).state).toMatchObject({
      status: "running",
      input: { command: "ls" },
    })
    expect((cachedParts(qc)[0] as ChatToolPart).state.timing?.ran).toBeTypeOf("number")

    emit(handler, "session.tool.called", {
      sessionID: SESSION,
      assistantMessageID: "msg_1",
      id: "call_1",
      input: { command: "pwd" },
      executed: true,
    })
    expect((cachedParts(qc)[0] as ChatToolPart).state.input).toEqual({ command: "pwd" })

    emit(handler, "session.tool.progress", {
      sessionID: SESSION,
      assistantMessageID: "msg_1",
      id: "call_1",
      metadata: { progress: 50 },
    })
    expect((cachedParts(qc)[0] as ChatToolPart).state.metadata).toEqual({ progress: 50 })

    emit(handler, "session.tool.progress", {
      sessionID: SESSION,
      assistantMessageID: "msg_1",
      id: "call_untracked",
      metadata: { progress: 10 },
    })
    const untracked = cachedParts(qc).find((part) => part.type === "tool" && part.callID === "call_untracked") as ChatToolPart
    expect(untracked.state).toEqual({ status: "pending", input: {}, metadata: { progress: 10 } })

    emit(handler, "session.tool.success", {
      sessionID: SESSION,
      assistantMessageID: "msg_1",
      id: "call_1",
      content: [{ type: "text", text: "done" }],
      metadata: { title: "Done" },
      executed: true,
    })
    const completed = (cachedParts(qc)[0] as ChatToolPart).state
    expect(completed).toMatchObject({
      status: "completed",
      input: { command: "pwd" },
      output: "done",
      metadata: { title: "Done" },
    })
    expect(completed.timing?.created).toBeTypeOf("number")
    expect(completed.timing?.completed).toBeTypeOf("number")

    emit(handler, "session.tool.failed", {
      sessionID: SESSION,
      assistantMessageID: "msg_1",
      id: "call_1",
      error: { type: "ToolError", message: "kaboom" },
      content: [{ type: "text", text: "stderr" }],
      metadata: { title: "Failed" },
      executed: true,
    })
    expect((cachedParts(qc)[0] as ChatToolPart).state).toMatchObject({
      status: "error",
      input: { command: "pwd" },
      error: "kaboom",
      output: "stderr",
      metadata: { title: "Failed" },
    })
  })

  it("renders file tool content and creates missing parts on completion", () => {
    const { qc } = makeQueryClient()
    qc.setQueryData(queryKeys.messages(SESSION), [message()])
    const handler = createEventHandler(qc)

    emit(handler, "session.tool.success", {
      sessionID: SESSION,
      assistantMessageID: "msg_1",
      id: "call_file",
      content: [{ type: "file", uri: "file://x", mime: "text/plain", name: "x.ts" }],
      executed: true,
    })
    const file = cachedParts(qc).find((part) => part.type === "tool" && part.callID === "call_file") as ChatToolPart
    expect(file.tool).toBe("call_file")
    expect(file.state.output).toBe("[x.ts] file://x")

    emit(handler, "session.tool.success", {
      sessionID: SESSION,
      assistantMessageID: "msg_1",
      id: "call_empty",
      content: undefined,
      executed: true,
    })
    const empty = cachedParts(qc).find((part) => part.type === "tool" && part.callID === "call_empty") as ChatToolPart
    expect(empty.state.output).toBeUndefined()

    emit(handler, "session.tool.failed", {
      sessionID: SESSION,
      assistantMessageID: "msg_1",
      id: "call_failed",
      error: { type: "ToolError", message: "nope" },
      content: [{ type: "file", uri: "file://y", mime: "text/plain" }],
      executed: true,
    })
    const failed = cachedParts(qc).find((part) => part.type === "tool" && part.callID === "call_failed") as ChatToolPart
    expect(failed.state).toMatchObject({
      status: "error",
      input: {},
      error: "nope",
      output: "[file://y] file://y",
      metadata: undefined,
    })
  })

  it("ignores unknown events and non-object payloads", () => {
    const { qc, invalidate } = makeQueryClient()
    const onPermission = vi.fn()
    const handler = createEventHandler(qc, { onPermission })

    handler(null)
    handler("nope")
    handler(undefined)
    emit(handler, "unknown.event", {})
    expect(invalidate).not.toHaveBeenCalled()
    expect(onPermission).not.toHaveBeenCalled()
  })
})

describe("mergeStatuses", () => {
  it("keeps a status set by an event that raced the poll", () => {
    const previous: SessionStatuses = { ses_1: { type: "busy" } }
    expect(mergeStatuses(previous, {}, new Map([["ses_1", 100]]), 100)).toEqual(previous)
  })

  it("drops stale statuses and applies the snapshot", () => {
    const previous: SessionStatuses = {
      ses_1: { type: "busy" },
      ses_2: { type: "retry", attempt: 2, message: "overloaded", next: 5 },
    }
    const snapshot: SessionStatuses = { ses_3: { type: "busy" } }
    expect(mergeStatuses(previous, snapshot, new Map([["ses_1", 99]]), 100)).toEqual(snapshot)
  })

  it("lets the snapshot win for a session it reports", () => {
    const previous: SessionStatuses = { ses_1: { type: "retry", attempt: 1, message: "x", next: 1 } }
    expect(mergeStatuses(previous, { ses_1: { type: "busy" } }, new Map([["ses_1", 200]]), 100)).toEqual({
      ses_1: { type: "busy" },
    })
  })
})

describe("invalidateOnReconnect", () => {
  it("refreshes sessions, messages, statuses, directories and catalogs", () => {
    const { qc, invalidate } = makeQueryClient()
    invalidateOnReconnect(qc)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.sessions })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["messages"] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.statuses })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["directories"] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.agents })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.models })
  })
})

describe("transitionPollInterval", () => {
  it("polls starting fast, stops at the timeout and polls running slowly", () => {
    expect(transitionPollInterval("starting", false)).toBe(1500)
    expect(transitionPollInterval("starting", true)).toBe(false)
    expect(transitionPollInterval("running", false)).toBe(5000)
    expect(transitionPollInterval("running", true)).toBe(5000)
    expect(transitionPollInterval("stopped", false)).toBe(false)
    expect(transitionPollInterval("error", false)).toBe(false)
    expect(transitionPollInterval(undefined, false)).toBe(false)
  })
})
