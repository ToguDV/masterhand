import { describe, expect, it } from "vitest"
import {
  isValidProviderId,
  normalizeCustomProvider,
  normalizeCustomProviders,
  normalizeDiscoveredModels,
  providerIdFromName,
  type CustomProvider,
} from "../src/custom-providers"

describe("provider ids ", () => {
  it("validates opencode's id rule", () => {
    expect(isValidProviderId("acme")).toBe(true)
    expect(isValidProviderId("my-provider_1")).toBe(true)
    expect(isValidProviderId("Bad Id")).toBe(false)
    expect(isValidProviderId("-leading")).toBe(false)
    expect(isValidProviderId("")).toBe(false)
  })

  it("derives a slug from a display name", () => {
    expect(providerIdFromName("My AI Provider")).toBe("my-ai-provider")
    expect(providerIdFromName("  Acme  ")).toBe("acme")
    expect(providerIdFromName("UniÑo")).toBe("uni-o")
    expect(providerIdFromName("!!")).toBe("")
  })
})

describe("normalizeCustomProvider ", () => {
  it("parses a well-formed provider and defaults the package", () => {
    expect(
      normalizeCustomProvider({
        id: "acme",
        name: "Acme",
        baseURL: "https://api.acme.example/v1",
        models: [{ id: "m1", name: "Model One" }],
      }),
    ).toEqual({
      id: "acme",
      name: "Acme",
      baseURL: "https://api.acme.example/v1",
      package: "openai-compatible",
      models: [{ id: "m1", name: "Model One" }],
    })
  })

  it("keeps the package, headers and paired limits", () => {
    const provider = normalizeCustomProvider({
      id: "acme",
      name: "Acme",
      baseURL: "https://api.acme.example/v1",
      package: "openai",
      headers: { "X-Key": "value" },
      models: [{ id: "m1", context: 1000, output: 100 }, { id: "m2", context: 1000 }],
    })
    expect(provider?.package).toBe("openai")
    expect(provider?.headers).toEqual({ "X-Key": "value" })
    expect(provider?.models).toEqual([{ id: "m1", context: 1000, output: 100 }, { id: "m2" }])
  })

  it("skips malformed entries", () => {
    expect(normalizeCustomProvider({ id: "x" })).toBeNull()
    expect(normalizeCustomProvider({ name: "No id" })).toBeNull()
    expect(normalizeCustomProvider("nope")).toBeNull()
    expect(normalizeCustomProviders(undefined)).toEqual([])
    const provider: CustomProvider = {
      id: "a",
      name: "A",
      baseURL: "https://a.example/v1",
      package: "openai-compatible",
      models: [],
    }
    expect(normalizeCustomProviders([{ id: "a", name: "A", baseURL: "https://a.example/v1" }, {}])).toEqual([provider])
  })
})

describe("normalizeDiscoveredModels ", () => {
  it("keeps valid id/name entries and drops malformed ones", () => {
    expect(
      normalizeDiscoveredModels([
        { id: "m1", name: "Model One" },
        { id: "m2" },
        { name: "no id" },
        { id: "" },
        "nope",
      ]),
    ).toEqual([{ id: "m1", name: "Model One" }, { id: "m2" }])
    expect(normalizeDiscoveredModels(undefined)).toEqual([])
    expect(normalizeDiscoveredModels({ data: [{ id: "m1" }] })).toEqual([])
  })
})
