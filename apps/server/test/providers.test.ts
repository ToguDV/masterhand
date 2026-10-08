import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  CustomProvidersFileError,
  createCustomProviderStore,
  validateCustomProvider,
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
