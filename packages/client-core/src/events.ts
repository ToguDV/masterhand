import { parseSseStream } from "./sse"

export interface EventStreamOptions {
  baseUrl: string
  urlPath?: string
  getToken?: () => string | null | Promise<string | null>
  fetchImpl?: typeof fetch
  onEvent: (event: unknown) => void
  onConnectionChange?: (connected: boolean) => void
  onConnect?: () => void
  reconnectBaseMs?: number
  reconnectMaxMs?: number
  staleMs?: number
  watchdogMs?: number
}

export interface EventStream {
  start(): void
  stop(): void
  forceReconnect(): void
  readonly connected: boolean
}

const DEFAULT_STALE_MS = 60_000
const DEFAULT_WATCHDOG_MS = 15_000

export function createEventStream(options: EventStreamOptions): EventStream {
  const fetchImpl = options.fetchImpl ?? fetch
  const reconnectBaseMs = options.reconnectBaseMs ?? 1000
  const reconnectMaxMs = options.reconnectMaxMs ?? 15_000
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS
  const watchdogMs = options.watchdogMs ?? DEFAULT_WATCHDOG_MS
  const urlPath = options.urlPath ?? "/api/events"

  let started = false
  let stopped = false
  let connected = false
  let controller: AbortController | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let watchdogTimer: ReturnType<typeof setInterval> | null = null
  let lastMessageAt = Date.now()
  let backoff = reconnectBaseMs

  function setConnected(value: boolean): void {
    if (connected === value) return
    connected = value
    options.onConnectionChange?.(value)
  }

  async function connect(): Promise<void> {
    controller = new AbortController()
    const signal = controller.signal

    try {
      const headers: Record<string, string> = { accept: "text/event-stream" }
      const token = await options.getToken?.()
      if (stopped) return
      if (token) headers.authorization = `Bearer ${token}`

      const response = await fetchImpl(`${options.baseUrl}${urlPath}`, {
        headers,
        signal,
        redirect: "error",
      })
      if (!response.ok || !response.body) throw new Error(`SSE ${response.status}`)

      lastMessageAt = Date.now()
      setConnected(true)
      options.onConnect?.()
      backoff = reconnectBaseMs

      for await (const message of parseSseStream(response.body)) {
        if (stopped) break
        lastMessageAt = Date.now()
        if (!message.data) continue
        try {
          options.onEvent(JSON.parse(message.data))
        } catch {
          // non-JSON events are ignored
        }
      }
    } catch {
      // disconnection or error: retry below
    }

    setConnected(false)
    if (stopped) return
    reconnectTimer = setTimeout(() => void connect(), backoff)
    backoff = Math.min(backoff * 2, reconnectMaxMs)
  }

  return {
    start() {
      if (started) return
      started = true
      stopped = false
      watchdogTimer = setInterval(() => {
        if (Date.now() - lastMessageAt > staleMs) controller?.abort()
      }, watchdogMs)
      void connect()
    },
    stop() {
      stopped = true
      controller?.abort()
      if (reconnectTimer) clearTimeout(reconnectTimer)
      if (watchdogTimer) clearInterval(watchdogTimer)
      reconnectTimer = null
      watchdogTimer = null
    },
    forceReconnect() {
      if (stopped) return
      // A deliberate signal (tab visible again, network back, app foregrounded):
      // retry at full speed instead of waiting out the current backoff, and
      // cancel a retry already scheduled with the grown delay.
      backoff = reconnectBaseMs
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
        void connect()
        return
      }
      controller?.abort()
    },
    get connected() {
      return connected
    },
  }
}
