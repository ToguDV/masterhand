import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  CustomProvidersFileError,
  DEFAULT_WEBSEARCH_PROVIDER,
  createCustomProviderStore,
  ensureWebsearchDefault,
  fetchProviderModels,
  parseModelsResponse,
  validateCustomProvider,
  validateDiscoverInput,
  validateWebsearchSelection,
  type CustomProvider,
} from "../src/providers.js"

const dirs: string[] = []

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "masterhand-providers-"))
  dirs.push(dir)
  return join(dir, "masterhand-providers.json")
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const validInput = {
  id: "acme",
  name: "Acme",
  baseURL: "https://api.acme.example/v1",
  models: [{ id: "m1", name: "Model One" }],
}

describe("validateCustomProvider ", () => {
  it("accepts a minimal OpenAI-compatible provider and defaults the package", () => {
    const result = validateCustomProvider(validInput)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.provider).toEqual({
      id: "acme",
      name: "Acme",
      baseURL: "https://api.acme.example/v1",
      package: "openai-compatible",
      models: [{ id: "m1", name: "Model One" }],
    })
  })

  it("keeps headers and paired model limits", () => {
    const result = validateCustomProvider({
      ...validInput,
      package: "openai",
      headers: { "X-Key": "value" },
      models: [{ id: "m1", context: 128000, output: 4096 }],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.provider.package).toBe("openai")
    expect(result.provider.headers).toEqual({ "X-Key": "value" })
    expect(result.provider.models[0]).toEqual({ id: "m1", context: 128000, output: 4096 })
  })

  it("drops a lone limit (opencode requires context and output together)", () => {
    const result = validateCustomProvider({ ...validInput, models: [{ id: "m1", context: 128000 }] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.provider.models[0]).toEqual({ id: "m1" })
  })

  it("rejects invalid ids, names, urls, models and headers", () => {
    expect(validateCustomProvider({ ...validInput, id: "Bad Id" })).toEqual({ ok: false, error: "invalid_id" })
    expect(validateCustomProvider({ ...validInput, name: "  " })).toEqual({ ok: false, error: "invalid_name" })
    expect(validateCustomProvider({ ...validInput, baseURL: "ftp://x" })).toEqual({
      ok: false,
      error: "invalid_base_url",
    })
    expect(validateCustomProvider({ ...validInput, models: [] })).toEqual({ ok: false, error: "invalid_models" })
    expect(validateCustomProvider({ ...validInput, models: [{ id: "m1" }, { id: "m1" }] })).toEqual({
      ok: false,
      error: "invalid_models",
    })
    expect(validateCustomProvider({ ...validInput, headers: { "X": "line\nbreak" } })).toEqual({
      ok: false,
      error: "invalid_headers",
    })
    expect(validateCustomProvider({ ...validInput, package: "anthropic" })).toEqual({
      ok: false,
      error: "invalid_package",
    })
    expect(validateCustomProvider(null)).toEqual({ ok: false, error: "invalid_body" })
  })

  it("accepts a discovered-size list up to the cap and rejects more", () => {
    const atCap = Array.from({ length: 200 }, (_, index) => ({ id: `m${index}` }))
    expect(validateCustomProvider({ ...validInput, models: atCap }).ok).toBe(true)
    const overCap = Array.from({ length: 201 }, (_, index) => ({ id: `m${index}` }))
    expect(validateCustomProvider({ ...validInput, models: overCap })).toEqual({
      ok: false,
      error: "invalid_models",
    })
  })
})

describe("createCustomProviderStore ", () => {
  it("writes, lists and removes providers, preserving unknown entries", async () => {
    const file = await tempFile()
    const store = createCustomProviderStore({ file })
    expect(await store.list()).toEqual([])

    await store.upsert({
      id: "acme",
      name: "Acme",
      baseURL: "https://api.acme.example/v1",
      package: "openai-compatible",
      models: [{ id: "m1", name: "Model One" }],
    })

    // A hand-added entry MasterHand does not recognize must survive a write.
    const raw = JSON.parse(await readFile(file, "utf8")) as { providers: Record<string, unknown> }
    raw.providers.manual = { package: "@opencode/ai/providers/anthropic", name: "Manual" }
    await writeFile(file, JSON.stringify(raw), "utf8")

    await store.upsert({
      id: "globex",
      name: "Globex",
      baseURL: "https://globex.example/v1",
      package: "openai",
      models: [{ id: "g1" }],
    })

    const providers = await store.list()
    expect(providers.map((provider) => provider.id).sort()).toEqual(["acme", "globex"])

    const after = JSON.parse(await readFile(file, "utf8")) as { providers: Record<string, unknown> }
    expect(after.providers.manual).toEqual({ package: "@opencode/ai/providers/anthropic", name: "Manual" })
    // opencode's expected v2 shape.
    expect(after.providers.acme).toMatchObject({
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: "https://api.acme.example/v1" },
      models: { m1: { name: "Model One" } },
    })

    await store.remove("acme")
    expect((await store.list()).map((provider) => provider.id)).toEqual(["globex"])
    // Removing an unknown id is a no-op.
    await store.remove("missing")
  })

  it("refuses to overwrite a corrupt file", async () => {
    const file = await tempFile()
    await writeFile(file, "{ not json", "utf8")
    const store = createCustomProviderStore({ file })
    await expect(store.list()).rejects.toBeInstanceOf(CustomProvidersFileError)
    const provider: CustomProvider = {
      id: "acme",
      name: "Acme",
      baseURL: "https://api.acme.example/v1",
      package: "openai-compatible",
      models: [{ id: "m1" }],
    }
    await expect(store.upsert(provider)).rejects.toBeInstanceOf(CustomProvidersFileError)
  })

  it("serializes concurrent upserts", async () => {
    const file = await tempFile()
    const store = createCustomProviderStore({ file })
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        store.upsert({
          id: `p${index}`,
          name: `P${index}`,
          baseURL: "https://x.example/v1",
          package: "openai-compatible",
          models: [{ id: "m" }],
        }),
      ),
    )
    expect((await store.list()).length).toBe(8)
  })

  it("preserves unknown top-level config keys on every write", async () => {
    const file = await tempFile()
    await writeFile(
      file,
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        websearch: { provider: "tavily" },
        theme: "opencode",
        providers: {},
      }),
      "utf8",
    )
    const store = createCustomProviderStore({ file })

    await store.upsert({
      id: "acme",
      name: "Acme",
      baseURL: "https://api.acme.example/v1",
      package: "openai-compatible",
      models: [{ id: "m1" }],
    })

    const after = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>
    expect(after.websearch).toEqual({ provider: "tavily" })
    expect(after.theme).toBe("opencode")
    expect(after.providers).toHaveProperty("acme")

    await store.remove("acme")
    const final = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>
    expect(final.websearch).toEqual({ provider: "tavily" })
    expect(final.theme).toBe("opencode")
  })
})

describe("websearch selection ", () => {
  it("reads the selection and reports key presence", async () => {
    const file = await tempFile()
    const store = createCustomProviderStore({ file })

    // Absent file and absent key both read as "no selection".
    expect(await store.getWebsearch()).toBeNull()
    expect(await store.hasWebsearch()).toBe(false)

    await store.setWebsearch("tinyfish")
    expect(await store.getWebsearch()).toBe("tinyfish")
    expect(await store.hasWebsearch()).toBe(true)
    let raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>
    expect(raw.websearch).toEqual({ provider: "tinyfish" })

    await store.setWebsearch("random")
    expect(await store.getWebsearch()).toBe("random")

    await store.setWebsearch(false)
    expect(await store.getWebsearch()).toBe(false)
    raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>
    expect(raw.websearch).toBe(false)

    // `null` removes the key entirely (opencode falls back to its own prompt).
    await store.setWebsearch(null)
    expect(await store.getWebsearch()).toBeNull()
    expect(await store.hasWebsearch()).toBe(false)
    raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>
    expect("websearch" in raw).toBe(false)
  })

  it("keeps a hand-edited websearch value present but unrecognized values read as none", async () => {
    const file = await tempFile()
    await writeFile(file, JSON.stringify({ providers: {}, websearch: "not-an-object" }), "utf8")
    const store = createCustomProviderStore({ file })
    expect(await store.hasWebsearch()).toBe(true)
    expect(await store.getWebsearch()).toBeNull()
  })

  it("writes a websearch selection without touching the providers", async () => {
    const file = await tempFile()
    const store = createCustomProviderStore({ file })
    await store.upsert({
      id: "acme",
      name: "Acme",
      baseURL: "https://api.acme.example/v1",
      package: "openai-compatible",
      models: [{ id: "m1" }],
    })
    await store.setWebsearch("exa")
    const providers = await store.list()
    expect(providers.map((provider) => provider.id)).toEqual(["acme"])
    expect(await store.getWebsearch()).toBe("exa")
  })

  it("never overwrites a corrupt file when setting the selection", async () => {
    const file = await tempFile()
    await writeFile(file, "{ not json", "utf8")
    const store = createCustomProviderStore({ file })
    await expect(store.setWebsearch("tinyfish")).rejects.toBeInstanceOf(CustomProvidersFileError)
    expect(await readFile(file, "utf8")).toBe("{ not json")
  })

  it("validates the selection payload", () => {
    expect(validateWebsearchSelection({ provider: "tavily" })).toEqual({ ok: true, value: "tavily" })
    expect(validateWebsearchSelection({ provider: "random" })).toEqual({ ok: true, value: "random" })
    expect(validateWebsearchSelection({ provider: false })).toEqual({ ok: true, value: false })
    expect(validateWebsearchSelection({ provider: " exa " })).toEqual({ ok: true, value: "exa" })
    expect(validateWebsearchSelection({})).toEqual({ ok: false, error: "invalid_provider" })
    expect(validateWebsearchSelection({ provider: "" })).toEqual({ ok: false, error: "invalid_provider" })
    expect(validateWebsearchSelection({ provider: "Bad Id" })).toEqual({ ok: false, error: "invalid_provider" })
    expect(validateWebsearchSelection({ provider: 42 })).toEqual({ ok: false, error: "invalid_provider" })
    expect(validateWebsearchSelection({ provider: null })).toEqual({ ok: false, error: "invalid_provider" })
    expect(validateWebsearchSelection(null)).toEqual({ ok: false, error: "invalid_body" })
  })
})

describe("ensureWebsearchDefault ", () => {
  it("writes the keyless default when the file has no selection", async () => {
    const file = await tempFile()
    const store = createCustomProviderStore({ file })
    expect(await ensureWebsearchDefault(store)).toBe(true)
    expect(await store.getWebsearch()).toBe(DEFAULT_WEBSEARCH_PROVIDER)
  })

  it("creates the file when it does not exist", async () => {
    const file = await tempFile()
    const store = createCustomProviderStore({ file })
    await ensureWebsearchDefault(store)
    const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>
    expect(raw.websearch).toEqual({ provider: "tinyfish" })
    expect(raw.providers).toEqual({})
  })

  it("never overrides an existing selection, including a hand-edited one", async () => {
    const file = await tempFile()
    await writeFile(file, JSON.stringify({ providers: {}, websearch: { provider: "exa" } }), "utf8")
    const store = createCustomProviderStore({ file })
    expect(await ensureWebsearchDefault(store)).toBe(false)
    expect(await store.getWebsearch()).toBe("exa")

    await writeFile(file, JSON.stringify({ providers: {}, websearch: false }), "utf8")
    expect(await ensureWebsearchDefault(store)).toBe(false)
    expect(await store.getWebsearch()).toBe(false)

    await writeFile(file, JSON.stringify({ providers: {}, websearch: "weird" }), "utf8")
    expect(await ensureWebsearchDefault(store)).toBe(false)
    const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>
    expect(raw.websearch).toBe("weird")
  })

  it("refuses to touch a corrupt file", async () => {
    const file = await tempFile()
    await writeFile(file, "{ not json", "utf8")
    const store = createCustomProviderStore({ file })
    await expect(ensureWebsearchDefault(store)).rejects.toBeInstanceOf(CustomProvidersFileError)
    expect(await readFile(file, "utf8")).toBe("{ not json")
  })
})

describe("validateDiscoverInput ", () => {
  it("accepts a base URL with an optional key and headers", () => {
    expect(validateDiscoverInput({ baseURL: "https://api.acme.example/v1" })).toEqual({
      ok: true,
      value: { baseURL: "https://api.acme.example/v1" },
    })
    expect(
      validateDiscoverInput({ baseURL: " https://x.example ", key: " sk-1 ", headers: { "X-A": "b" } }),
    ).toEqual({
      ok: true,
      value: { baseURL: "https://x.example", key: "sk-1", headers: { "X-A": "b" } },
    })
  })

  it("rejects invalid bodies, URLs and headers", () => {
    expect(validateDiscoverInput(null)).toEqual({ ok: false, error: "invalid_body" })
    expect(validateDiscoverInput({ baseURL: "ftp://x" })).toEqual({ ok: false, error: "invalid_base_url" })
    expect(validateDiscoverInput({ baseURL: "https://x", headers: { X: "line\nbreak" } })).toEqual({
      ok: false,
      error: "invalid_headers",
    })
  })
})

describe("parseModelsResponse ", () => {
  it("reads the OpenAI `data` shape, tolerates `models` and a bare array", () => {
    expect(parseModelsResponse({ data: [{ id: "a" }, { id: "b", name: "Bee" }] })).toEqual([
      { id: "a" },
      { id: "b", name: "Bee" },
    ])
    expect(parseModelsResponse({ models: [{ id: "a", display_name: "Ay" }] })).toEqual([{ id: "a", name: "Ay" }])
    expect(parseModelsResponse([{ id: "a" }])).toEqual([{ id: "a" }])
  })

  it("deduplicates, skips unusable entries and returns [] for unknown shapes", () => {
    expect(parseModelsResponse({ data: [{ id: "a" }, { id: "a" }, { name: "no id" }, { id: "" }] })).toEqual([
      { id: "a" },
    ])
    expect(parseModelsResponse({ nope: true })).toEqual([])
    expect(parseModelsResponse(null)).toEqual([])
  })

  it("caps the list at the provider cap", () => {
    const items = Array.from({ length: 250 }, (_, index) => ({ id: `m${index}` }))
    expect(parseModelsResponse({ data: items })).toHaveLength(200)
  })
})

describe("fetchProviderModels ", () => {
  function respond(body: unknown, status = 200): typeof fetch {
    return (async () => Response.json(body, { status })) as typeof fetch
  }

  it("appends /models, trims the trailing slash and forwards the key and headers", async () => {
    let seen: { url: string; headers: Headers } | null = null
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen = { url: String(input), headers: new Headers(init?.headers) }
      return Response.json({ data: [{ id: "a" }] })
    }) as typeof fetch
    const result = await fetchProviderModels(
      { baseURL: "https://api.acme.example/v1/", key: "sk-1", headers: { "X-A": "b" } },
      { fetchImpl },
    )
    expect(result).toEqual({ ok: true, models: [{ id: "a" }] })
    expect(seen!.url).toBe("https://api.acme.example/v1/models")
    expect(seen!.headers.get("authorization")).toBe("Bearer sk-1")
    expect(seen!.headers.get("x-a")).toBe("b")
  })

  function recorder(): { calls: string[]; fetchImpl: typeof fetch } {
    const calls: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls.push(String(input))
      return Response.json({ data: [{ id: "a" }] })
    }) as typeof fetch
    return { calls, fetchImpl }
  }

  it("rejects loopback, unspecified, link-local/metadata, multicast and reserved targets", async () => {
    const blocked = [
      "http://127.0.0.1:8080/v1",
      "http://127.10.20.30/v1",
      "http://[::1]:8080/v1",
      "http://0.0.0.0:8080/v1",
      "http://[::]:8080/v1",
      "http://169.254.169.254/latest/meta-data",
      "http://[fe80::1]/v1",
      "http://[fd00:ec2::254]/v1",
      "http://224.0.0.1/v1",
      "http://[ff02::1]/v1",
      "http://[::ffff:127.0.0.1]/v1",
      "http://[::ffff:169.254.169.254]/v1",
      "http://[0:0:0:0:0:ffff:127.0.0.1]/v1",
      "http://[fe80::1%25eth0]/v1",
      "http://[::2]/v1",
      "http://2130706433/v1",
      "http://0x7f.1/v1",
    ]
    for (const baseURL of blocked) {
      const { calls, fetchImpl } = recorder()
      const result = await fetchProviderModels({ baseURL }, { fetchImpl, resolver: async () => [] })
      expect(result, baseURL).toEqual({ ok: false, error: "invalid_base_url" })
      expect(calls, baseURL).toEqual([])
    }
  })

  it("keeps private LAN targets allowed, IPv4-mapped ones included (ADR-30)", async () => {
    const allowed = [
      "http://192.168.1.10:8080/v1",
      "http://10.1.2.3/v1",
      "http://172.20.0.2/v1",
      "http://[fd12:3456:789a::10]/v1",
      "http://[::ffff:192.168.1.10]/v1",
    ]
    for (const baseURL of allowed) {
      const { calls, fetchImpl } = recorder()
      const result = await fetchProviderModels({ baseURL }, { fetchImpl, resolver: async () => [] })
      expect(result, baseURL).toEqual({ ok: true, models: [{ id: "a" }] })
      expect(calls, baseURL).toHaveLength(1)
    }
  })

  it("rejects a hostname when any resolved address is blocked", async () => {
    const { calls, fetchImpl } = recorder()
    const resolved: string[] = []
    const result = await fetchProviderModels(
      { baseURL: "https://provider.example/v1" },
      {
        fetchImpl,
        resolver: async (hostname) => {
          resolved.push(hostname)
          return ["192.168.1.10", "169.254.169.254"]
        },
      },
    )
    expect(result).toEqual({ ok: false, error: "invalid_base_url" })
    expect(resolved).toEqual(["provider.example"])
    expect(calls).toEqual([])
  })

  it("fetches a hostname that resolves only to private LAN addresses", async () => {
    const { calls, fetchImpl } = recorder()
    const result = await fetchProviderModels(
      { baseURL: "https://provider.lan/v1" },
      { fetchImpl, resolver: async () => ["192.168.1.10", "fd12:3456:789a::10"] },
    )
    expect(result).toEqual({ ok: true, models: [{ id: "a" }] })
    expect(calls).toEqual(["https://provider.lan/v1/models"])
  })

  it("allows loopback only with the explicit opt-in, never metadata", async () => {
    for (const baseURL of ["http://127.0.0.1:8080/v1", "http://[::1]/v1"]) {
      const { calls, fetchImpl } = recorder()
      const result = await fetchProviderModels(
        { baseURL },
        { fetchImpl, allowLoopback: true, resolver: async () => [] },
      )
      expect(result, baseURL).toEqual({ ok: true, models: [{ id: "a" }] })
      expect(calls, baseURL).toHaveLength(1)
    }

    const metadata = await fetchProviderModels(
      { baseURL: "http://169.254.169.254/latest/meta-data" },
      { fetchImpl: recorder().fetchImpl, allowLoopback: true, resolver: async () => [] },
    )
    expect(metadata).toEqual({ ok: false, error: "invalid_base_url" })

    const mixed = await fetchProviderModels(
      { baseURL: "https://provider.example/v1" },
      {
        fetchImpl: recorder().fetchImpl,
        allowLoopback: true,
        resolver: async () => ["127.0.0.1", "169.254.169.254"],
      },
    )
    expect(mixed).toEqual({ ok: false, error: "invalid_base_url" })

    const hostname = await fetchProviderModels(
      { baseURL: "https://localhost-provider.example/v1" },
      { fetchImpl: recorder().fetchImpl, allowLoopback: true, resolver: async () => ["127.0.0.1"] },
    )
    expect(hostname).toEqual({ ok: true, models: [{ id: "a" }] })
  })

  it("handles IPv6 edge forms consistently", async () => {
    for (const baseURL of ["http://[::ffff:0.0.0.0]/v1", "http://[fe80::1%25]/v1"]) {
      const { calls, fetchImpl } = recorder()
      const result = await fetchProviderModels({ baseURL }, { fetchImpl, resolver: async () => [] })
      expect(result, baseURL).toEqual({ ok: false, error: "invalid_base_url" })
      expect(calls, baseURL).toEqual([])
    }

    const { calls, fetchImpl } = recorder()
    const allowed = await fetchProviderModels(
      { baseURL: "http://[2001:db8::192.0.2.1]/v1" },
      { fetchImpl, resolver: async () => [] },
    )
    expect(allowed).toEqual({ ok: true, models: [{ id: "a" }] })
    expect(calls).toHaveLength(1)
  })

  it("rejects a malformed URL and an unparseable resolved address", async () => {
    const malformed = await fetchProviderModels(
      { baseURL: "http://[::1" },
      { fetchImpl: respond({ data: [] }) },
    )
    expect(malformed).toEqual({ ok: false, error: "invalid_base_url" })

    const { calls, fetchImpl } = recorder()
    const unparseable = await fetchProviderModels(
      { baseURL: "https://provider.example/v1" },
      { fetchImpl, resolver: async () => ["not-an-address"] },
    )
    expect(unparseable).toEqual({ ok: false, error: "invalid_base_url" })
    expect(calls).toEqual([])
  })

  it("bounds the DNS lookup with the request budget", async () => {
    const result = await fetchProviderModels(
      { baseURL: "https://slow.example/v1" },
      {
        timeoutMs: 20,
        fetchImpl: respond({ data: [{ id: "a" }] }),
        resolver: () => new Promise(() => {}),
      },
    )
    expect(result).toEqual({ ok: false, error: "provider_timeout" })
  })

  it("proceeds when DNS resolution fails (the fetch reports the transport error)", async () => {
    const { calls, fetchImpl } = recorder()
    const result = await fetchProviderModels(
      { baseURL: "https://missing.example/v1" },
      {
        fetchImpl,
        resolver: async () => {
          throw new Error("ENOTFOUND")
        },
      },
    )
    expect(result).toEqual({ ok: true, models: [{ id: "a" }] })
    expect(calls).toEqual(["https://missing.example/v1/models"])
  })

  it("maps status and transport failures to typed errors", async () => {
    const unauthorized = await fetchProviderModels(
      { baseURL: "https://x" },
      { fetchImpl: respond({ error: "unauthorized" }, 401) },
    )
    expect(unauthorized).toEqual({ ok: false, error: "provider_unauthorized" })

    const failed = await fetchProviderModels({ baseURL: "https://x" }, { fetchImpl: respond({}, 500) })
    expect(failed).toEqual({ ok: false, error: "provider_failed" })

    const empty = await fetchProviderModels({ baseURL: "https://x" }, { fetchImpl: respond({ data: [] }) })
    expect(empty).toEqual({ ok: false, error: "provider_no_models" })

    const invalid = await fetchProviderModels(
      { baseURL: "https://x" },
      { fetchImpl: (async () => new Response("not json", { status: 200 })) as typeof fetch },
    )
    expect(invalid).toEqual({ ok: false, error: "provider_invalid_response" })

    const timeout = await fetchProviderModels(
      { baseURL: "https://x" },
      {
        fetchImpl: (async () => {
          throw Object.assign(new Error("timed out"), { name: "TimeoutError" })
        }) as typeof fetch,
      },
    )
    expect(timeout).toEqual({ ok: false, error: "provider_timeout" })

    const unreachable = await fetchProviderModels(
      { baseURL: "https://x" },
      {
        fetchImpl: (async () => {
          throw new Error("connection refused")
        }) as typeof fetch,
      },
    )
    expect(unreachable).toEqual({ ok: false, error: "provider_unreachable" })
  })
})
