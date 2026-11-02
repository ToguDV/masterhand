import { afterEach, describe, expect, it, vi } from "vitest"
import { GithubError, type GithubIntegration, type GithubStatus } from "../src/github.js"
import { login, startTestApp, type TestApp } from "./helpers.js"

let app: TestApp | null = null

afterEach(async () => {
  await app?.close()
  app = null
})

const DISCONNECTED: GithubStatus = {
  connected: false,
  login: null,
  name: null,
  avatarUrl: null,
  scopes: [],
  updatedAt: null,
  injected: false,
  agentConfigError: null,
}

function fakeGithub(): GithubIntegration & { connected: string[] } {
  const connected: string[] = []
  let status = DISCONNECTED
  return {
    connected,
    status: () => status,
    async connect(token) {
      connected.push(token)
      status = {
        ...DISCONNECTED,
        connected: true,
        login: "octocat",
        name: "Octo Cat",
        avatarUrl: "https://example/avatar.png",
        scopes: ["repo"],
        updatedAt: "2026-01-01T00:00:00.000Z",
        injected: true,
      }
      return status
    },
    async disconnect() {
      status = DISCONNECTED
      return status
    },
    async materialize() {},
  }
}

describe("/api/github", () => {
  it("requires authentication and never exposes the token", async () => {
    app = await startTestApp({ github: fakeGithub() })
    const unauth = await fetch(`${app.url}/api/github`)
    expect(unauth.status).toBe(401)

    const cookie = await login(app.url)
    const response = await fetch(`${app.url}/api/github`, { headers: { cookie } })
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body).toMatchObject({ connected: false })
    expect(JSON.stringify(body)).not.toContain("token")
  })

  it("connects, reports the account and disconnects", async () => {
    const github = fakeGithub()
    app = await startTestApp({ github })
    const cookie = await login(app.url)

    const invalid = await fetch(`${app.url}/api/github`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ token: "" }),
    })
    expect(invalid.status).toBe(400)

    const connected = await fetch(`${app.url}/api/github`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ token: "ghp_abcdefghijklmnopqrstuvwxyz" }),
    })
    const connectedBody = await connected.text()
    expect(connected.status, connectedBody).toBe(200)
    const body = JSON.parse(connectedBody) as Record<string, unknown>
    expect(body).toMatchObject({ connected: true, login: "octocat", injected: true })
    expect(JSON.stringify(body)).not.toContain("ghp_")
    expect(github.connected).toEqual(["ghp_abcdefghijklmnopqrstuvwxyz"])

    const removed = await fetch(`${app.url}/api/github`, { method: "DELETE", headers: { cookie } })
    expect(removed.status).toBe(200)
    expect(await removed.json()).toMatchObject({ connected: false })
  })

  it("maps a rejected token to 400 without leaking it", async () => {
    const github: GithubIntegration = {
      ...fakeGithub(),
      connect: vi.fn(async () => {
        throw new GithubError("invalid_token", 400, "GitHub rejected this token.")
      }),
    }
    app = await startTestApp({ github })
    const cookie = await login(app.url)
    const response = await fetch(`${app.url}/api/github`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ token: "ghp_abcdefghijklmnopqrstuvwxyz" }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "invalid_token" })
  })
})
