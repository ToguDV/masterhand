import type { Context } from "hono"
import type { Config } from "./config.js"

const FORWARD_REQUEST_HEADERS = [
  "content-type",
  "accept",
  "accept-language",
  "user-agent",
]
const FORWARD_RESPONSE_HEADERS = ["content-type", "cache-control", "etag", "last-modified"]

export function createOpencodeProxy(
  config: Config,
  fetchImpl: typeof fetch = fetch,
  upstreamTimeoutMs = 60_000,
) {
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

    let upstream: Response
    try {
      // Bounded fetch: a stalled opencode must never hold the proxy request
      // (and its socket) forever; the clients' own deadline fires sooner.
      upstream = await fetchImpl(target, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(upstreamTimeoutMs),
      })
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
