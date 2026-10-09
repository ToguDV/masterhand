import { afterEach, describe, expect, it, vi } from "vitest"
import { createEventHub, type EventHub } from "../src/events.js"

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
}

/** Sends `initial` frames, then never closes nor sends again: a half-open socket. */
function stalledResponse(initial: string[], signal?: AbortSignal | null): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of initial) controller.enqueue(encoder.encode(chunk))
      // Real fetch errors the body when the request signal aborts.
      signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), {
        once: true,
      })
    },
  })
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
}

/** Sends each chunk after its delay; optionally never closes. */
function timedResponse(
  chunks: Array<{ afterMs: number; chunk: string }>,
  options: { close?: boolean } = {},
): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let elapsed = 0
      for (const { afterMs, chunk } of chunks) {
        elapsed += afterMs
        setTimeout(() => controller.enqueue(encoder.encode(chunk)), elapsed)
      }
      if (options.close !== false) setTimeout(() => controller.close(), elapsed + 5)
    },
  })
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
}

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer)
        resolve()
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        reject(new Error("waitFor timed out"))
      }
    }, 5)
  })
}

let hub: EventHub | null = null
afterEach(() => {
  hub?.stop()
  hub = null
})

describe("createEventHub", () => {
  it("broadcasts synthetic events through emit to every subscriber and the hook", () => {
    const hookEvents: unknown[] = []
    const seenA: unknown[] = []
    const seenB: unknown[] = []
    hub = createEventHub({
      url: "http://127.0.0.1:1/api/event",
      fetchImpl: async () => sseResponse([]),
      onEvent: (event) => hookEvents.push(event),
    })
    hub.subscribe((event) => seenA.push(event))
    hub.subscribe((event) => seenB.push(event))

    const frame = { type: "goal.updated", data: { sessionID: "ses_1", goal: null } }
    hub.emit(frame)

    expect(seenA).toEqual([frame])
    expect(seenB).toEqual([frame])
    expect(hookEvents).toEqual([frame])
  })

  it("forwards v2 events to subscribers and the global hook, dropping invalid frames", async () => {
    const event = { id: "evt_1", type: "session.idle", data: { sessionID: "ses_1" } }
    const fetchImpl = vi.fn(async () =>
      sseResponse([
        "data: not-json\n\n",
        `data: ${JSON.stringify({ id: "evt_bad", data: { ignored: true } })}\n\n`,
        `data: ${JSON.stringify(event)}\n\n`,
      ]),
    )
    const onEvent = vi.fn()
    hub = createEventHub({
      url: "http://upstream/api/event",
      reconnectBaseMs: 5,
      reconnectMaxMs: 10,
      onEvent,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const received: unknown[] = []
    const unsubscribe = hub.subscribe((event) => received.push(event))

    hub.start()
    await waitFor(() => onEvent.mock.calls.length > 0)

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://upstream/api/event",
      expect.objectContaining({ headers: expect.objectContaining({ accept: "text/event-stream" }) }),
    )
    const upstream = received.filter(
      (item) => !["hub.connected", "hub.disconnected"].includes((item as { type?: string }).type ?? ""),
    )
    expect(upstream).toEqual([event])
    expect(received).toContainEqual({ type: "hub.connected", data: { connected: true } })
    expect(onEvent).toHaveBeenCalledWith(event)

    unsubscribe()
  })

  it("aborts a half-open stream, reconnects and reports the connectivity change", async () => {
    let connection = 0
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      connection += 1
      return connection === 1
        ? stalledResponse([`data: ${JSON.stringify({ type: "server.connected", data: {} })}\n\n`], init?.signal)
        : sseResponse([`data: ${JSON.stringify({ type: "session.idle", data: { sessionID: "ses_1" } })}\n\n`])
    })
    hub = createEventHub({
      url: "http://upstream/api/event",
      reconnectBaseMs: 5,
      reconnectMaxMs: 10,
      stallMs: 60,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const types: string[] = []
    hub.subscribe((event) => types.push((event as { type: string }).type))

    hub.start()
    await waitFor(() => types.includes("session.idle"), 3000)
    expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(types).toContain("hub.disconnected")
    expect(types).toContain("hub.connected")
  })

  it("keeps a stream alive through comment-only heartbeats", async () => {
    let connection = 0
    const fetchImpl = vi.fn(async () => {
      connection += 1
      if (connection > 1) return stalledResponse([])
      return timedResponse(
        [
          { afterMs: 0, chunk: ": heartbeat\n\n" },
          { afterMs: 40, chunk: ": heartbeat\n\n" },
          { afterMs: 40, chunk: ": heartbeat\n\n" },
          { afterMs: 40, chunk: `data: ${JSON.stringify({ type: "session.idle", data: { sessionID: "ses_1" } })}\n\n` },
        ],
        { close: false },
      )
    })
    hub = createEventHub({
      url: "http://upstream/api/event",
      reconnectBaseMs: 5,
      reconnectMaxMs: 10,
      stallMs: 90,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const types: string[] = []
    hub.subscribe((event) => types.push((event as { type: string }).type))

    hub.start()
    // The event arrives ~125 ms in, well past the 90 ms stall window: only the
    // heartbeats (ignored as messages) can have kept the connection alive.
    await waitFor(() => types.includes("session.idle"), 3000)
    expect(types).not.toContain("hub.disconnected")
  })

  it("keeps notifying healthy listeners when one throws", async () => {
    hub = createEventHub({
      url: "http://upstream/api/event",
      reconnectBaseMs: 5,
      reconnectMaxMs: 10,
      fetchImpl: async () => sseResponse([`data: ${JSON.stringify({ type: "server.connected" })}\n\n`]),
    })
    const healthy = vi.fn()
    hub.subscribe(() => {
      throw new Error("boom")
    })
    hub.subscribe(healthy)

    hub.start()
    await waitFor(() => healthy.mock.calls.length > 0)
    expect(healthy).toHaveBeenCalledWith({ type: "server.connected" })
  })

  it("forwards the upstream auth header", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 500 }))
    hub = createEventHub({
      url: "http://upstream/api/event",
      authHeader: "Basic abc",
      reconnectBaseMs: 5,
      reconnectMaxMs: 10,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    hub.start()
    await waitFor(() => fetchImpl.mock.calls.length > 0)
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://upstream/api/event",
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Basic abc" }) }),
    )
  })

  it("retries with backoff after a failed upstream response", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 502 }))
    hub = createEventHub({
      url: "http://upstream/api/event",
      reconnectBaseMs: 5,
      reconnectMaxMs: 10,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    hub.start()
    await waitFor(() => fetchImpl.mock.calls.length > 1)
    hub.stop()
    const callsAfterStop = fetchImpl.mock.calls.length
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(fetchImpl.mock.calls.length).toBe(callsAfterStop)
  })

  it("does not start again after being stopped", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 500 }))
    hub = createEventHub({
      url: "http://upstream/api/event",
      reconnectBaseMs: 5,
      reconnectMaxMs: 10,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    hub.stop()
    hub.start()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("is idempotent: repeated starts open a single connection loop", async () => {
    let calls = 0
    const fetchImpl = vi.fn(() => {
      calls += 1
      // A hanging request keeps the first loop busy, so only a duplicate loop
      // would produce another call.
      return new Promise<Response>(() => {})
    })
    hub = createEventHub({
      url: "http://upstream/api/event",
      reconnectBaseMs: 5,
      reconnectMaxMs: 10,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    hub.start()
    hub.start()
    await waitFor(() => calls === 1)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(calls).toBe(1)
  })
})
