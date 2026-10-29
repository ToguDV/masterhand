import { describe, expect, it } from "vitest"
import {
  defaultServerLabel,
  isMixedContentBlocked,
  isSameOrigin,
  normalizeServerLabel,
  normalizeServerUrl,
  serverAuthMode,
  serverMonogram,
  serverUrlErrorMessage,
} from "../src/servers"

function ok(input: string) {
  const result = normalizeServerUrl(input)
  if (!result.ok) throw new Error(`expected ${input} to normalize, got ${result.error}`)
  return result.server
}

describe("normalizeServerUrl", () => {
  it("canonicalizes https URLs and strips trailing slashes/default ports", () => {
    expect(ok("https://masterhand.example.com/").url).toBe("https://masterhand.example.com")
    expect(ok("https://masterhand.example.com:443").url).toBe("https://masterhand.example.com")
    expect(ok("  https://masterhand.example.com//  ").url).toBe("https://masterhand.example.com")
  })

  it("assumes https for scheme-less input", () => {
    expect(ok("masterhand.example.com").url).toBe("https://masterhand.example.com")
    expect(ok("192.168.1.20:8787").url).toBe("https://192.168.1.20:8787")
  })

  it("allows plain http on loopback hosts only", () => {
    expect(ok("http://localhost:8787").url).toBe("http://localhost:8787")
    expect(ok("http://127.0.0.1:8787").url).toBe("http://127.0.0.1:8787")
    expect(ok("http://[::1]:8787").url).toBe("http://[::1]:8787")
    expect(normalizeServerUrl("http://masterhand.example.com")).toEqual({
      ok: false,
      error: "https_required",
    })
  })

  it("rejects credentials, queries, hashes and non-root paths", () => {
    expect(normalizeServerUrl("https://user:pass@example.com")).toEqual({
      ok: false,
      error: "credentials",
    })
    expect(normalizeServerUrl("https://example.com/?a=1")).toEqual({ ok: false, error: "query" })
    expect(normalizeServerUrl("https://example.com/#x")).toEqual({ ok: false, error: "hash" })
    expect(normalizeServerUrl("https://example.com/masterhand")).toEqual({
      ok: false,
      error: "path",
    })
  })

  it("rejects empty, malformed, unsupported and over-long input", () => {
    expect(normalizeServerUrl("   ")).toEqual({ ok: false, error: "empty" })
    expect(normalizeServerUrl("https://")).toEqual({ ok: false, error: "invalid" })
    expect(normalizeServerUrl("ftp://example.com")).toEqual({ ok: false, error: "invalid" })
    expect(normalizeServerUrl(`https://${"a".repeat(3000)}.com`)).toEqual({
      ok: false,
      error: "too_long",
    })
  })

  it("exposes the hostname used for labels", () => {
    expect(ok("https://www.example.com").hostname).toBe("www.example.com")
  })
})

describe("labels and monograms", () => {
  it("defaults the label to the hostname without www", () => {
    expect(defaultServerLabel("https://www.example.com")).toBe("example.com")
    expect(defaultServerLabel(ok("http://127.0.0.1:8787"))).toBe("127.0.0.1")
  })

  it("trims and caps explicit labels, falling back to the hostname", () => {
    expect(normalizeServerLabel("  Home   server ", "https://example.com")).toBe("Home server")
    expect(normalizeServerLabel("", "https://example.com")).toBe("example.com")
    expect(normalizeServerLabel("x".repeat(200), "https://example.com")).toHaveLength(64)
  })

  it("builds two-letter monograms from words or a single token", () => {
    expect(serverMonogram("Home")).toBe("HO")
    expect(serverMonogram("Studio")).toBe("ST")
    expect(serverMonogram("My home lab")).toBe("MH")
    expect(serverMonogram("vps-01")).toBe("VP")
    expect(serverMonogram("", "example.com")).toBe("EX")
    expect(serverMonogram("", "")).toBe("MH")
  })
})

describe("origin and auth mode", () => {
  it("detects same-origin servers", () => {
    expect(isSameOrigin("https://a.example.com", "https://a.example.com")).toBe(true)
    expect(isSameOrigin("https://a.example.com/", "https://a.example.com:443")).toBe(true)
    expect(isSameOrigin("https://b.example.com", "https://a.example.com")).toBe(false)
    expect(isSameOrigin("not a url", "https://a.example.com")).toBe(false)
    expect(isSameOrigin("https://a.example.com", null)).toBe(false)
  })

  it("uses cookies only for the serving origin", () => {
    expect(serverAuthMode("https://a.example.com", "https://a.example.com")).toBe("cookie")
    expect(serverAuthMode("https://b.example.com", "https://a.example.com")).toBe("device")
  })

  it("blocks mixed content from an https page to a non-loopback http server", () => {
    expect(isMixedContentBlocked("http://example.com", "https://masterhand.example.com")).toBe(true)
    expect(isMixedContentBlocked("http://localhost:8787", "https://masterhand.example.com")).toBe(
      false,
    )
    expect(
      isMixedContentBlocked("http://127.0.0.1:8787", "https://masterhand.example.com"),
    ).toBe(false)
    expect(isMixedContentBlocked("https://example.com", "https://masterhand.example.com")).toBe(
      false,
    )
    expect(isMixedContentBlocked("http://localhost:8787", "http://masterhand.example.com")).toBe(
      false,
    )
  })
})

describe("serverUrlErrorMessage", () => {
  it("has copy for every error", () => {
    const errors = [
      "empty",
      "invalid",
      "too_long",
      "https_required",
      "credentials",
      "query",
      "hash",
      "path",
    ] as const
    for (const error of errors) expect(serverUrlErrorMessage(error)).not.toHaveLength(0)
  })
})
