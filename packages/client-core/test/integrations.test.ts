import { describe, expect, it } from "vitest"
import {
  normalizeCredentials,
  normalizeIntegration,
  normalizeIntegrations,
  providerMonogram,
} from "../src/integrations"

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
