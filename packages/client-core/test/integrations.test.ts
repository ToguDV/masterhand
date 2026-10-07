import { describe, expect, it } from "vitest"
import {
  compareIntegrations,
  normalizeCredentials,
  normalizeIntegration,
  normalizeIntegrations,
  providerIcon,
  providerMonogram,
  type Integration,
} from "../src/integrations"
import { providerIconSvgs } from "../src/provider-icons.generated"

describe("normalizeIntegrations (#128)", () => {
  it("normalizes methods and connections into view models", () => {
    const integration = normalizeIntegration({
      id: "opencode-go",
      name: "OpenCode Go",
      methods: [
        { type: "key", label: "API key" },
        { id: "oauth", type: "oauth", label: "Sign in" },
        { type: "env", names: ["OPENCODE_GO_KEY"] },
      ],
      connections: [
        { type: "credential", id: "cred_1", label: "Personal", method: "key", status: { status: "needs_auth", message: "expired" } },
        { type: "env", name: "OPENCODE_GO_KEY" },
      ],
    })

    expect(integration).toEqual({
      id: "opencode-go",
      name: "OpenCode Go",
      methods: [
        { id: "key", type: "key", label: "API key" },
        { id: "oauth", type: "oauth", label: "Sign in" },
        { id: "env", type: "env", label: "OPENCODE_GO_KEY" },
      ],
      connections: [
        { type: "credential", credentialID: "cred_1", label: "Personal", method: "key", status: "needs_auth" },
        { type: "env" },
      ],
    })
  })

  it("tolerates missing and unknown fields", () => {
    expect(normalizeIntegration({ id: "x" })).toBeNull()
    expect(normalizeIntegration({ name: "No id" })).toBeNull()
    expect(normalizeIntegration("nope")).toBeNull()

    const integration = normalizeIntegration({
      id: "x",
      name: "X",
      methods: [{ type: "future-method" }, null, "junk"],
      connections: "junk",
    })
    expect(integration).toEqual({ id: "x", name: "X", methods: [], connections: [] })
    expect(normalizeIntegrations(undefined)).toEqual([])
    expect(normalizeIntegrations([{ id: "a", name: "A" }])).toEqual([
      { id: "a", name: "A", methods: [], connections: [] },
    ])
  })

  it("normalizes stored credentials and skips malformed entries", () => {
    expect(
      normalizeCredentials([
        { id: "cred_1", integrationID: "opencode-go", label: "Personal", active: true, value: { type: "key" } },
        { id: "cred_2", integrationID: "other" },
        { id: "no-integration" },
        null,
      ]),
    ).toEqual([
      { id: "cred_1", integrationID: "opencode-go", label: "Personal", active: true },
      { id: "cred_2", integrationID: "other", label: "cred_2", active: false },
    ])
    expect(normalizeCredentials("nope")).toEqual([])
  })

  it("passes through an optional metadata icon and falls back to a monogram", () => {
    expect(
      normalizeIntegration({
        id: "acme",
        name: "Acme",
        metadata: { icon: "https://example.com/acme.svg" },
      })?.icon,
    ).toBe("https://example.com/acme.svg")
    expect(
      normalizeIntegration({ id: "acme", name: "Acme", metadata: { logo: "https://example.com/l.svg" } })?.icon,
    ).toBe("https://example.com/l.svg")
    expect(normalizeIntegration({ id: "acme", name: "Acme", metadata: { icon: 42 } })?.icon).toBeUndefined()

    expect(providerMonogram("OpenCode Go")).toBe("O")
    expect(providerMonogram("  anthropic")).toBe("A")
    expect(providerMonogram("42 provider")).toBe("4")
    expect(providerMonogram("***")).toBe("?")
  })
})

describe("providerIcon", () => {
  it("returns the vendored brand mark by integration id, aliases included", () => {
    const anthropic = providerIcon("anthropic")
    expect(anthropic).toContain("<svg")
    expect(anthropic).toContain("currentColor")
    // Sized by the caller: no fixed width/height on the artwork.
    expect(anthropic).not.toMatch(/\swidth=/)
    expect(anthropic).not.toMatch(/\sheight=/)
    // Ids are matched tolerantly (case/whitespace) and share one artwork.
    expect(providerIcon(" Anthropic ")).toBe(anthropic)
    expect(providerIcon("zai-coding-plan")).toBe(providerIcon("zai"))
    expect(providerIcon("not-a-provider")).toBeNull()
  })

  it("ranks the provider list by importance, logos first (#128)", () => {
    const make = (id: string, name = id): Integration => ({ id, name, methods: [], connections: [] })
    const ids = (list: Integration[]) =>
      [...list].sort(compareIntegrations).map((integration) => integration.id)

    // OpenCode Go stays pinned ahead of the rest, whatever the input order.
    expect(ids([make("anthropic"), make("opencode-go")])).toEqual(["opencode-go", "anthropic"])

    // Providers with a vendored logo come before iconless ones…
    expect(ids([make("github"), make("anthropic")])).toEqual(["anthropic", "github"])

    // …and follow the curated importance order among themselves.
    expect(ids([make("openrouter"), make("anthropic")])).toEqual(["anthropic", "openrouter"])

    // Unknown iconless providers fall back to a stable alphabetical order.
    expect(ids([make("zulu"), make("alpha")])).toEqual(["alpha", "zulu"])
  })

  it("vendors the original logos of the popular providers, paints normalized", () => {
    const ids = Object.keys(providerIconSvgs)
    expect(ids).toEqual(expect.arrayContaining(["opencode", "opencode-go", "anthropic", "openai", "google", "openrouter"]))
    expect(ids.length).toBeGreaterThanOrEqual(30)
    for (const id of ids) {
      const svg = providerIconSvgs[id]!
      expect(svg.startsWith("<svg")).toBe(true)
      expect(svg.endsWith("</svg>")).toBe(true)
      expect(svg).toContain("viewBox=")
      // Every painted fill/stroke must resolve to the client's current color.
      expect(svg).not.toMatch(/\sfill="(?!none|currentColor)[^"]*"/)
      expect(svg).not.toMatch(/\sstroke="(?!none|currentColor)[^"]*"/)
    }
  })
})
