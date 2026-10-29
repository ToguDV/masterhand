import { afterEach, describe, expect, it } from "vitest"
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

describe("/api/status version fields (#131)", () => {
  it("reports the configured version and build", async () => {
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
