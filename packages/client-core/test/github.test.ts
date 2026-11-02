import { describe, expect, it } from "vitest"
import { createClient } from "../src/client"
import { DISCONNECTED_GITHUB, normalizeGithubStatus } from "../src/github"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

describe("normalizeGithubStatus", () => {
  it("reads the connected account without accepting a token field", () => {
    expect(
      normalizeGithubStatus({
        connected: true,
        login: "octocat",
        name: "Octo Cat",
        avatarUrl: "https://example/avatar.png",
        scopes: ["repo", 42],
        updatedAt: "2026-01-01T00:00:00.000Z",
        injected: true,
        agentConfigError: null,
        token: "must be ignored",
      }),
    ).toEqual({
      connected: true,
      login: "octocat",
      name: "Octo Cat",
      avatarUrl: "https://example/avatar.png",
      scopes: ["repo"],
      updatedAt: "2026-01-01T00:00:00.000Z",
      injected: true,
      agentConfigError: null,
    })
  })

  it("falls back to disconnected for malformed or older responses", () => {
    for (const value of [null, {}, { connected: false }, { connected: true, login: "" }]) {
      const status = normalizeGithubStatus(value)
      if (value && (value as { connected?: unknown }).connected === true) {
        expect(status.connected).toBe(true)
      } else {
        expect(status).toEqual(DISCONNECTED_GITHUB)
      }
    }
    expect(normalizeGithubStatus(null)).toEqual(DISCONNECTED_GITHUB)
  })
})

describe("GitHub client", () => {
  it("targets the status, connect and disconnect routes", async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = []
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body as string | undefined })
      if (init?.method === "PUT") {
        return jsonResponse({
          connected: true,
          login: "octocat",
          name: null,
          avatarUrl: null,
          scopes: [],
          updatedAt: "2026-01-01T00:00:00.000Z",
          injected: true,
          agentConfigError: null,
        })
      }
      return jsonResponse(DISCONNECTED_GITHUB)
    }) as unknown as typeof fetch

    const client = createClient({ baseUrl: "https://masterhand.test", fetchImpl })
    expect(await client.github.status()).toEqual(DISCONNECTED_GITHUB)
    const connected = await client.github.connect("ghp_abcdefghijklmnopqrstuvwxyz")
    expect(connected.connected).toBe(true)
    expect(await client.github.disconnect()).toEqual(DISCONNECTED_GITHUB)

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET https://masterhand.test/api/github",
      "PUT https://masterhand.test/api/github",
      "DELETE https://masterhand.test/api/github",
    ])
    expect(JSON.parse(calls[1]?.body ?? "{}")).toEqual({ token: "ghp_abcdefghijklmnopqrstuvwxyz" })
  })
})
