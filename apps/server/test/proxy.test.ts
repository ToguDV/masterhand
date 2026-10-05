import { get as httpGet, type IncomingMessage } from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import type { Config } from "../src/config.js"
import { createOpencodeProxy } from "../src/proxy.js"
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

describe("opencode proxy", () => {
  it("proxies GET and injects basic auth", async () => {
    upstream = await startMockOpencode()
    app = await startTestApp({ config: { opencodeUrl: upstream.url, opencodeAuth: TEST_AUTH } })
    const cookie = await login(app.url)

    const response = await fetch(`${app.url}/api/oc/api/info`, { headers: { cookie } })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ version: "1.2.3" })

    const proxied = upstream.requests.find((request) => request.path === "/api/info")
    expect(proxied?.authorization).toBe(TEST_AUTH)
  })

  it("proxies POST with a body and preserves the status", async () => {
    upstream = await startMockOpencode()
    app = await startTestApp({ config: { opencodeUrl: upstream.url, opencodeAuth: TEST_AUTH } })
    const cookie = await login(app.url)

    const response = await fetch(`${app.url}/api/oc/api/session/ses_1/prompt_async`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text: "hello" }] }),
    })
    expect(response.status).toBe(204)

    const proxied = upstream.requests.find((request) => request.path.includes("prompt_async"))
    expect(proxied).toBeDefined()
    // v2 no longer injects a `system` instruction: the body is byte-identical.
    expect(JSON.parse(proxied?.body ?? "{}")).toEqual({ parts: [{ type: "text", text: "hello" }] })
  })

  it("leaves an existing system prompt untouched", async () => {
    upstream = await startMockOpencode()
    app = await startTestApp({ config: { opencodeUrl: upstream.url } })
    const cookie = await login(app.url)

    await fetch(`${app.url}/api/oc/api/session/ses_7/message`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text: "hi" }], system: "Be terse." }),
    })

    const proxied = upstream.requests.find((request) => request.path.includes("/message"))
    expect(JSON.parse(proxied?.body ?? "{}")).toEqual({
      parts: [{ type: "text", text: "hi" }],
      system: "Be terse.",
    })
  })

  it("forwards the query string and allowed headers, but not the directory header", async () => {
    upstream = await startMockOpencode()
    app = await startTestApp({ config: { opencodeUrl: upstream.url, opencodeAuth: TEST_AUTH } })
    const cookie = await login(app.url)

    await fetch(`${app.url}/api/oc/api/session?directory=%2Fworkspace%2Fapp&limit=200`, {
      headers: { cookie, "x-opencode-directory": "/workspace/app", "accept-language": "es-ES" },
    })

    const proxied = upstream.requests.find((request) => request.path === "/api/session")
    expect(proxied?.query).toBe("directory=%2Fworkspace%2Fapp&limit=200")
    expect(proxied?.headers["accept-language"]).toBe("es-ES")
    expect(proxied?.headers["x-opencode-directory"]).toBeUndefined()
    expect(proxied?.authorization).toBe(TEST_AUTH)
  })

  it("requires authentication to proxy", async () => {
    upstream = await startMockOpencode()
    app = await startTestApp({ config: { opencodeUrl: upstream.url, opencodeAuth: TEST_AUTH } })

    const response = await fetch(`${app.url}/api/oc/api/info`)
    expect(response.status).toBe(401)
  })

  it("responds 502 when opencode is unavailable", async () => {
    app = await startTestApp({ config: { opencodeUrl: "http://127.0.0.1:1" } })
    const cookie = await login(app.url)

    const response = await fetch(`${app.url}/api/oc/api/info`, { headers: { cookie } })
    expect(response.status).toBe(502)
  })

  it("maps an opencode 401 to an actionable 502 instead of relaying it", async () => {
    const stub: typeof fetch = async () => new Response("unauthorized", { status: 401 })
    app = await startTestApp({ fetchImpl: stub })
    const cookie = await login(app.url)

    const response = await fetch(`${app.url}/api/oc/api/session`, { headers: { cookie } })
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: "opencode_unauthorized" })
  })

  it("keeps the upstream origin fixed for protocol-relative paths (SSRF)", async () => {
    const seen: string[] = []
    const stub: typeof fetch = async (input) => {
      seen.push(
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
      )
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    app = await startTestApp({ config: { opencodeUrl: "http://127.0.0.1:4096" }, fetchImpl: stub })
    const cookie = await login(app.url)

    const response = await fetch(`${app.url}/api/oc//evil.example.com/steal`, { headers: { cookie } })
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
        url: "http://test/api/oc/api/info",
        path: "/api/oc/api/info",
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
