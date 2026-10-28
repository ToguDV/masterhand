import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createCustomProviderStore } from "../src/providers.js"
import { login, startTestApp } from "./helpers.js"

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "masterhand-custom-routes-"))
  dirs.push(dir)
  const providers = createCustomProviderStore({ file: join(dir, "providers.json") })
  const calls: string[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`)
    if (url.pathname.endsWith("/connect/key") && init?.method === "POST") {
      return new Response(null, { status: 204 })
    }
    if (/^\/api\/integration\/[^/]+$/.test(url.pathname)) {
      return Response.json({
        location: { directory: "/" },
        data: { id: "acme", name: "Acme", methods: [{ type: "key" }], connections: [] },
      })
    }
    return new Response(JSON.stringify({ error: "not_found" }), { status: 404 })
  }
  const app = await startTestApp({ providers, fetchImpl })
  const cookie = await login(app.url)
  return { app, providers, calls, headers: { cookie, "content-type": "application/json" } }
}

const input = {
  id: "acme",
  name: "Acme",
  baseURL: "https://api.acme.example/v1",
  models: [{ id: "m1", name: "Model One" }],
}

describe("/api/providers/custom ", () => {
  it("creates a provider and connects the key in one call", async () => {
    const { app, calls, headers } = await setup()
    try {
      const response = await fetch(`${app.url}/api/providers/custom`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...input, key: "sk-secret" }),
      })
      expect(response.status).toBe(201)
      const body = (await response.json()) as { provider: { id: string }; connected: boolean }
      expect(body.provider.id).toBe("acme")
      expect(body.connected).toBe(true)
      expect(calls).toContain("POST /api/integration/acme/connect/key")

      const list = (await (await fetch(`${app.url}/api/providers/custom`, { headers })).json()) as {
        providers: Array<{ id: string }>
      }
      expect(list.providers.map((provider) => provider.id)).toEqual(["acme"])
    } finally {
      await app.close()
    }
  })

  it("rejects an invalid payload", async () => {
    const { app, headers } = await setup()
    try {
      const response = await fetch(`${app.url}/api/providers/custom`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...input, baseURL: "not-a-url" }),
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: "invalid_base_url" })
    } finally {
      await app.close()
    }
  })

  it("keeps the provider when opencode cannot connect the key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "masterhand-custom-routes-"))
    dirs.push(dir)
    const providers = createCustomProviderStore({ file: join(dir, "providers.json") })
    const fetchImpl: typeof fetch = async () => new Response(null, { status: 404 })
    const app = await startTestApp({ providers, fetchImpl })
    const cookie = await login(app.url)
    try {
      const response = await fetch(`${app.url}/api/providers/custom`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ ...input, key: "sk-secret" }),
      })
      expect(response.status).toBe(201)
      expect((await response.json()) as { connected: boolean }).toMatchObject({ connected: false })
      const list = (await (await fetch(`${app.url}/api/providers/custom`, { headers: { cookie } })).json()) as {
        providers: unknown[]
      }
      expect(list.providers).toHaveLength(1)
    } finally {
      await app.close()
    }
  })

  it("removes a provider and its credentials", async () => {
    const { app, calls, headers } = await setup()
    try {
      await fetch(`${app.url}/api/providers/custom`, {
        method: "POST",
        headers,
        body: JSON.stringify(input),
      })
      const response = await fetch(`${app.url}/api/providers/custom/acme`, { method: "DELETE", headers })
      expect(response.status).toBe(200)
      expect(calls).toContain("GET /api/integration/acme")
      const list = (await (await fetch(`${app.url}/api/providers/custom`, { headers })).json()) as {
        providers: unknown[]
      }
      expect(list.providers).toEqual([])
    } finally {
      await app.close()
    }
  })
})

describe("/api/providers/custom/models ", () => {
  async function setup(fetchImpl: typeof fetch) {
    const dir = await mkdtemp(join(tmpdir(), "masterhand-custom-routes-"))
    dirs.push(dir)
    const providers = createCustomProviderStore({ file: join(dir, "providers.json") })
    const app = await startTestApp({ providers, fetchImpl })
    const cookie = await login(app.url)
    return { app, headers: { cookie, "content-type": "application/json" } }
  }

  it("discovers models and forwards the transient key", async () => {
    let seen: { url: string; auth: string | null } | null = null
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      seen = { url: String(input), auth: new Headers(init?.headers).get("authorization") }
      return Response.json({ data: [{ id: "acme-coder", name: "Acme Coder" }, { id: "acme-mini" }] })
    }) as typeof fetch
    const { app, headers } = await setup(fetchImpl)
    try {
      const response = await fetch(`${app.url}/api/providers/custom/models`, {
        method: "POST",
        headers,
        body: JSON.stringify({ baseURL: "https://api.acme.example/v1", key: "sk-secret" }),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        models: [{ id: "acme-coder", name: "Acme Coder" }, { id: "acme-mini" }],
      })
      expect(seen!.url).toBe("https://api.acme.example/v1/models")
      expect(seen!.auth).toBe("Bearer sk-secret")
    } finally {
      await app.close()
    }
  })

  it("rejects an invalid base URL without calling the provider", async () => {
    let called = false
    const fetchImpl = (async () => {
      called = true
      return Response.json({ data: [] })
    }) as typeof fetch
    const { app, headers } = await setup(fetchImpl)
    try {
      const response = await fetch(`${app.url}/api/providers/custom/models`, {
        method: "POST",
        headers,
        body: JSON.stringify({ baseURL: "not-a-url" }),
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: "invalid_base_url" })
      expect(called).toBe(false)
    } finally {
      await app.close()
    }
  })

  it("refuses loopback and link-local metadata targets without calling them", async () => {
    let called = false
    const fetchImpl = (async () => {
      called = true
      return Response.json({ data: [] })
    }) as typeof fetch
    const { app, headers } = await setup(fetchImpl)
    try {
      for (const baseURL of ["http://169.254.169.254/latest/meta-data", "http://[::1]:8080/v1"]) {
        const response = await fetch(`${app.url}/api/providers/custom/models`, {
          method: "POST",
          headers,
          body: JSON.stringify({ baseURL, key: "sk-secret" }),
        })
        // A blocked target is invalid caller input, not an upstream failure.
        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: "invalid_base_url" })
      }
      expect(called).toBe(false)
    } finally {
      await app.close()
    }
  })

  it("maps a rejected key to a typed upstream error", async () => {
    const fetchImpl = (async () => new Response(null, { status: 401 })) as typeof fetch
    const { app, headers } = await setup(fetchImpl)
    try {
      const response = await fetch(`${app.url}/api/providers/custom/models`, {
        method: "POST",
        headers,
        body: JSON.stringify({ baseURL: "https://api.acme.example/v1", key: "bad" }),
      })
      expect(response.status).toBe(502)
      expect(await response.json()).toEqual({ error: "provider_unauthorized" })
    } finally {
      await app.close()
    }
  })
})

describe("connect-key budget (issue #194)", () => {
  /** opencode answers 404 slowly: each attempt can burn the whole per-call timeout. */
  function slow404Fetch(latencyMs: number, onAttempt: () => void): typeof fetch {
    return ((input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const url = new URL(String(input))
        if (url.pathname.endsWith("/connect/key") && (init?.method ?? "GET") === "POST") {
          onAttempt()
          const timer = setTimeout(() => resolve(new Response(null, { status: 404 })), latencyMs)
          const abort = (): void => {
            clearTimeout(timer)
            reject(new DOMException("The operation was aborted.", "AbortError"))
          }
          if (init?.signal?.aborted) {
            abort()
            return
          }
          init?.signal?.addEventListener("abort", abort, { once: true })
          return
        }
        resolve(new Response(null, { status: 404 }))
      })) as typeof fetch
  }

  it(
    "bounds the whole connect loop instead of stacking per-attempt timeouts",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "masterhand-connect-budget-"))
      dirs.push(dir)
      const providers = createCustomProviderStore({ file: join(dir, "providers.json") })
      let attempts = 0
      const app = await startTestApp({
        providers,
        fetchImpl: slow404Fetch(1000, () => void (attempts += 1)),
        connectKeyBudgetMs: 1500,
      })
      const cookie = await login(app.url)
      try {
        const started = Date.now()
        const response = await fetch(`${app.url}/api/providers/custom`, {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ ...input, key: "sk-secret" }),
        })
        const elapsed = Date.now() - started
        // The provider write is the mutation; the shape is unchanged.
        expect(response.status).toBe(201)
        expect(await response.json()).toMatchObject({ connected: false })
        // 10 attempts × (1 s + 0.4 s sleep) ≈ 14 s without the budget.
        expect(attempts).toBeLessThan(10)
        expect(elapsed).toBeLessThan(8000)
      } finally {
        await app.close()
      }
    },
    30_000,
  )

  it("never logs the provider key while connecting", async () => {
    const { app, headers } = await setup()
    const logged: string[] = []
    const warn = console.warn
    const error = console.error
    console.warn = (...args: unknown[]) => void logged.push(args.map(String).join(" "))
    console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "))
    try {
      const response = await fetch(`${app.url}/api/providers/custom`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...input, key: "sk-never-log-me" }),
      })
      expect(response.status).toBe(201)
      expect(logged.join("\n")).not.toContain("sk-never-log-me")
    } finally {
      console.warn = warn
      console.error = error
      await app.close()
    }
  })
})
