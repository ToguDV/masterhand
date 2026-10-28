import { afterEach, describe, expect, it } from "vitest"
import { createDevice, login, startTestApp, type TestApp } from "./helpers.js"

let app: TestApp | null = null

afterEach(async () => {
  await app?.close()
  app = null
})

describe("cookie auth", () => {
  it("exposes /api/health without authentication", async () => {
    app = await startTestApp()
    const response = await fetch(`${app.url}/api/health`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, ready: true })
  })

  it("rejects protected routes without credentials", async () => {
    app = await startTestApp()
    const response = await fetch(`${app.url}/api/status`)
    expect(response.status).toBe(401)
  })

  it("rejects a wrong password", async () => {
    app = await startTestApp()
    const response = await fetch(`${app.url}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "wrong" }),
    })
    expect(response.status).toBe(401)
  })

  it("issues an HttpOnly cookie with the right password and grants access", async () => {
    app = await startTestApp()
    const response = await fetch(`${app.url}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "secret" }),
    })
    expect(response.status).toBe(200)

    const setCookie = response.headers.getSetCookie()[0] ?? ""
    expect(setCookie).toContain("mh_session=")
    expect(setCookie).toContain("HttpOnly")
    expect(setCookie).toContain("SameSite=Strict")

    const cookie = setCookie.split(";")[0] ?? ""
    const status = await fetch(`${app.url}/api/status`, { headers: { cookie } })
    expect(status.status).toBe(200)
    const body = (await status.json()) as { ok: boolean; opencode: { healthy: boolean } }
    expect(body.ok).toBe(true)
    expect(body.opencode.healthy).toBe(false)
  })

  it("logout clears the cookie", async () => {
    app = await startTestApp()
    const cookie = await login(app.url)
    const response = await fetch(`${app.url}/api/logout`, { method: "POST", headers: { cookie } })
    expect(response.status).toBe(200)
    const setCookie = response.headers.getSetCookie()[0] ?? ""
    expect(setCookie).toContain("mh_session=")
  })

  it("rate limits failed logins but accepts the correct password", async () => {
    app = await startTestApp()
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await fetch(`${app.url}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "wrong" }),
      })
      expect(response.status).toBe(401)
    }
    const blocked = await fetch(`${app.url}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "wrong" }),
    })
    expect(blocked.status).toBe(429)

    // A correct password is always verified first (issue #181).
    const correct = await fetch(`${app.url}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "secret" }),
    })
    expect(correct.status).toBe(200)
  })

  it("rejects mutations from a foreign origin", async () => {
    app = await startTestApp()
    const response = await fetch(`${app.url}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://malicious.example" },
      body: JSON.stringify({ password: "secret" }),
    })
    expect(response.status).toBe(403)
  })

  it("allows origins listed in ALLOWED_ORIGINS (dev proxy)", async () => {
    app = await startTestApp({ config: { allowedOrigins: ["http://localhost:5173"] } })
    const response = await fetch(`${app.url}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({ password: "secret" }),
    })
    expect(response.status).toBe(200)
  })
})

describe("device tokens", () => {
  it("issues a token for a named device", async () => {
    app = await startTestApp()
    const { token, device } = await createDevice(app.url, "Pixel 9")
    expect(token.split(".")).toHaveLength(2)
    expect(device).toMatchObject({ name: "Pixel 9" })
    expect(app.store.list()).toHaveLength(1)
  })

  it("grants access to protected routes with a Bearer token", async () => {
    app = await startTestApp()
    const { token } = await createDevice(app.url)
    const response = await fetch(`${app.url}/api/status`, { headers: { authorization: `Bearer ${token}` } })
    expect(response.status).toBe(200)
  })

  it("rejects a wrong password", async () => {
    app = await startTestApp()
    const response = await fetch(`${app.url}/api/devices`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "wrong", name: "Phone" }),
    })
    expect(response.status).toBe(401)
    expect(app.store.list()).toHaveLength(0)
  })

  it("rejects a revoked device token", async () => {
    app = await startTestApp()
    const { token, device } = await createDevice(app.url)
    const cookie = await login(app.url)

    const devices = await fetch(`${app.url}/api/devices`, { headers: { cookie } })
    expect(devices.status).toBe(200)
    expect(((await devices.json()) as { devices: unknown[] }).devices).toHaveLength(1)

    const revoke = await fetch(`${app.url}/api/devices/${device.id}`, { method: "DELETE", headers: { cookie } })
    expect(revoke.status).toBe(200)

    const status = await fetch(`${app.url}/api/status`, { headers: { authorization: `Bearer ${token}` } })
    expect(status.status).toBe(401)
  })

  it("rejects a forged token", async () => {
    app = await startTestApp()
    const { token } = await createDevice(app.url)
    const forged = `${token.split(".")[0]}.deadbeef`
    const response = await fetch(`${app.url}/api/status`, { headers: { authorization: `Bearer ${forged}` } })
    expect(response.status).toBe(401)
  })

  it("does not require same-origin for Bearer requests (no CSRF risk)", async () => {
    app = await startTestApp()
    const { token } = await createDevice(app.url)
    const response = await fetch(`${app.url}/api/oc/api/session/ses_1/interrupt`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, origin: "https://mobile.example" },
    })
    expect(response.status).toBe(502)
  })

  it("denies proxied paths outside the client allowlist", async () => {
    app = await startTestApp()
    const cookie = await login(app.url)
    const response = await fetch(`${app.url}/api/oc/global/health`, { headers: { cookie } })
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: "not_found" })
  })
})
