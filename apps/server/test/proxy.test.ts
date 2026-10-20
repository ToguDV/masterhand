import { get as httpGet, request as httpRequest, type IncomingMessage } from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import type { Config } from "../src/config.js"
import { createOpencodeProxy, isAllowedOpencodePath } from "../src/proxy.js"
import { login, readUntil, startMockOpencode, startTestApp, waitFor, type MockOpencode, type TestApp } from "./helpers.js"

const TEST_AUTH = `Basic ${Buffer.from("opencode:oc-secret").toString("base64")}`

let app: TestApp | null = null
let upstream: MockOpencode | null = null

afterEach(async () => {
  await app?.close()
  await upstream?.close()
  app = null
  upstream = null
})

/**
 * The client surface verified for #179. Every other method/path pair is denied
 * by the proxy before it can reach opencode (PTY, shell, terminal, fs, config…).
 */
const ALLOWED_OPENCODE_PATHS: Array<[string, string]> = [
  ["GET", "/api/session/active"],
  ["GET", "/api/session/ses_1/message"],
  ["POST", "/api/session/ses_1/agent"],
  ["POST", "/api/session/ses_1/model"],
  ["POST", "/api/session/ses_1/prompt"],
  ["POST", "/api/session/ses_1/command"],
  ["POST", "/api/session/ses_1/fork"],
  ["POST", "/api/session/ses_1/interrupt"],
  ["DELETE", "/api/session/ses_1"],
  ["GET", "/api/permission/request"],
  ["POST", "/api/session/ses_1/permission/per_1/reply"],
  ["GET", "/api/form"],
  ["GET", "/api/session/ses_1/form"],
  ["GET", "/api/session/ses_1/form/form_1"],
  ["POST", "/api/session/ses_1/form/form_1/reply"],
  ["DELETE", "/api/session/ses_1/form/form_1"],
  ["GET", "/api/agent"],
  ["GET", "/api/model"],
  ["GET", "/api/model/default"],
  ["GET", "/api/provider"],
  ["GET", "/api/integration"],
  ["POST", "/api/integration/acme/connect/key"],
  ["POST", "/api/credential/cred_1/activate"],
  ["DELETE", "/api/credential/cred_1"],
  ["GET", "/api/websearch/provider"],
  ["POST", "/api/websearch"],
]

const DENIED_OPENCODE_PATHS: Array<[string, string]> = [
  // The #179 bypass: a client could spawn a PTY as the engine user.
  ["POST", "/api/pty"],
  ["GET", "/api/pty"],
  ["DELETE", "/api/pty/pty_1"],
  ["POST", "/api/shell"],
  ["GET", "/api/shell"],
  ["POST", "/api/session/ses_1/shell"],
  ["POST", "/api/experimental/session/ses_1/terminal"],
  ["GET", "/api/experimental/persistent-pty"],
  ["GET", "/api/fs/read"],
  ["POST", "/api/experimental/fs/write"],
  ["GET", "/api/config"],
  ["PATCH", "/api/config"],
  ["GET", "/api/plugin"],
  ["GET", "/api/experimental/mcp"],
  // The list route does not exist in opencode 2.0.6 (issue #216).
  ["GET", "/api/credential"],
  ["GET", "/api/session"],
  ["POST", "/api/session"],
  ["GET", "/api/session/ses_1"],
  ["PATCH", "/api/session/ses_1"],
  ["GET", "/api/experimental/session/ses_1/instructions/entries/masterhand.preview"],
  ["GET", "/api/info"],
  ["GET", "/api/event"],
  ["GET", "/api/command"],
  ["GET", "/api/global/health"],
  ["GET", "/api/instance/one"],
  ["GET", "/api/tui/append-prompt"],
  ["GET", "/api/app/init"],
  ["GET", "/api/file/read"],
  ["POST", "/api/session/ses_1/prompt_async"],
  // Protocol-relative: must never be interpreted as a new origin (SSRF).
  ["GET", "//evil.example.com/steal"],
  // Method mismatches on an otherwise allowed path.
  ["GET", "/api/session/ses_1/prompt"],
  ["POST", "/api/agent"],
  ["POST", "/api/session/ses_1/message"],
  // Encoded slash: real opencode ids are slash-free, so this must not match.
  ["GET", "/api/session/ses%2F1/message"],
  ["POST", "/api/session/ses%2f1/prompt"],
  ["GET", "/api/session/ses%2F1/form/form_1"],
]

describe("opencode proxy allowlist (#179)", () => {
  it.each(ALLOWED_OPENCODE_PATHS)("allows %s %s", (method: string, path: string) => {
    expect(isAllowedOpencodePath(method, path)).toBe(true)
  })

  it.each(DENIED_OPENCODE_PATHS)("denies %s %s", (method: string, path: string) => {
    expect(isAllowedOpencodePath(method, path)).toBe(false)
  })
})

/** High-risk groups that must never be reachable through the client proxy. */
const DENIED_APP_REQUESTS: Array<[string, string]> = [
  ["POST", "/api/oc/api/pty"],
  ["GET", "/api/oc/api/pty"],
  ["DELETE", "/api/oc/api/pty/pty_1"],
  ["POST", "/api/oc/api/session/ses_1/shell"],
  ["GET", "/api/oc/api/shell"],
  ["POST", "/api/oc/api/experimental/session/ses_1/terminal"],
  ["GET", "/api/oc/api/experimental/persistent-pty"],
  ["GET", "/api/oc/api/fs/read"],
  ["POST", "/api/oc/api/experimental/fs/write"],
  ["GET", "/api/oc/api/config"],
  ["GET", "/api/oc/api/plugin"],
  ["GET", "/api/oc/api/experimental/mcp"],
  ["GET", "/api/oc/api/credential"],
  ["POST", "/api/oc/api/session"],
  ["GET", "/api/oc/api/session"],
  ["GET", "/api/oc/api/info"],
  ["GET", "/api/oc/global/health"],
  ["GET", "/api/oc//evil.example.com/steal"],
  // An encoded slash must not smuggle extra path segments past the allowlist.
  ["POST", "/api/oc/api/session/ses%2F1/prompt"],
  ["GET", "/api/oc/api/session/ses%2F1/message"],
]

describe("opencode proxy allowlist at the HTTP boundary (#179)", () => {
  it.each(DENIED_APP_REQUESTS)("denies %s %s without calling upstream", async (method: string, path: string) => {
    const seen: string[] = []
    const stub: typeof fetch = async (input) => {
      seen.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url)
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    app = await startTestApp({ config: { opencodeUrl: "http://127.0.0.1:4096" }, fetchImpl: stub })
    const cookie = await login(app.url)

    const response = await fetch(`${app.url}${path}`, {
      method,
      headers: { cookie, "content-type": "application/json" },
      body: method === "GET" ? undefined : JSON.stringify({ command: "sh", args: ["-c", "id"] }),
    })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: "not_found" })
    expect(seen).toHaveLength(0)
  })

  it("forwards an allowlisted path and returns the upstream result", async () => {
    upstream = await startMockOpencode()
    app = await startTestApp({ config: { opencodeUrl: upstream.url, opencodeAuth: TEST_AUTH } })
    const cookie = await login(app.url)

    const response = await fetch(`${app.url}/api/oc/api/model`, { headers: { cookie } })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: Array<Record<string, unknown>> }
    expect(body.data).toContainEqual({ id: "test-model", providerID: "test" })
    expect(upstream.requests.filter((request) => request.path === "/api/model")).toHaveLength(1)
  })
})

describe("opencode proxy", () => {
  it("proxies GET and injects basic auth", async () => {
    upstream = await startMockOpencode()
    app = await startTestApp({ config: { opencodeUrl: upstream.url, opencodeAuth: TEST_AUTH } })
    const cookie = await login(app.url)

    const response = await fetch(`${app.url}/api/oc/api/model`, { headers: { cookie } })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: Array<Record<string, unknown>> }
    expect(body.data).toContainEqual({ id: "test-model", providerID: "test" })

    const proxied = upstream.requests.find((request) => request.path === "/api/model")
    expect(proxied?.authorization).toBe(TEST_AUTH)
  })

  it("proxies POST with a body and preserves the status", async () => {
    upstream = await startMockOpencode()
    app = await startTestApp({ config: { opencodeUrl: upstream.url, opencodeAuth: TEST_AUTH } })
    const cookie = await login(app.url)

    const response = await fetch(`${app.url}/api/oc/api/session/ses_1/agent`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ agent: "build" }),
    })
    expect(response.status).toBe(204)

    const proxied = upstream.requests.find((request) => request.path.endsWith("/agent"))
    expect(proxied).toBeDefined()
    // v2 no longer injects a `system` instruction: the body is byte-identical.
    expect(JSON.parse(proxied?.body ?? "{}")).toEqual({ agent: "build" })
  })

  it("leaves an existing system prompt untouched", async () => {
    upstream = await startMockOpencode()
    app = await startTestApp({ config: { opencodeUrl: upstream.url } })
    const cookie = await login(app.url)

    await fetch(`${app.url}/api/oc/api/session/ses_7/prompt`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text: "hi" }], system: "Be terse." }),
    })

    const proxied = upstream.requests.find((request) => request.path.includes("/prompt"))
    expect(JSON.parse(proxied?.body ?? "{}")).toEqual({
      parts: [{ type: "text", text: "hi" }],
      system: "Be terse.",
    })
  })

  it("forwards the query string and allowed headers, but not the directory header", async () => {
    upstream = await startMockOpencode()
    app = await startTestApp({ config: { opencodeUrl: upstream.url, opencodeAuth: TEST_AUTH } })
    const cookie = await login(app.url)

    await fetch(`${app.url}/api/oc/api/model?location%5Bdirectory%5D=%2Fworkspace%2Fapp&limit=200`, {
      headers: { cookie, "x-opencode-directory": "/workspace/app", "accept-language": "es-ES" },
    })

    const proxied = upstream.requests.find((request) => request.path === "/api/model")
    expect(proxied?.query).toBe("location%5Bdirectory%5D=%2Fworkspace%2Fapp&limit=200")
    expect(proxied?.headers["accept-language"]).toBe("es-ES")
    expect(proxied?.headers["x-opencode-directory"]).toBeUndefined()
    expect(proxied?.authorization).toBe(TEST_AUTH)
  })

  it("requires authentication to proxy", async () => {
    upstream = await startMockOpencode()
    app = await startTestApp({ config: { opencodeUrl: upstream.url, opencodeAuth: TEST_AUTH } })

    const response = await fetch(`${app.url}/api/oc/api/model`)
    expect(response.status).toBe(401)
  })

  it("rejects malformed percent-encoding with 400 invalid_path", async () => {
    upstream = await startMockOpencode()
    app = await startTestApp({ config: { opencodeUrl: upstream.url, opencodeAuth: TEST_AUTH } })
    const cookie = await login(app.url)

    const response = await fetch(`${app.url}/api/oc/api/session/%E0%A4%A/prompt`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "invalid_path" })
    expect(upstream.requests.filter((request) => request.path.includes("/prompt"))).toHaveLength(0)
  })

  it("rejects an oversized Content-Length before reading the body", async () => {
    upstream = await startMockOpencode()
    app = await startTestApp({ config: { opencodeUrl: upstream.url, opencodeAuth: TEST_AUTH } })
    const cookie = await login(app.url)

    const { status, body } = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpRequest(
        {
          host: "127.0.0.1",
          port: Number(new URL(app!.url).port),
          path: "/api/oc/api/session/ses_1/prompt",
          method: "POST",
          headers: {
            cookie,
            "content-type": "application/json",
            // Declares far more than the proxy cap without allocating it.
            "content-length": String(32 * 1024 * 1024),
            // Do not keep the socket waiting for a body that will never arrive.
            connection: "close",
          },
        },
        (response) => {
          let text = ""
          response.on("data", (chunk) => {
            text += chunk
          })
          response.on("end", () => resolve({ status: response.statusCode ?? 0, body: text }))
        },
      )
      request.on("error", reject)
      request.end()
    })

    expect(status).toBe(413)
    expect(JSON.parse(body)).toEqual({ error: "payload_too_large" })
    expect(upstream.requests.filter((request) => request.path.includes("/prompt"))).toHaveLength(0)
  })

  it("counts chunked proxy bodies and rejects them past the cap", async () => {
    upstream = await startMockOpencode()
    app = await startTestApp({ config: { opencodeUrl: upstream.url, opencodeAuth: TEST_AUTH } })
    const cookie = await login(app.url)

    const chunk = new Uint8Array(64 * 1024)
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // ~11 MiB, just past the 10 MiB default proxy cap.
        for (let i = 0; i < 180; i += 1) controller.enqueue(chunk)
        controller.close()
      },
    })
    const response = await fetch(`${app.url}/api/oc/api/session/ses_1/prompt`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit)
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: "payload_too_large" })
    expect(upstream.requests.filter((request) => request.path.includes("/prompt"))).toHaveLength(0)

    // The event loop and the app keep serving after the rejection.
    const after = await fetch(`${app.url}/api/oc/api/model`, { headers: { cookie } })
    expect(after.status).toBe(200)
  })

  it("responds 502 when opencode is unavailable", async () => {
    app = await startTestApp({ config: { opencodeUrl: "http://127.0.0.1:1" } })
    const cookie = await login(app.url)

    const response = await fetch(`${app.url}/api/oc/api/model`, { headers: { cookie } })
    expect(response.status).toBe(502)
  })

  it("maps an opencode 401 to an actionable 502 instead of relaying it", async () => {
    const stub: typeof fetch = async () => new Response("unauthorized", { status: 401 })
    app = await startTestApp({ fetchImpl: stub })
    const cookie = await login(app.url)

    const response = await fetch(`${app.url}/api/oc/api/model`, { headers: { cookie } })
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: "opencode_unauthorized" })
  })

  it("denies protocol-relative paths and keeps the upstream origin fixed for allowed paths (SSRF)", async () => {
    const seen: string[] = []
    const stub: typeof fetch = async (input) => {
      seen.push(
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
      )
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    app = await startTestApp({ config: { opencodeUrl: "http://127.0.0.1:4096" }, fetchImpl: stub })
    const cookie = await login(app.url)

    // The allowlist rejects `//host/...` before the URL is even built.
    const denied = await fetch(`${app.url}/api/oc//evil.example.com/steal`, { headers: { cookie } })
    expect(denied.status).toBe(404)
    expect(await denied.json()).toEqual({ error: "not_found" })
    expect(seen).toHaveLength(0)

    const response = await fetch(`${app.url}/api/oc/api/model`, { headers: { cookie } })
    expect(response.status).toBe(200)
    expect(seen).toHaveLength(1)
    expect(new URL(seen[0]!).host).toBe("127.0.0.1:4096")
  })

  it("answers 504 when the upstream stalls past its deadline", async () => {
    const stall: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")))
      })
    const proxy = createOpencodeProxy(
      { opencodeUrl: "http://127.0.0.1:4096", opencodeAuth: null } as unknown as Config,
      stall,
      20,
    )
    const context = {
      req: {
        url: "http://test/api/oc/api/model",
        path: "/api/oc/api/model",
        method: "GET",
        header: () => undefined,
        arrayBuffer: async () => new ArrayBuffer(0),
      },
      json: (body: unknown, status: number) => new Response(JSON.stringify(body), { status }),
    }

    const response = await proxy(context as never)
    expect(response.status).toBe(504)
    expect(await response.json()).toEqual({ error: "opencode_timeout" })
  })

  it("retries transient upstream statuses on idempotent GETs", async () => {
    upstream = await startMockOpencode()
    app = await startTestApp({ config: { opencodeUrl: upstream.url, opencodeAuth: TEST_AUTH } })
    const cookie = await login(app.url)

    upstream.failNext("/api/model", 1, 503)
    const response = await fetch(`${app.url}/api/oc/api/model`, { headers: { cookie } })
    expect(response.status).toBe(200)
    expect(upstream.requests.filter((request) => request.path === "/api/model")).toHaveLength(2)
  })

  it("returns the last transient response after the attempt budget", async () => {
    upstream = await startMockOpencode()
    app = await startTestApp({
      config: { opencodeUrl: upstream.url, opencodeAuth: TEST_AUTH },
      proxyRetry: { attempts: 3, baseDelayMs: 1, jitter: false },
    })
    const cookie = await login(app.url)

    upstream.failNext("/api/model", 5, 503)
    const response = await fetch(`${app.url}/api/oc/api/model`, { headers: { cookie } })
    expect(response.status).toBe(503)
    expect(upstream.requests.filter((request) => request.path === "/api/model")).toHaveLength(3)
  })

  it("retries idempotent POST switches (agent/model)", async () => {
    upstream = await startMockOpencode()
    app = await startTestApp({ config: { opencodeUrl: upstream.url, opencodeAuth: TEST_AUTH } })
    const cookie = await login(app.url)

    upstream.failNext("/ses_1/model", 1, 503)
    const response = await fetch(`${app.url}/api/oc/api/session/ses_1/model`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ model: { id: "test-model", providerID: "test" } }),
    })
    expect(response.status).toBe(204)
    expect(upstream.requests.filter((request) => request.path === "/api/session/ses_1/model")).toHaveLength(2)
  })

  it("retries a marked prompt and persists it exactly once", async () => {
    upstream = await startMockOpencode()
    app = await startTestApp({ config: { opencodeUrl: upstream.url, opencodeAuth: TEST_AUTH } })
    const cookie = await login(app.url)

    upstream.failNext("/prompt", 2, 429)
    const response = await fetch(`${app.url}/api/oc/api/session/ses_9/prompt`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ text: "hello", metadata: { "masterhand.delivery": "delivery_abc" } }),
    })
    expect(response.status).toBe(200)
    expect(upstream.requests.filter((request) => request.path === "/api/session/ses_9/prompt")).toHaveLength(3)

    const history = await fetch(`${app.url}/api/oc/api/session/ses_9/message`, { headers: { cookie } })
    const body = (await history.json()) as { data: unknown[] }
    expect(body.data).toHaveLength(1)
  })

  it("leaves an unmarked prompt single-shot (slash commands cannot be reconciled)", async () => {
    upstream = await startMockOpencode()
    app = await startTestApp({ config: { opencodeUrl: upstream.url, opencodeAuth: TEST_AUTH } })
    const cookie = await login(app.url)

    upstream.failNext("/prompt", 2, 503)
    const response = await fetch(`${app.url}/api/oc/api/session/ses_9/prompt`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ text: "/review" }),
    })
    expect(response.status).toBe(503)
    expect(upstream.requests.filter((request) => request.path === "/api/session/ses_9/prompt")).toHaveLength(1)
  })

  it("treats a timed-out marked prompt as landed when the marker is in the history", async () => {
    upstream = await startMockOpencode()
    let promptAttempts = 0
    const wrapper: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if ((init?.method ?? "GET") === "POST" && url.endsWith("/prompt")) {
        promptAttempts += 1
        await fetch(input, init)
        // The prompt was applied, but the response never reached the client.
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError")
      }
      return fetch(input, init)
    }
    app = await startTestApp({
      config: { opencodeUrl: upstream.url, opencodeAuth: TEST_AUTH },
      fetchImpl: wrapper,
    })
    const cookie = await login(app.url)

    const response = await fetch(`${app.url}/api/oc/api/session/ses_9/prompt`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ text: "hello", metadata: { "masterhand.delivery": "delivery_lost" } }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ data: { sessionID: "ses_9", delivered: true } })
    expect(promptAttempts).toBe(1)
    expect(upstream.requests.filter((request) => request.path === "/api/session/ses_9/prompt")).toHaveLength(1)
  })

  it("does not replay a marked prompt when the marker lookup is unavailable", async () => {
    upstream = await startMockOpencode()
    let promptAttempts = 0
    const wrapper: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if ((init?.method ?? "GET") === "POST" && url.endsWith("/prompt")) {
        promptAttempts += 1
        // The request never reached opencode.
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError")
      }
      return fetch(input, init)
    }
    app = await startTestApp({
      config: { opencodeUrl: upstream.url, opencodeAuth: TEST_AUTH },
      fetchImpl: wrapper,
    })
    const cookie = await login(app.url)
    // The marker lookup itself is down: the outcome is unknown, never replayed.
    upstream.failNext("/message", 10, 503)

    const response = await fetch(`${app.url}/api/oc/api/session/ses_9/prompt`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ text: "hello", metadata: { "masterhand.delivery": "delivery_unknown" } }),
    })
    expect(response.status).toBe(504)
    expect(promptAttempts).toBe(1)
  })
})

describe("SSE relay", () => {
  it("forwards upstream events to clients", async () => {
    upstream = await startMockOpencode()
    app = await startTestApp({ config: { opencodeUrl: upstream.url, opencodeAuth: TEST_AUTH } })
    const cookie = await login(app.url)

    const response = await fetch(`${app.url}/api/events`, { headers: { cookie } })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")

    await waitFor(() => upstream!.requests.some((request) => request.path === "/api/event"))
    upstream.emit({ id: "evt_42", type: "session.idle", data: { sessionID: "ses_42" } })

    const reader = response.body!.getReader()
    const received = await readUntil(reader, "session.idle")
    expect(received).toContain('"sessionID":"ses_42"')
  })

  it("drops a slow client when its queue overflows instead of buffering every event", async () => {
    upstream = await startMockOpencode()
    app = await startTestApp({
      config: { opencodeUrl: upstream.url, opencodeAuth: TEST_AUTH },
      sseQueueMax: 4,
    })
    const cookie = await login(app.url)
    await waitFor(() => upstream!.requests.some((request) => request.path === "/api/event"))

    // Raw client that never reads its response: TCP backpressure stalls the
    // server-side writes, so only a bounded queue can keep memory flat.
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = httpGet(
        {
          host: "127.0.0.1",
          port: Number(new URL(app!.url).port),
          path: "/api/events",
          headers: { cookie },
        },
        resolve,
      )
      request.on("error", reject)
    })
    expect(response.statusCode).toBe(200)

    try {
      // ~16 MB of frames with the client paused: far more than the kernel/Hono
      // buffers. Yielding lets the server write until the socket backpressures,
      // after which the queue must overflow (cap = 4 for this test).
      const payload = "x".repeat(16 * 1024)
      const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
      for (let i = 0; i < 2048; i += 1) {
        upstream.emit({ id: `evt_${i}`, type: "session.idle", data: { sessionID: "ses_1", i, payload } })
        if (i % 8 === 7) await tick()
      }

      // Drain what the server did manage to write: only a dropped client ends
      // the response. A buffering client never does (the keepalive keeps it open).
      const settled = new Promise<void>((resolve) => {
        response.on("end", resolve)
        response.on("close", resolve)
        response.on("aborted", resolve)
      })
      response.resume()
      await expect(
        Promise.race([
          settled,
          new Promise((_resolve, reject) => setTimeout(() => reject(new Error("slow client was never dropped")), 5000)),
        ]),
      ).resolves.toBeUndefined()
    } finally {
      response.destroy()
    }
  })
})
