import { afterEach, describe, expect, it, vi } from "vitest"
import { compareSemver, isNewerVersion } from "../src/update.js"
import { login, startMockOpencode, startTestApp, type MockOpencode, type TestApp } from "./helpers.js"

let app: TestApp | null = null
let upstream: MockOpencode | null = null

afterEach(async () => {
  await app?.close()
  await upstream?.close()
  app = null
  upstream = null
})

async function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  const cookie = await login(app!.url)
  return fetch(`${app!.url}${path}`, {
    ...init,
    headers: { ...init?.headers, cookie },
  })
}

describe("semver comparison for updates", () => {
  it("compares numerically and treats unknown versions as equal", () => {
    expect(compareSemver("0.1.0", "0.2.0")).toBe(-1)
    expect(compareSemver("0.10.0", "0.9.0")).toBe(1)
    expect(compareSemver("v1.2.3", "1.2.3")).toBe(0)
    expect(compareSemver("nope", "1.0.0")).toBe(0)
    expect(isNewerVersion("0.1.0", "0.1.1")).toBe(true)
    expect(isNewerVersion("0.1.1", "0.1.0")).toBe(false)
    expect(isNewerVersion("0.1.0", "nope")).toBe(false)
  })
})

describe("/api/status version fields (#131)", () => {  it("reports the configured version and build", async () => {
    upstream = await startMockOpencode()
    app = await startTestApp({
      config: { opencodeUrl: upstream.url, version: "0.2.0", build: "abc1234" },
    })
    const response = await authedFetch("/api/status")
    expect(response.ok).toBe(true)
    const body = (await response.json()) as { version?: string; build?: string }
    expect(body.version).toBe("0.2.0")
    expect(body.build).toBe("abc1234")
  })
})

describe("GET /api/update (#131)", () => {
  it("answers latest:null when the manifest cannot be fetched (never an error state)", async () => {
    upstream = await startMockOpencode()
    app = await startTestApp({
      config: {
        opencodeUrl: upstream.url,
        updateManifestUrl: "http://127.0.0.1:1/version.json",
        updateCacheMs: 0,
      },
      fetchImpl: (async () => {
        throw new Error("unreachable")
      }) as typeof fetch,
    })
    const response = await authedFetch("/api/update")
    expect(response.ok).toBe(true)
    const body = (await response.json()) as { latest: unknown }
    expect(body.latest).toBeNull()
  })

  it("returns the normalized manifest and caches it behind the TTL", async () => {
    upstream = await startMockOpencode()
    let calls = 0
    const manifest = {
      version: "0.2.0",
      tag: "v0.2.0",
      publishedAt: "2026-10-29T00:00:00.000Z",
      notes: "Bug fixes",
    }
    app = await startTestApp({
      config: { opencodeUrl: upstream.url, updateCacheMs: 12 * 60 * 1000 },
      fetchImpl: (async () => {
        calls += 1
        return new Response(JSON.stringify(manifest), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }) as typeof fetch,
    })
    const first = (await (await authedFetch("/api/update")).json()) as { latest: unknown }
    const second = (await (await authedFetch("/api/update")).json()) as { latest: unknown }
    expect(first.latest).toEqual(manifest)
    expect(second.latest).toEqual(manifest)
    expect(calls).toBe(1)
  })

  it("answers latest:null on a malformed manifest instead of a 500", async () => {
    upstream = await startMockOpencode()
    app = await startTestApp({
      config: { opencodeUrl: upstream.url, updateCacheMs: 0 },
      fetchImpl: (async () =>
        new Response(JSON.stringify({ nope: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    })
    const response = await authedFetch("/api/update")
    expect(response.ok).toBe(true)
    expect(((await response.json()) as { latest: unknown }).latest).toBeNull()
  })
})

describe("POST /api/update/apply (#134)", () => {
  it("reports updater capability in /api/status and accepts an update", async () => {
    upstream = await startMockOpencode()
    const apply = vi.fn(async () => ({ ok: true as const, target: "0.2.0" }))
    app = await startTestApp({
      config: { opencodeUrl: upstream.url },
      updateApplier: { enabled: true, tracksLatest: true, apply },
    })

    const status = (await (await authedFetch("/api/status")).json()) as {
      updater?: { enabled: boolean; tracksLatest: boolean }
    }
    expect(status.updater).toEqual({ enabled: true, tracksLatest: true, track: "latest" })

    const response = await authedFetch("/api/update/apply", { method: "POST" })
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ accepted: true, target: "0.2.0" })
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it("maps disabled, unavailable and in-flight outcomes", async () => {
    upstream = await startMockOpencode()
    app = await startTestApp({
      config: { opencodeUrl: upstream.url },
      updateApplier: {
        enabled: false,
        tracksLatest: true,
        apply: async () => ({ ok: false, error: "updater_disabled", status: 409 }),
      },
    })

    const status = (await (await authedFetch("/api/status")).json()) as {
      updater?: { enabled: boolean; tracksLatest: boolean }
    }
    expect(status.updater).toEqual({ enabled: false, tracksLatest: true, track: "latest" })

    const response = await authedFetch("/api/update/apply", { method: "POST" })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: "updater_disabled" })
  })

  it("requires authentication", async () => {
    upstream = await startMockOpencode()
    app = await startTestApp({
      config: { opencodeUrl: upstream.url },
      updateApplier: { enabled: true, tracksLatest: true, apply: async () => ({ ok: false, error: "update_in_progress", status: 409 }) },
    })

    const response = await fetch(`${app.url}/api/update/apply`, { method: "POST" })
    expect(response.status).toBe(401)
  })
})
