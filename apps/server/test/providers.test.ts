import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  CustomProvidersFileError,
  createCustomProviderStore,
  fetchProviderModels,
  parseModelsResponse,
  validateCustomProvider,
  validateDiscoverInput,
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
