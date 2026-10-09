/**
 * @vitest-environment jsdom
 */
import { createElement, type ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Client } from "../src/client"
import type { ChatMessage, SessionStatuses } from "../src/types"
import {
  createEventHandler,
  queryKeys,
  useAgents,
  useAudit,
  useBffStatus,
  useBranches,
  useEventStream,
  useGoalRun,
  useGoalSettings,
  useMessages,
  useModels,
  usePreview,
  useSessionDirectories,
  useSessionRun,
  useSessions,
  useSessionStatuses,
  useWorkspaceRun,
  useWorkspaces,
} from "../src/hooks"

afterEach(cleanup)

function makeEventStream() {
  return { start: vi.fn(), stop: vi.fn(), forceReconnect: vi.fn(), connected: false }
}

function makeClient(stream = makeEventStream()) {
  const auth = { status: vi.fn(async () => ({ ok: true, opencode: { healthy: true } })) }
  const sessions = {
    list: vi.fn(async () => []),
    create: vi.fn(async () => ({ id: "ses_new" })),
    remove: vi.fn(async () => {}),
    finish: vi.fn(async () => ({ committed: true })),
    directories: vi.fn(async () => []),
  }
  const api = {
    sessions,
    statuses: vi.fn(async () => ({})),
    messages: vi.fn(async (): Promise<ChatMessage[]> => []),
    agents: vi.fn(async () => []),
    models: vi.fn(async () => ({ models: [], providers: [], defaultModel: null })),
    preview: vi.fn(async () => ({ status: "stopped", url: null, port: null, error: null })),
    audit: vi.fn(async () => []),
    run: vi.fn(async () => null),
    sessionRun: vi.fn(async () => ({ status: "stopped", command: null, args: [], port: null, pid: null, error: null })),
    branches: {
      list: vi.fn(async () => ({ current: "main", branches: ["main", "dev"] })),
      create: vi.fn(async () => ({ current: "dev", branches: ["main", "dev"] })),
      checkout: vi.fn(async () => ({ current: "dev", branches: ["main", "dev"] })),
    },
    goal: {
      start: vi.fn(async () => goalRun("running")),
      status: vi.fn(async () => goalRun("running")),
      pause: vi.fn(async () => goalRun("paused")),
      resume: vi.fn(async () => goalRun("running")),
      cancel: vi.fn(async () => goalRun("cancelled")),
      settings: vi.fn(async () => ({ maxRounds: 5, criticModel: null, judgeModel: null })),
      saveSettings: vi.fn(async () => ({ maxRounds: 5, criticModel: null, judgeModel: null })),
    },
  }
  const eventStream = vi.fn((_options: Parameters<Client["eventStream"]>[0]) => stream)
  const workspaces = { list: vi.fn(async () => []) }
  return {
    client: { baseUrl: "", auth, api, workspaces, eventStream } as unknown as Client,
    stream,
    auth,
    api,
    sessions,
    workspaces,
    eventStream,
  }
}

function newQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

function goalRun(state: string): Record<string, unknown> {
  return {
    sessionID: "ses_1",
    goal: "Make the suite green",
    state,
    round: 1,
    maxRounds: 5,
    history: [],
  }
}

function wrapper(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children)
}

describe("query hooks", () => {
  it("useBffStatus fetches the BFF status", async () => {
    const qc = newQueryClient()
    const { client, auth } = makeClient()
    const { result } = renderHook(() => useBffStatus(client, false), { wrapper: wrapper(qc) })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(auth.status).toHaveBeenCalledTimes(1)
    expect(result.current.data).toEqual({ ok: true, opencode: { healthy: true } })
  })

  it("useSessions only fetches when enabled and a workspace is selected", async () => {
    const qc = newQueryClient()
    const { client, sessions } = makeClient()

    const disabled = renderHook(() => useSessions(client, false, false, "ws_1"), { wrapper: wrapper(qc) })
    expect(disabled.result.current.fetchStatus).toBe("idle")
    expect(sessions.list).not.toHaveBeenCalled()

    const missingWorkspace = renderHook(() => useSessions(client, true, false, null), { wrapper: wrapper(qc) })
    expect(missingWorkspace.result.current.fetchStatus).toBe("idle")

    const enabled = renderHook(() => useSessions(client, true, false, "ws_1"), { wrapper: wrapper(qc) })
    await waitFor(() => expect(enabled.result.current.isSuccess).toBe(true))
    expect(sessions.list).toHaveBeenCalledTimes(1)
    expect(sessions.list).toHaveBeenCalledWith("ws_1")
  })

  it("useSessionStatuses adapts its polling to connectivity", async () => {
    const qc = newQueryClient()
    const { client, api } = makeClient()
    const { result } = renderHook(() => useSessionStatuses(client, true, true), { wrapper: wrapper(qc) })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(api.statuses).toHaveBeenCalledTimes(1)
  })

  it("useBranches only fetches for an enabled workspace", async () => {
    const qc = newQueryClient()
    const { client, api } = makeClient()

    const disabled = renderHook(() => useBranches(client, false, "ws_1"), { wrapper: wrapper(qc) })
    expect(disabled.result.current.fetchStatus).toBe("idle")
    expect(api.branches.list).not.toHaveBeenCalled()

    const enabled = renderHook(() => useBranches(client, true, "ws_1"), { wrapper: wrapper(qc) })
    await waitFor(() => expect(enabled.result.current.isSuccess).toBe(true))
    expect(api.branches.list).toHaveBeenCalledWith("ws_1")
    expect(enabled.result.current.data).toEqual({ current: "main", branches: ["main", "dev"] })
  })

  it("useSessionStatuses keeps a status set while the poll is in flight", async () => {
    const qc = newQueryClient()
    const { client, api } = makeClient()
    let resolveSnapshot!: (snapshot: SessionStatuses) => void
    api.statuses.mockReturnValue(
      new Promise<SessionStatuses>((resolve) => {
        resolveSnapshot = resolve
      }),
    )

    const { result } = renderHook(() => useSessionStatuses(client, true, true), { wrapper: wrapper(qc) })
    await waitFor(() => expect(api.statuses).toHaveBeenCalledTimes(1))

    // The event lands while the snapshot request is still pending.
    createEventHandler(qc)({ type: "session.execution.started", data: { sessionID: "ses_1" } })
    resolveSnapshot({})

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual({ ses_1: { type: "busy" } })
  })

  it("invalidates the audit log when a tool is denied", () => {
    const qc = newQueryClient()
    const invalidate = vi.spyOn(qc, "invalidateQueries")

    createEventHandler(qc)({
      type: "session.tool.failed",
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_1",
        id: "call_1",
        error: { type: "permission.rejected", message: "Permission denied: shell" },
        content: [],
      },
    })

    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.audit })
  })

  it("useSessionStatuses trusts the snapshot for statuses with no fresh event", async () => {
    const qc = newQueryClient()
    const { client, api } = makeClient()
    qc.setQueryData<SessionStatuses>(queryKeys.statuses, { ses_1: { type: "busy" } })

    const { result } = renderHook(() => useSessionStatuses(client, true, true), { wrapper: wrapper(qc) })
    await waitFor(() => expect(api.statuses).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(result.current.data).toEqual({}))
  })

  it("useMessages stays disabled without a session", async () => {
    const qc = newQueryClient()
    const { client, api } = makeClient()

    const disabled = renderHook(() => useMessages(client, null, { connected: true, busy: false }), {
      wrapper: wrapper(qc),
    })
    expect(disabled.result.current.fetchStatus).toBe("idle")
    expect(api.messages).not.toHaveBeenCalled()

    const enabled = renderHook(() => useMessages(client, "ses_1", { connected: false, busy: true }), {
      wrapper: wrapper(qc),
    })
    await waitFor(() => expect(enabled.result.current.isSuccess).toBe(true))
    expect(api.messages).toHaveBeenCalledWith("ses_1")
  })

  it("useMessages preserves live streamed text when the projection is still open", async () => {
    const qc = newQueryClient()
    const { client, api } = makeClient()
    const projected: ChatMessage[] = [
      {
        info: { id: "msg_1", sessionID: "ses_1", role: "assistant", time: { created: 1 } },
        parts: [{ id: "msg_1:text:0", sessionID: "ses_1", messageID: "msg_1", type: "text", text: "" }],
      },
    ]
    api.messages.mockResolvedValue(projected)

    const { result } = renderHook(() => useMessages(client, "ses_1", { connected: true, busy: true }), {
      wrapper: wrapper(qc),
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    // A live delta lands in the cache while the step is still streaming.
    qc.setQueryData<ChatMessage[]>(queryKeys.messages("ses_1"), [
      {
        info: { id: "msg_1", sessionID: "ses_1", role: "assistant", time: { created: 1 } },
        parts: [{ id: "msg_1:text:0", sessionID: "ses_1", messageID: "msg_1", type: "text", text: "Working…" }],
      },
    ])

    const refetched = await result.current.refetch()
    expect(refetched.data?.[0]?.parts).toEqual([
      { id: "msg_1:text:0", sessionID: "ses_1", messageID: "msg_1", type: "text", text: "Working…" },
    ])
  })

  it("useSessionDirectories loads the directory list for a workspace", async () => {
    const qc = newQueryClient()
    const { client, sessions } = makeClient()
    const { result } = renderHook(() => useSessionDirectories(client, true, "ws_1"), {
      wrapper: wrapper(qc),
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(sessions.directories).toHaveBeenCalledWith("ws_1")
  })

  it("useWorkspaces loads the registered workspaces", async () => {
    const qc = newQueryClient()
    const { client, workspaces } = makeClient()
    const { result } = renderHook(() => useWorkspaces(client), { wrapper: wrapper(qc) })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(workspaces.list).toHaveBeenCalledTimes(1)
  })

  it("useAgents and useModels load their catalogs", async () => {
    const qc = newQueryClient()
    const { client, api } = makeClient()

    const agents = renderHook(() => useAgents(client), { wrapper: wrapper(qc) })
    const models = renderHook(() => useModels(client), { wrapper: wrapper(qc) })

    await waitFor(() => expect(agents.result.current.isSuccess).toBe(true))
    await waitFor(() => expect(models.result.current.isSuccess).toBe(true))
    expect(api.agents).toHaveBeenCalledTimes(1)
    expect(api.models).toHaveBeenCalledTimes(1)
    expect(models.result.current.data).toEqual({ models: [], providers: [], defaultModel: null })
  })

  it("usePreview stays disabled without a session and fetches with one", async () => {
    const qc = newQueryClient()
    const { client, api } = makeClient()

    const disabled = renderHook(() => usePreview(client, null), { wrapper: wrapper(qc) })
    expect(disabled.result.current.fetchStatus).toBe("idle")
    expect(api.preview).not.toHaveBeenCalled()

    const enabled = renderHook(() => usePreview(client, "ses_1"), { wrapper: wrapper(qc) })
    await waitFor(() => expect(enabled.result.current.isSuccess).toBe(true))
    expect(api.preview).toHaveBeenCalledWith("ses_1")
  })

  it("useAudit loads the denied-command log when enabled", async () => {
    const qc = newQueryClient()
    const { client, api } = makeClient()

    const disabled = renderHook(() => useAudit(client, false), { wrapper: wrapper(qc) })
    expect(disabled.result.current.fetchStatus).toBe("idle")
    expect(api.audit).not.toHaveBeenCalled()

    const enabled = renderHook(() => useAudit(client), { wrapper: wrapper(qc) })
    await waitFor(() => expect(enabled.result.current.isSuccess).toBe(true))
    expect(api.audit).toHaveBeenCalledTimes(1)
  })

  it("useWorkspaceRun and useSessionRun stay idle without identifiers and fetch with them", async () => {
    const qc = newQueryClient()
    const { client, api } = makeClient()

    const disabled = renderHook(() => useWorkspaceRun(client, null), { wrapper: wrapper(qc) })
    expect(disabled.result.current.fetchStatus).toBe("idle")
    expect(api.run).not.toHaveBeenCalled()

    const config = renderHook(() => useWorkspaceRun(client, "ws_1"), { wrapper: wrapper(qc) })
    await waitFor(() => expect(config.result.current.isSuccess).toBe(true))
    expect(api.run).toHaveBeenCalledWith("ws_1")

    const missingWorkspace = renderHook(() => useSessionRun(client, "ses_1", null), { wrapper: wrapper(qc) })
    expect(missingWorkspace.result.current.fetchStatus).toBe("idle")

    const run = renderHook(() => useSessionRun(client, "ses_1", "ws_1"), { wrapper: wrapper(qc) })
    await waitFor(() => expect(run.result.current.isSuccess).toBe(true))
    expect(api.sessionRun).toHaveBeenCalledWith("ses_1", "ws_1")
  })

  it("useGoalRun stays disabled without a session and fetches its state with one", async () => {
    const qc = newQueryClient()
    const { client, api } = makeClient()

    const disabled = renderHook(() => useGoalRun(client, null), { wrapper: wrapper(qc) })
    expect(disabled.result.current.fetchStatus).toBe("idle")
    expect(api.goal.status).not.toHaveBeenCalled()

    const enabled = renderHook(() => useGoalRun(client, "ses_1"), { wrapper: wrapper(qc) })
    await waitFor(() => expect(enabled.result.current.isSuccess).toBe(true))
    expect(api.goal.status).toHaveBeenCalledWith("ses_1")
    expect(enabled.result.current.data).toMatchObject({ state: "running" })
  })

  it("useGoalRun lets an event frame beat an in-flight snapshot", async () => {
    const qc = newQueryClient()
    const { client, api } = makeClient()
    let resolveStatus: (value: Record<string, unknown>) => void = () => {}
    api.goal.status.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStatus = resolve
        }),
    )

    const hook = renderHook(() => useGoalRun(client, "ses_1"), { wrapper: wrapper(qc) })
    // The frame arrives while the fetch is still pending: it wins.
    createEventHandler(qc)({
      type: "goal.updated",
      data: { sessionID: "ses_1", goal: { ...goalRun("judging"), round: 2 } },
    })
    resolveStatus(goalRun("running"))
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true))
    expect(hook.result.current.data).toMatchObject({ state: "judging", round: 2 })
  })

  it("useGoalSettings loads the review settings", async () => {
    const qc = newQueryClient()
    const { client, api } = makeClient()

    const hook = renderHook(() => useGoalSettings(client), { wrapper: wrapper(qc) })
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true))
    expect(api.goal.settings).toHaveBeenCalledTimes(1)
    expect(hook.result.current.data).toEqual({ maxRounds: 5, criticModel: null, judgeModel: null })
  })
})

describe("useEventStream", () => {
  it("does nothing while disabled", () => {
    const qc = newQueryClient()
    const { client, stream } = makeClient()
    renderHook(() => useEventStream(client, { enabled: false, onEvent: () => {} }), { wrapper: wrapper(qc) })
    expect(client.eventStream).not.toHaveBeenCalled()
    expect(stream.start).not.toHaveBeenCalled()
  })

  it("subscribes, wires callbacks, reacts to network changes and cleans up", async () => {
    const qc = newQueryClient()
    const { client, stream, eventStream } = makeClient()
    const onEvent = vi.fn()
    const onConnectionChange = vi.fn()
    const onConnect = vi.fn()

    const view = renderHook(
      () => useEventStream(client, { enabled: true, onEvent, onConnectionChange, onConnect }),
      { wrapper: wrapper(qc) },
    )

    await waitFor(() => expect(stream.start).toHaveBeenCalledTimes(1))

    const options = eventStream.mock.calls[0]?.[0] as {
      onEvent: (event: unknown) => void
      onConnectionChange: (connected: boolean) => void
      onConnect: () => void
    }
    options.onEvent({ type: "session.idle" })
    options.onConnectionChange(true)
    options.onConnect()
    expect(onEvent).toHaveBeenCalledWith({ type: "session.idle" })
    expect(onConnectionChange).toHaveBeenCalledWith(true)
    expect(onConnect).toHaveBeenCalledTimes(1)

    document.dispatchEvent(new Event("visibilitychange"))
    window.dispatchEvent(new Event("online"))
    expect(stream.forceReconnect).toHaveBeenCalledTimes(2)

    view.unmount()
    // The listeners are detached with the stream, so late events are ignored.
    document.dispatchEvent(new Event("visibilitychange"))
    window.dispatchEvent(new Event("online"))
    expect(stream.forceReconnect).toHaveBeenCalledTimes(2)
    expect(stream.stop).toHaveBeenCalledTimes(1)
  })

  it("returns a handle that forces a reconnect while mounted", async () => {
    const qc = newQueryClient()
    const { client, stream } = makeClient()
    const view = renderHook(() => useEventStream(client, { enabled: true, onEvent: () => {} }), {
      wrapper: wrapper(qc),
    })
    await waitFor(() => expect(stream.start).toHaveBeenCalledTimes(1))

    view.result.current()
    expect(stream.forceReconnect).toHaveBeenCalledTimes(1)

    view.unmount()
    view.result.current()
    expect(stream.forceReconnect).toHaveBeenCalledTimes(1)
  })
})
