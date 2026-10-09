import { parseSseStream } from "./sse.js"

export interface EventHub {
  start(): void
  stop(): void
  subscribe(listener: (event: unknown) => void): () => void
  /**
   * Broadcasts a synthetic event to every subscriber (the same path the
   * upstream frames take). MasterHand uses it for `goal.updated` frames; the
   * clients ignore unknown types, so this never breaks them.
   */
  emit(event: unknown): void
  readonly connected: boolean
}

export const DEFAULT_STALL_MS = 45_000
const MAX_STALL_CHECK_MS = 15_000

export interface EventHubOptions {
  url: string
  authHeader?: string | null
  fetchImpl?: typeof fetch
  reconnectBaseMs?: number
  reconnectMaxMs?: number
  /**
   * Reconnect when no bytes arrive for this long. opencode v2 sends a
   * `: heartbeat` comment every 15 s (verified against 2.0.21), so the default
   * tolerates three missed beats before declaring the socket half-open.
   */
  stallMs?: number
  onEvent?: (event: unknown) => void
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener("abort", done, { once: true })
  })
}

/**
 * opencode v2 emits one JSON event object per SSE frame
 * (`{ id, type, location?, data, durable? }`); MasterHand forwards it as-is.
 */
export function normalizeEvent(raw: unknown): unknown | null {
  if (!raw || typeof raw !== "object") return null
  const type = (raw as { type?: unknown }).type
  return typeof type === "string" ? raw : null
}

export function createEventHub(options: EventHubOptions): EventHub {
  const fetchImpl = options.fetchImpl ?? fetch
  const listeners = new Set<(event: unknown) => void>()
  const baseBackoff = options.reconnectBaseMs ?? 1000
  const maxBackoff = options.reconnectMaxMs ?? 30000
  const stallMs = options.stallMs ?? DEFAULT_STALL_MS

  let connected = false
  let stopped = false
  let started = false
  let abortController: AbortController | null = null
  // Dedicated signal for the retry sleep, so a stall-triggered abort (which
  // aborts the fetch controller) does not cut the backoff short.
  const lifecycle = new AbortController()
  let lastActivityAt = Date.now()
  let watchdogTimer: ReturnType<typeof setInterval> | null = null

  function notify(event: unknown): void {
    for (const listener of listeners) {
      try {
        listener(event)
      } catch {
        // a faulty listener must not take down the stream
      }
    }
    try {
      options.onEvent?.(event)
    } catch {
      // same for the global hook
    }
  }

  function setConnected(value: boolean): void {
    if (connected === value) return
    connected = value
    // Synthetic frames so downstream clients can react (refresh the status
    // indicator) without waiting for their health poll.
    notify({ type: value ? "hub.connected" : "hub.disconnected", data: { connected: value } })
  }

  async function run(): Promise<void> {
    let backoff = baseBackoff

    while (!stopped) {
      abortController = new AbortController()
      lastActivityAt = Date.now()
      const headers: Record<string, string> = { accept: "text/event-stream" }
      if (options.authHeader) headers.authorization = options.authHeader

      try {
        const response = await fetchImpl(options.url, { headers, signal: abortController.signal })
        if (!response.ok || !response.body) {
          throw new Error(`SSE upstream responded ${response.status}`)
        }

        setConnected(true)
        backoff = baseBackoff

        // Raw-chunk activity (comments included) resets the stall window; a
        // half-open socket sends nothing, so the watchdog aborts it below.
        const onActivity = (): void => {
          lastActivityAt = Date.now()
        }
        for await (const message of parseSseStream(response.body, { onActivity })) {
          if (stopped) break
          if (!message.data) continue
          try {
            const event = normalizeEvent(JSON.parse(message.data))
            if (event !== null) notify(event)
          } catch {
            // non-JSON events are ignored
          }
        }
      } catch {
        // disconnection or error: retry with backoff
      } finally {
        setConnected(false)
      }

      if (stopped) break
      await sleep(backoff, lifecycle.signal)
      backoff = Math.min(backoff * 2, maxBackoff)
    }
  }

  return {
    start() {
      // Idempotent: a second call must not open a second connection loop.
      if (stopped || started) return
      started = true
      const checkMs = Math.max(100, Math.min(MAX_STALL_CHECK_MS, Math.floor(stallMs / 3)))
      watchdogTimer = setInterval(() => {
        if (Date.now() - lastActivityAt > stallMs) abortController?.abort()
      }, checkMs)
      void run()
    },
    stop() {
      stopped = true
      if (watchdogTimer) clearInterval(watchdogTimer)
      watchdogTimer = null
      lifecycle.abort()
      abortController?.abort()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit(event) {
      notify(event)
    },
    get connected() {
      return connected
    },
  }
}
