import { describe, expect, it } from "vitest"
import {
  defaultServerLabel,
  isMixedContentBlocked,
  isPrivateHostname,
  isSameOrigin,
  normalizeServerLabel,
  normalizeServerUrl,
  type NormalizeServerUrlOptions,
  serverAuthMode,
  serverMonogram,
  serverUrlErrorMessage,
} from "../src/servers"

function ok(input: string) {
  const result = normalizeServerUrl(input)
  if (!result.ok) throw new Error(`expected ${input} to normalize, got ${result.error}`)
  return result.server
}

function okWith(input: string, options: NormalizeServerUrlOptions) {
  const result = normalizeServerUrl(input, options)
  if (!result.ok) throw new Error(`expected ${input} to normalize, got ${result.error}`)
  return result.server
}

const PRIVATE_NETWORK = { allowPrivateNetwork: true } as const

const PRIVATE_HTTP_URLS = [
  "http://10.0.0.5:8787",
  "http://172.16.0.1:8787",
  "http://172.31.255.255:8787",
  "http://192.168.1.50:8787",
  "http://169.254.10.1:8787",
  "http://[fc00::1]:8787",
  "http://[fd12:3456::1]:8787",
  "http://[fe80::1]:8787",
  "http://[::ffff:c0a8:105]:8787",
  "http://masterhand.local:8787",
  "http://home.home.arpa:8787",
] as const

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

  it("allows plain http only for the serving origin or an explicit legacy migration", () => {
    expect(normalizeServerUrl("http://192.168.1.20:8787")).toEqual({
      ok: false,
      error: "https_required",
    })
    expect(
      normalizeServerUrl("http://192.168.1.20:8787", {
        allowInsecureOrigin: "http://192.168.1.20:8787",
      }),
    ).toEqual({
      ok: true,
      server: {
        url: "http://192.168.1.20:8787",
        origin: "http://192.168.1.20:8787",
        hostname: "192.168.1.20",
      },
    })
    // A different http origin is still rejected.
    expect(
      normalizeServerUrl("http://192.168.1.21:8787", {
        allowInsecureOrigin: "http://192.168.1.20:8787",
      }),
    ).toEqual({ ok: false, error: "https_required" })
    // Legacy mobile migration may accept the stored LAN URL once.
    expect(normalizeServerUrl("http://192.168.1.20:8787", { allowInsecure: true })).toMatchObject({
      ok: true,
      server: { url: "http://192.168.1.20:8787" },
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

describe("normalizeServerUrl with allowPrivateNetwork", () => {
  it("accepts plain http on RFC 1918 and link-local IPv4 hosts", () => {
    expect(okWith("http://10.0.0.5:8787", PRIVATE_NETWORK).url).toBe("http://10.0.0.5:8787")
    expect(okWith("http://172.16.0.1:8787", PRIVATE_NETWORK).url).toBe("http://172.16.0.1:8787")
    expect(okWith("http://172.31.255.255:8787", PRIVATE_NETWORK).url).toBe(
      "http://172.31.255.255:8787",
    )
    expect(okWith("http://192.168.1.50:8787", PRIVATE_NETWORK).url).toBe(
      "http://192.168.1.50:8787",
    )
    expect(okWith("http://169.254.10.1:8787", PRIVATE_NETWORK).url).toBe(
      "http://169.254.10.1:8787",
    )
  })

  it("rejects plain http on public and non-private IPv4 and IPv6 hosts", () => {
    for (const url of [
      "http://172.15.0.1:8787",
      "http://172.32.0.1:8787",
      "http://8.8.8.8:8787",
      // CGNAT/Tailscale: already encrypted, so plain http would be a downgrade.
      "http://100.64.0.1:8787",
      "http://[2001:db8::1]:8787",
    ]) {
      expect(normalizeServerUrl(url, PRIVATE_NETWORK)).toEqual({
        ok: false,
        error: "https_required",
      })
    }
  })

  it("accepts plain http on ULA, link-local and IPv4-mapped IPv6 hosts", () => {
    expect(okWith("http://[fc00::1]:8787", PRIVATE_NETWORK).url).toBe("http://[fc00::1]:8787")
    expect(okWith("http://[fd12:3456::1]:8787", PRIVATE_NETWORK).url).toBe(
      "http://[fd12:3456::1]:8787",
    )
    expect(okWith("http://[fe80::1]:8787", PRIVATE_NETWORK).url).toBe("http://[fe80::1]:8787")
    expect(okWith("http://[::ffff:c0a8:105]:8787", PRIVATE_NETWORK).url).toBe(
      "http://[::ffff:c0a8:105]:8787",
    )
    // The dotted input is normalized by URL to the hex-group form.
    expect(okWith("http://[::ffff:192.168.1.5]:8787", PRIVATE_NETWORK).url).toBe(
      "http://[::ffff:c0a8:105]:8787",
    )
  })

  it("accepts plain http on .local and .home.arpa names", () => {
    expect(okWith("http://masterhand.local:8787", PRIVATE_NETWORK).url).toBe(
      "http://masterhand.local:8787",
    )
    expect(okWith("http://home.home.arpa:8787", PRIVATE_NETWORK).url).toBe(
      "http://home.home.arpa:8787",
    )
    // A trailing root dot is still the same private name.
    expect(okWith("http://nas.local.:8787", PRIVATE_NETWORK).url).toBe("http://nas.local.:8787")
    expect(okWith("http://home.home.arpa.:8787", PRIVATE_NETWORK).url).toBe(
      "http://home.home.arpa.:8787",
    )
  })

  it("rejects plain http on public hostnames", () => {
    for (const url of ["http://evil.com", "http://masterhand.example.com"]) {
      expect(normalizeServerUrl(url, PRIVATE_NETWORK)).toEqual({
        ok: false,
        error: "https_required",
      })
    }
  })

  it("is opt-in: every private http URL is rejected without the option", () => {
    for (const url of PRIVATE_HTTP_URLS) {
      expect(normalizeServerUrl(url)).toEqual({ ok: false, error: "https_required" })
    }
  })

  it("only switches scheme-less private input to http when the option is set", () => {
    expect(okWith("192.168.1.50:8787", PRIVATE_NETWORK).url).toBe("http://192.168.1.50:8787")
    // Without the option the scheme-less default stays https (current behavior).
    expect(ok("192.168.1.50:8787").url).toBe("https://192.168.1.50:8787")
  })

  it("keeps https for scheme-less private input on a conventional TLS port", () => {
    expect(okWith("192.168.1.5:443", PRIVATE_NETWORK).url).toBe("https://192.168.1.5")
    expect(okWith("nas.local:443", PRIVATE_NETWORK).url).toBe("https://nas.local")
    expect(okWith("192.168.1.5:8443", PRIVATE_NETWORK).url).toBe("https://192.168.1.5:8443")
    // Non-TLS ports still switch to http.
    expect(okWith("192.168.1.5:8787", PRIVATE_NETWORK).url).toBe("http://192.168.1.5:8787")
  })

  it("keeps https for scheme-less public input and explicit https", () => {
    expect(okWith("masterhand.example.com", PRIVATE_NETWORK).url).toBe(
      "https://masterhand.example.com",
    )
    expect(okWith("https://192.168.1.50:8787", PRIVATE_NETWORK).url).toBe(
      "https://192.168.1.50:8787",
    )
  })

  it("still rejects credentials, queries, hashes and paths on private http hosts", () => {
    expect(normalizeServerUrl("http://user:pass@192.168.1.50:8787", PRIVATE_NETWORK)).toEqual({
      ok: false,
      error: "credentials",
    })
    expect(normalizeServerUrl("http://192.168.1.50:8787/?a=1", PRIVATE_NETWORK)).toEqual({
      ok: false,
      error: "query",
    })
    expect(normalizeServerUrl("http://192.168.1.50:8787/#x", PRIVATE_NETWORK)).toEqual({
      ok: false,
      error: "hash",
    })
    expect(normalizeServerUrl("http://192.168.1.50:8787/masterhand", PRIVATE_NETWORK)).toEqual({
      ok: false,
      error: "path",
    })
  })
})

describe("isPrivateHostname", () => {
  it("recognizes RFC 1918 and link-local IPv4", () => {
    for (const host of [
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.50",
      "169.254.10.1",
    ]) {
      expect(isPrivateHostname(host)).toBe(true)
    }
  })

  it("rejects public, CGNAT and loopback IPv4", () => {
    for (const host of [
      "172.15.0.1",
      "172.32.0.1",
      "8.8.8.8",
      // CGNAT/Tailscale: already encrypted, plain http would be a downgrade.
      "100.64.0.1",
      // Loopback belongs to isLoopbackHostname, not to the private ranges.
      "127.0.0.1",
    ]) {
      expect(isPrivateHostname(host)).toBe(false)
    }
  })

  it("recognizes ULA and link-local IPv6, bracketed or not", () => {
    for (const host of ["fc00::1", "[fc00::1]", "fd12:3456::1", "[fe80::1]", "fe80::1"]) {
      expect(isPrivateHostname(host)).toBe(true)
    }
  })

  it("strips an IPv6 zone id", () => {
    expect(isPrivateHostname("fe80::1%25wlan0")).toBe(true)
    expect(isPrivateHostname("[fe80::1%wlan0]")).toBe(true)
  })

  it("decodes IPv4-mapped IPv6, including the URL-normalized hex form", () => {
    expect(isPrivateHostname("[::ffff:c0a8:105]")).toBe(true)
    expect(isPrivateHostname("::ffff:192.168.1.5")).toBe(true)
    expect(isPrivateHostname("[::ffff:808:808]")).toBe(false)
  })

  it("rejects public IPv6", () => {
    expect(isPrivateHostname("[2001:db8::1]")).toBe(false)
    expect(isPrivateHostname("::1")).toBe(false)
  })

  it("recognizes .local and .home.arpa names case-insensitively", () => {
    expect(isPrivateHostname("masterhand.local")).toBe(true)
    expect(isPrivateHostname("MASTERHAND.LOCAL")).toBe(true)
    expect(isPrivateHostname("home.home.arpa")).toBe(true)
    expect(isPrivateHostname("nas.local.")).toBe(true)
    expect(isPrivateHostname("home.home.arpa.")).toBe(true)
    expect(isPrivateHostname("evil.local.example.com")).toBe(false)
    expect(isPrivateHostname("masterhand.example.com")).toBe(false)
    expect(isPrivateHostname("localhost")).toBe(false)
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

  it("keeps the original https_required copy by default", () => {
    expect(serverUrlErrorMessage("https_required")).toBe(
      "Use https:// — plain http:// is only allowed for localhost",
    )
  })

  it("mentions private LAN addresses in the https_required copy when enabled", () => {
    expect(serverUrlErrorMessage("https_required", { allowPrivateNetwork: true })).toBe(
      "Use https:// — plain http:// is only allowed for localhost and private LAN addresses",
    )
  })
})
