import { afterEach, describe, expect, it } from "vitest"
import { createDevice, login, startTestApp, type TestApp } from "./helpers.js"

let app: TestApp | null = null

afterEach(async () => {
  await app?.close()
  app = null
})

const OTHER_ORIGIN = "https://studio.example.com"

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
