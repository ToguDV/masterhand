import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createDevice, login, startTestApp, type TestApp } from "./helpers.js"

let app: TestApp | null = null

afterEach(async () => {
  await app?.close()
  app = null
})

const OTHER_ORIGIN = "https://studio.example.com"
const DESKTOP_ORIGIN = "masterhand://app"

function expectCors(response: Response, status?: number): void {
  if (status !== undefined) expect(response.status).toBe(status)
  expect(response.headers.get("access-control-allow-origin")).toBe("*")
  expect(response.headers.get("access-control-allow-credentials")).toBeNull()
}

describe("bearer-only CORS", () => {
  it("answers preflight before auth with the allowed headers and max-age", async () => {
    app = await startTestApp()
    const response = await fetch(`${app.url}/api/workspaces`, {
      method: "OPTIONS",
      headers: {
        origin: OTHER_ORIGIN,
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization,content-type",
      },
    })

    expectCors(response, 204)
    expect(response.headers.get("access-control-allow-headers")).toBe("Authorization, Content-Type")
    expect(response.headers.get("access-control-allow-methods")).toContain("GET")
    expect(response.headers.get("access-control-allow-methods")).toContain("POST")
    expect(response.headers.get("access-control-max-age")).toBe("600")
    expect(await response.text()).toBe("")
  })

  it("answers preflight for the SSE endpoint without a credential", async () => {
    app = await startTestApp()
    const response = await fetch(`${app.url}/api/events`, {
      method: "OPTIONS",
      headers: { origin: OTHER_ORIGIN, "access-control-request-method": "GET" },
    })
    expectCors(response, 204)
  })

  it("answers preflight for a proxied opencode route before auth", async () => {
    app = await startTestApp()
    const response = await fetch(`${app.url}/api/oc/api/agent`, {
      method: "OPTIONS",
      headers: {
        origin: DESKTOP_ORIGIN,
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
      },
    })

    expectCors(response, 204)
  })

  it("accepts a device token sent from another origin", async () => {
    app = await startTestApp()
    const { token } = await createDevice(app.url)

    const response = await fetch(`${app.url}/api/workspaces`, {
      headers: { origin: OTHER_ORIGIN, authorization: `Bearer ${token}` },
    })

    expectCors(response, 200)
    expect(await response.json()).toEqual({ workspaces: [] })
  })

  it("keeps the 401 body readable cross-origin", async () => {
    app = await startTestApp()
    const response = await fetch(`${app.url}/api/workspaces`, {
      headers: { origin: OTHER_ORIGIN },
    })

    expectCors(response, 401)
    expect(await response.json()).toEqual({ error: "unauthorized" })
  })

  it("keeps CORS on rate-limited device-login responses", async () => {
    app = await startTestApp()
    for (let attempt = 0; attempt < 5; attempt++) {
      await fetch(`${app.url}/api/devices`, {
        method: "POST",
        headers: { origin: OTHER_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ password: "wrong", name: "Remote" }),
      })
    }
    const limited = await fetch(`${app.url}/api/devices`, {
      method: "POST",
      headers: { origin: OTHER_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ password: "wrong", name: "Remote" }),
    })

    expectCors(limited, 429)
    expect(await limited.json()).toEqual({ error: "too_many_attempts" })
  })

  it("allows cross-origin device login (the remote-server flow)", async () => {
    app = await startTestApp()
    const response = await fetch(`${app.url}/api/devices`, {
      method: "POST",
      headers: { origin: OTHER_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ password: "secret", name: "Remote", installID: "install-cors" }),
    })

    expectCors(response, 201)
    const body = (await response.json()) as { token: string }
    expect(body.token).toEqual(expect.any(String))
  })

  it("keeps CORS on 5xx error responses", async () => {
    app = await startTestApp({
      diskFreeBytes: () => {
        throw new Error("boom")
      },
    })
    const cookie = await login(app.url)
    const response = await fetch(`${app.url}/api/status`, {
      headers: { origin: OTHER_ORIGIN, cookie },
    })

    expectCors(response, 500)
    expect(await response.json()).toEqual({ error: "internal_error" })
  })

  it("keeps CORS on the SSE stream", async () => {
    app = await startTestApp()
    const { token } = await createDevice(app.url)
    const controller = new AbortController()
    const response = await fetch(`${app.url}/api/events`, {
      headers: { origin: OTHER_ORIGIN, authorization: `Bearer ${token}`, accept: "text/event-stream" },
      signal: controller.signal,
    })

    expectCors(response, 200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    controller.abort()
    await response.body?.cancel().catch(() => {})
  })

  it("keeps CORS on raw proxy success responses (opencode pass-through)", async () => {
    app = await startTestApp({
      proxyRetry: { attempts: 1, baseDelayMs: 1, jitter: false },
      fetchImpl: async (input) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        if (url.pathname === "/api/agent") {
          return new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }
        return new Response(JSON.stringify({ error: "not_found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        })
      },
    })
    const { token } = await createDevice(app.url)

    const response = await fetch(`${app.url}/api/oc/api/agent`, {
      headers: { origin: DESKTOP_ORIGIN, authorization: `Bearer ${token}` },
    })

    expectCors(response, 200)
    expect(await response.json()).toEqual({ data: [] })
  })

  it("keeps CORS on raw upstream error responses", async () => {
    app = await startTestApp({
      proxyRetry: { attempts: 1, baseDelayMs: 1, jitter: false },
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: "upstream_failed" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    })
    const { token } = await createDevice(app.url)

    const response = await fetch(`${app.url}/api/oc/api/agent`, {
      headers: { origin: DESKTOP_ORIGIN, authorization: `Bearer ${token}` },
    })

    expectCors(response, 400)
    expect(await response.json()).toEqual({ error: "upstream_failed" })
  })

  it("keeps CORS on attachment downloads (raw stream response)", async () => {
    const root = mkdtempSync(join(tmpdir(), "masterhand-cors-"))
    try {
      const workspacePath = join(root, "app")
      mkdirSync(workspacePath, { recursive: true })
      app = await startTestApp({ config: { workspacesRoot: root } })
      app.store.createWorkspace({ id: "ws_cors", name: "app", path: workspacePath, createdAt: Date.now() })
      const { token } = await createDevice(app.url)

      const form = new FormData()
      form.set("sessionID", "ses_cors")
      form.set("attachmentID", "a1")
      form.set("file", new File(["hello"], "notes.txt", { type: "text/plain" }))
      const upload = await fetch(`${app.url}/api/workspaces/ws_cors/attachments`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: form,
      })
      expect(upload.status).toBe(201)

      const response = await fetch(`${app.url}/api/workspaces/ws_cors/attachments/ses_cors/a1`, {
        headers: { origin: DESKTOP_ORIGIN, authorization: `Bearer ${token}` },
      })

      expectCors(response, 200)
      expect(await response.text()).toBe("hello")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("still rejects a cross-origin cookie mutation (CSRF unchanged)", async () => {
    app = await startTestApp()
    const cookie = await login(app.url)
    const response = await fetch(`${app.url}/api/workspaces`, {
      method: "POST",
      headers: { origin: OTHER_ORIGIN, cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "nope" }),
    })

    expectCors(response, 403)
    expect(await response.json()).toEqual({ error: "forbidden" })
  })
})
