import { describe, expect, it } from "vitest"
import {
  defaultModelValue,
  flattenModels,
  parseModel,
  recentModelValue,
  selectableAgents,
  sessionModelValue,
  variantLabel,
  isEffortVariant,
} from "../src/models"
import type { AgentInfo, ModelInfo, ModelVariant, ProviderInfo, Session } from "../src/types"

function model(
  providerID: string,
  id: string,
  name: string,
  overrides: Partial<ModelInfo> = {},
): ModelInfo {
  return {
    id,
    modelID: id,
    providerID,
    name,
    capabilities: {} as ModelInfo["capabilities"],
    variants: [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 0, output: 0 },
    ...overrides,
  }
}

function variant(id: string): ModelVariant {
  return { id } as ModelVariant
}

function provider(id: string, name: string): ProviderInfo {
  return { id, name } as unknown as ProviderInfo
}

const providers = [provider("zeta", "Zeta"), provider("alpha", "Alpha")]

const models = [
  model("zeta", "z-model", "Z Model"),
  model("zeta", "a-model", "A Model", { variants: [variant("low"), variant("high")] }),
  model("alpha", "m1", "M1", { variants: [variant("minimal"), variant("max")] }),
]

describe("flattenModels", () => {
  it("flattens models and providers sorted by label", () => {
    const options = flattenModels(models, providers)
    expect(options.map((option) => option.value)).toEqual(["alpha/m1", "zeta/a-model", "zeta/z-model"])
    expect(options[0]?.label).toBe("Alpha · M1")
  })

  it("exposes each model's variants", () => {
    const options = flattenModels(models, providers)
    expect(options.find((option) => option.value === "zeta/a-model")?.variants).toEqual(["low", "high"])
    expect(options.find((option) => option.value === "zeta/z-model")?.variants).toEqual([])
  })

  it("skips disabled models", () => {
    const options = flattenModels([...models, model("zeta", "off", "Off", { enabled: false })], providers)
    expect(options.some((option) => option.value === "zeta/off")).toBe(false)
  })

  it("falls back to the provider id and model id when names are missing", () => {
    const options = flattenModels(
      [model("unknown-provider", "raw-id", ""), model("no-name", "named", "Named")],
      providers,
    )
    expect(options.find((option) => option.value === "unknown-provider/raw-id")?.label).toBe(
      "unknown-provider · raw-id",
    )
    expect(options.find((option) => option.value === "no-name/named")?.label).toBe("no-name · Named")
  })

  it("tolerates empty catalogs", () => {
    expect(flattenModels([], [])).toEqual([])
  })
})

describe("variantLabel", () => {
  it("translates known variants", () => {
    expect(variantLabel("none")).toBe("None")
    expect(variantLabel("minimal")).toBe("Minimal")
    expect(variantLabel("low")).toBe("Low")
    expect(variantLabel("medium")).toBe("Medium")
    expect(variantLabel("high")).toBe("High")
    expect(variantLabel("xhigh")).toBe("Very high")
    expect(variantLabel("max")).toBe("Max")
  })

  it("capitalizes unknown variants", () => {
    expect(variantLabel("turbo")).toBe("Turbo")
    expect(variantLabel("HIGH")).toBe("High")
  })
})

describe("isEffortVariant", () => {
  it("recognizes reasoning-effort levels, case-insensitively", () => {
    expect(isEffortVariant("low")).toBe(true)
    expect(isEffortVariant("XHIGH")).toBe(true)
    expect(isEffortVariant("minimal")).toBe(true)
  })

  it("rejects provider-specific variants", () => {
    expect(isEffortVariant("turbo")).toBe(false)
    expect(isEffortVariant("thinking")).toBe(false)
  })
})

describe("selectableAgents", () => {
  const agents = [
    { id: "build", name: "build", mode: "primary", hidden: false },
    { id: "plan", name: "plan", mode: "primary", hidden: false },
    { id: "all", name: "all", mode: "all", hidden: false },
    { id: "title", name: "title", mode: "primary", hidden: true },
    { id: "explore", name: "explore", mode: "subagent", hidden: false },
  ] as unknown as AgentInfo[]

  it("excludes subagents and hidden agents", () => {
    expect(selectableAgents(agents).map((agent) => agent.name)).toEqual(["build", "plan", "all"])
  })

  it("tolerates empty lists", () => {
    expect(selectableAgents([])).toEqual([])
  })
})

describe("defaultModelValue", () => {
  const options = flattenModels(models, providers)
  const defaultModel = model("alpha", "m1", "M1")

  it("prefers the last used model when it is still available", () => {
    expect(defaultModelValue(defaultModel, options, "zeta/z-model")).toBe("zeta/z-model")
  })

  it("ignores a preferred model that is no longer available", () => {
    expect(defaultModelValue(defaultModel, options, "missing/model")).toBe("alpha/m1")
  })

  it("uses the server default when there is no preference", () => {
    expect(defaultModelValue(model("zeta", "a-model", "A Model"), options)).toBe("zeta/a-model")
  })

  it("falls back to the first available model", () => {
    expect(defaultModelValue(null, options)).toBe("alpha/m1")
    expect(defaultModelValue(model("gone", "x", "X"), options)).toBe("alpha/m1")
  })

  it("returns an empty string without options", () => {
    expect(defaultModelValue(null, [])).toBe("")
  })
})

describe("sessionModelValue", () => {
  const options = flattenModels(models, providers)
  const session = (modelRef?: Session["model"]): Session =>
    ({ id: "ses_1", model: modelRef }) as unknown as Session

  it("returns the session model when available", () => {
    expect(sessionModelValue(session({ providerID: "zeta", id: "z-model" }), options)).toBe("zeta/z-model")
  })

  it("returns undefined without a model or when it is unavailable", () => {
    expect(sessionModelValue(session(undefined), options)).toBeUndefined()
    expect(sessionModelValue(undefined, options)).toBeUndefined()
    expect(sessionModelValue(session({ providerID: "gone", id: "model" }), options)).toBeUndefined()
  })
})

describe("recentModelValue", () => {
  const options = flattenModels(models, providers)
  const withModel = (id: string, updated: number | undefined, model: Session["model"]): Session => {
    const session = { id, model } as unknown as Session
    if (updated !== undefined) (session as { time?: unknown }).time = { created: 0, updated }
    return session
  }

  it("picks the model of the most recently updated session", () => {
    const sessions = [
      withModel("a", 100, { providerID: "zeta", id: "z-model" }),
      withModel("b", 200, { providerID: "zeta", id: "a-model" }),
    ]
    expect(recentModelValue(sessions, options)).toBe("zeta/a-model")
  })

  it("skips sessions without a usable model", () => {
    const sessions = [
      withModel("a", 300, { providerID: "gone", id: "model" }),
      withModel("b", 200, { providerID: "alpha", id: "m1" }),
    ]
    expect(recentModelValue(sessions, options)).toBe("alpha/m1")
  })

  it("treats a missing update timestamp as the oldest", () => {
    expect(recentModelValue([withModel("a", undefined, { providerID: "zeta", id: "z-model" })], options)).toBe(
      "zeta/z-model",
    )
  })

  it("returns undefined when no session has a usable model", () => {
    expect(recentModelValue([], options)).toBeUndefined()
    expect(recentModelValue([withModel("a", 1, undefined)], options)).toBeUndefined()
  })
})

describe("parseModel", () => {
  it("splits provider and model id", () => {
    expect(parseModel("anthropic/claude-sonnet-4")).toEqual({
      providerID: "anthropic",
      id: "claude-sonnet-4",
    })
  })

  it("keeps slashes inside the model id", () => {
    expect(parseModel("openrouter/anthropic/claude")).toEqual({
      providerID: "openrouter",
      id: "anthropic/claude",
    })
  })

  it("includes the variant when given", () => {
    expect(parseModel("anthropic/claude", "high")).toEqual({
      providerID: "anthropic",
      id: "claude",
      variant: "high",
    })
    expect(parseModel("anthropic/claude", "")).toEqual({ providerID: "anthropic", id: "claude" })
  })

  it("returns undefined without a separator", () => {
    expect(parseModel("model-only")).toBeUndefined()
  })
})
