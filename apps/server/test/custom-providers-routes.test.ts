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
