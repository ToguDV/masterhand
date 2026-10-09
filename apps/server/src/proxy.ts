import type { Context } from "hono"
import type { Config } from "./config.js"
import {
  AmbiguousMutationError,
  RetryExhaustedError,
  UpstreamStatusError,
  isTransientFailure,
  isTransientStatus,
  withRetry,
} from "./retry.js"

const FORWARD_REQUEST_HEADERS = [
  "content-type",
  "accept",
  "accept-language",
  "user-agent",
]
const FORWARD_RESPONSE_HEADERS = ["content-type", "cache-control", "etag", "last-modified"]

/** Must match `DELIVERY_MARKER_KEY` in client-core (`delivery.ts`). */
const DELIVERY_MARKER_KEY = "masterhand.delivery"

/** Idempotent POSTs (full state replacement) safe to replay on transient failures. */
const IDEMPOTENT_POST_PATHS = [/^\/api\/session\/[^/]+\/(agent|model)$/]
/** The one non-idempotent POST with a persisted marker to reconcile against. */
const PROMPT_PATH = /^\/api\/session\/([^/]+)\/prompt$/

export interface ProxyRetryOptions {
  /** Total attempts for retryable requests. Default 3. */
  attempts?: number
  /** First backoff delay. Default 250 ms. */
  baseDelayMs?: number
  jitter?: boolean
  /** Injectable sleeper (tests). */
  sleep?: (ms: number) => Promise<void>
}

function deliveryMarkerOf(body: ArrayBuffer | undefined): string | null {
  if (!body) return null
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    const metadata = (parsed as { metadata?: unknown }).metadata
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null
    const marker = (metadata as Record<string, unknown>)[DELIVERY_MARKER_KEY]
    return typeof marker === "string" && marker.length > 0 ? marker : null
  } catch {
    return null
  }
}

function retryableStatus(error: unknown): number | null {
  return error instanceof UpstreamStatusError ? error.status : null
}

export function createOpencodeProxy(
  config: Config,
  fetchImpl: typeof fetch = fetch,
  upstreamTimeoutMs = 60_000,
  retryOptions: ProxyRetryOptions = {},
) {
  const attempts = Math.max(1, retryOptions.attempts ?? 3)
  const baseDelayMs = Math.max(0, retryOptions.baseDelayMs ?? 250)
  const jitter = retryOptions.jitter ?? true
  const sleep = retryOptions.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  return async (c: Context): Promise<Response> => {
    const requestUrl = new URL(c.req.url)
    const path = c.req.path.replace(/^\/api\/oc/, "") || "/"

    let target: URL
    try {
      // Keep the upstream origin fixed: a path such as "//host/x" must never be
      // interpreted as a protocol-relative URL (SSRF / credential leak).
      target = new URL(config.opencodeUrl)
      target.pathname = path.startsWith("/") ? path : `/${path}`
      target.search = requestUrl.search
    } catch {
      return c.json({ error: "bad_upstream_url" }, 502)
    }

    const headers = new Headers()
    if (config.opencodeAuth) headers.set("authorization", config.opencodeAuth)
    for (const name of FORWARD_REQUEST_HEADERS) {
      const value = c.req.header(name)
      if (value) headers.set(name, value)
    }

    const method = c.req.method
    let body: ArrayBuffer | undefined
    if (method !== "GET" && method !== "HEAD") {
      const raw = await c.req.arrayBuffer()
      if (raw.byteLength > 0) body = raw
    }

    const idempotent =
      method === "GET" || method === "HEAD" || (method === "POST" && IDEMPOTENT_POST_PATHS.some((re) => re.test(path)))
    const promptMatch = method === "POST" ? PROMPT_PATH.exec(path) : null
    const promptSessionID = promptMatch?.[1] ? decodeURIComponent(promptMatch[1]) : null
    const deliveryMarker = promptSessionID ? deliveryMarkerOf(body) : null
    // A prompt without a delivery marker (slash commands) cannot be reconciled:
    // replaying it could duplicate the turn, so it stays single-shot.
    const reconciledPrompt = deliveryMarker !== null && promptSessionID !== null
    const retryable = idempotent || reconciledPrompt

    const requestOnce = (): Promise<Response> =>
      fetchImpl(target, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(upstreamTimeoutMs),
      })

    /** Marker lookup: did this exact prompt already land upstream? */
    const promptLanded = async (): Promise<boolean> => {
      if (!promptSessionID || !deliveryMarker) return false
      const history = new URL(`/api/session/${encodeURIComponent(promptSessionID)}/message`, config.opencodeUrl)
      history.searchParams.set("limit", "20")
      history.searchParams.set("order", "desc")
      const response = await fetchImpl(history, {
        headers: { authorization: config.opencodeAuth ?? "", accept: "application/json" },
        signal: AbortSignal.timeout(upstreamTimeoutMs),
      })
      // An unavailable lookup proves nothing: throwing here makes the retry
      // engine abort instead of replaying a possibly-landed prompt (rule 4).
      if (!response.ok) throw new UpstreamStatusError(response.status, response)
      const payload = (await response.json()) as {
        data?: Array<{ type?: string; metadata?: Record<string, unknown> }>
      }
      return (payload.data ?? []).some(
        (message) => message.type === "user" && message.metadata?.[DELIVERY_MARKER_KEY] === deliveryMarker,
      )
    }

    let upstream: Response
    try {
      if (!retryable) {
        upstream = await requestOnce()
      } else {
        upstream = await withRetry(
          async () => {
            const response = await requestOnce()
            // Transient statuses are retried; the rest (including 4xx) passes
            // through exactly like before this layer existed.
            if (isTransientStatus(response.status)) throw new UpstreamStatusError(response.status, response)
            return response
          },
          {
            attempts,
            baseDelayMs,
            jitter,
            sleep,
            // A prompt timeout is ambiguous: reconciling before the retry makes
            // it safe to try again. Idempotent calls never retry timeouts
            // (a stalled upstream must not multiply the stall).
            shouldRetry: (error) => isTransientFailure(error, { includeTimeouts: reconciledPrompt }),
            reconcile: reconciledPrompt
              ? async () => {
                  const landed = await promptLanded()
                  if (!landed) return undefined
                  return new Response(JSON.stringify({ data: { sessionID: promptSessionID, delivered: true } }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                  })
                }
              : undefined,
            onRetry: (info) => {
              const status = retryableStatus(info.error)
              console.warn(
                `[proxy] ${method} ${path} failed (${status ? `HTTP ${status}` : "transport"}) — retrying in ${info.delayMs}ms`,
              )
            },
          },
        ).catch((error: unknown) => {
          if (error instanceof RetryExhaustedError) {
            // Keep the pre-existing behavior: the last upstream response (or
            // the original transport error) reaches the client.
            if (error.lastError instanceof UpstreamStatusError && error.lastError.response) {
              return error.lastError.response
            }
            throw error.lastError
          }
          if (error instanceof AmbiguousMutationError) {
            // Unknown outcome: never replayed. The client reconciles a marked
            // prompt against the history (lost-response rules).
            if (error.cause instanceof UpstreamStatusError && error.cause.response) return error.cause.response
            throw error.cause
          }
          throw error
        })
      }
    } catch (error) {
      if ((error as { name?: string } | null)?.name === "TimeoutError") {
        return c.json({ error: "opencode_timeout" }, 504)
      }
      return c.json({ error: "opencode_unreachable" }, 502)
    }

    // opencode rejected the BFF credentials: surface an actionable error and
    // never relay its 401 (it would sign the user out of MasterHand).
    if (upstream.status === 401 || upstream.status === 403) {
      return c.json({ error: "opencode_unauthorized" }, 502)
    }

    const responseHeaders = new Headers()
    for (const name of FORWARD_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name)
      if (value) responseHeaders.set(name, value)
    }
    if (upstream.headers.get("content-type")?.includes("text/event-stream")) {
      responseHeaders.set("cache-control", "no-cache")
      responseHeaders.set("x-accel-buffering", "no")
    }

    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders })
  }
}
