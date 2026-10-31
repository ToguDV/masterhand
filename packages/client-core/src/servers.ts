/**
 * Multi-server profile helpers shared by web/desktop and mobile.
 *
 * These functions are pure on purpose: URL normalization, label/monogram
 * defaults and credential-mode selection must behave identically on every
 * client, while each platform keeps its own storage (localStorage or
 * SecureStore).
 */

export type ServerAuthMode = "cookie" | "device"

export interface NormalizedServerUrl {
  /** Canonical origin used as the client's base URL (no trailing slash). */
  url: string
  /** Canonical origin used for equality checks. */
  origin: string
  /** Hostname without credentials, port or brackets normalization surprises. */
  hostname: string
}

export type ServerUrlError =
  | "empty"
  | "invalid"
  | "too_long"
  | "https_required"
  | "credentials"
  | "query"
  | "hash"
  | "path"

export type NormalizeServerUrlResult =
  | { ok: true; server: NormalizedServerUrl }
  | { ok: false; error: ServerUrlError }

export interface NormalizeServerUrlOptions {
  /**
   * Accept plain `http://` for private and link-local hosts (RFC 1918, ULA,
   * link-local, `.local` / `.home.arpa` names). Native mobile only: a phone
   * on the same LAN cannot present a publicly trusted certificate.
   */
  allowPrivateNetwork?: boolean
  /**
   * Accept plain `http://` for this exact origin (the page that served the
   * client). Its HttpOnly cookie never leaves that origin, so the same-origin
   * exception is safe even on a LAN deployment without TLS.
   */
  allowInsecureOrigin?: string | null
  /**
   * Accept any plain `http://` origin. Only for migrating pre-multi-server
   * mobile sessions whose URL may be a LAN address; new remote servers must
   * still use https.
   */
  allowInsecure?: boolean
}

function originOf(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

export const MAX_SERVER_URL_LENGTH = 2048
export const MAX_SERVER_LABEL_LENGTH = 64
export const MAX_SERVER_PROFILES = 50

/** Loopback hosts may use plain `http://` (local development). */
export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "[::1]" ||
    normalized === "::1"
  )
}

/**
 * Private and link-local hosts where plain `http://` may be acceptable for a
 * native client on the same network: RFC 1918 / link-local IPv4, ULA /
 * link-local IPv6, IPv4-mapped IPv6 and `.local` / `.home.arpa` names.
 *
 * CGNAT (100.64/10, Tailscale) and public addresses stay out: Tailscale
 * already encrypts, so accepting http there would be a silent downgrade.
 * Loopback keeps its own meaning in `isLoopbackHostname`.
 */
export function isPrivateHostname(hostname: string): boolean {
  let host = hostname.trim().toLowerCase()
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1)
  // `new URL` rejects zone ids, but direct callers may still pass them.
  const zone = host.indexOf("%")
  if (zone !== -1) host = host.slice(0, zone)

  // A trailing root dot is the same name to DNS but hides the suffix.
  const name = host.endsWith(".") ? host.slice(0, -1) : host
  if (name.endsWith(".local") || name.endsWith(".home.arpa")) return true

  const ipv4 = parseIpv4(host)
  if (ipv4 !== null) return isPrivateIpv4(ipv4)

  if (!host.includes(":")) return false

  const mapped = /^::ffff:(.+)$/.exec(host)
  if (mapped) {
    const rest = mapped[1]!
    const embedded = parseIpv4(rest) ?? parseMappedIpv4(rest)
    return embedded !== null && isPrivateIpv4(embedded)
  }

  const first = Number.parseInt(host.split(":")[0]!, 16)
  if (Number.isNaN(first)) return false
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80
}

function parseIpv4(value: string): [number, number, number, number] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value)
  if (!match) return null
  const octets = match.slice(1).map((octet) => Number(octet))
  if (octets.some((octet) => octet > 255)) return null
  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!]
}

function isPrivateIpv4(octets: readonly [number, number, number, number]): boolean {
  const [first, second] = octets
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  )
}

/** `<hex>:<hex>` is the URL-normalized form of `::ffff:a.b.c.d`. */
function parseMappedIpv4(value: string): [number, number, number, number] | null {
  const groups = value.split(":")
  if (groups.length !== 2) return null
  const high = parseHexGroup(groups[0]!)
  const low = parseHexGroup(groups[1]!)
  if (high === null || low === null) return null
  return [high >> 8, high & 0xff, low >> 8, low & 0xff]
}

function parseHexGroup(value: string): number | null {
  if (!/^[0-9a-f]{1,4}$/.test(value)) return null
  return Number.parseInt(value, 16)
}

/**
 * Normalizes a user-entered server URL:
 * - trims, accepts scheme-less input by assuming `https://` (or `http://` for
 *   private LAN hosts when `allowPrivateNetwork` is enabled)
 * - requires `https://` except on loopback hosts and, when enabled, private
 *   network hosts
 * - rejects credentials, query strings, hashes and non-root paths
 * - strips trailing slashes and default ports through `URL.origin`
 */
export function normalizeServerUrl(
  input: string,
  options: NormalizeServerUrlOptions = {},
): NormalizeServerUrlResult {
  const trimmed = input.trim()
  if (!trimmed) return { ok: false, error: "empty" }
  if (trimmed.length > MAX_SERVER_URL_LENGTH) return { ok: false, error: "too_long" }

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
  const withScheme = hasScheme ? trimmed : `https://${trimmed}`

  let parsed: URL
  try {
    parsed = new URL(withScheme)
  } catch {
    return { ok: false, error: "invalid" }
  }

  if (!hasScheme && options.allowPrivateNetwork === true && isPrivateHostname(parsed.hostname)) {
    // An explicit conventional TLS port means the server speaks TLS: guessing
    // http would send a cleartext client to a TLS listener. Read the port from
    // the http candidate because the https parse drops 443.
    const httpCandidate = new URL(`http://${trimmed}`)
    if (httpCandidate.port !== "443" && httpCandidate.port !== "8443") parsed = httpCandidate
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, error: "invalid" }
  }
  if (parsed.username || parsed.password) return { ok: false, error: "credentials" }
  if (parsed.search) return { ok: false, error: "query" }
  if (parsed.hash) return { ok: false, error: "hash" }
  if (parsed.pathname.replace(/\/+$/, "") !== "") return { ok: false, error: "path" }
  if (parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname)) {
    const allowedOrigin = originOf(options.allowInsecureOrigin)
    const privateAllowed =
      options.allowPrivateNetwork === true && isPrivateHostname(parsed.hostname)
    const insecureAllowed =
      privateAllowed ||
      options.allowInsecure === true ||
      (allowedOrigin !== null && parsed.origin === allowedOrigin)
    if (!insecureAllowed) return { ok: false, error: "https_required" }
  }

  const origin = parsed.origin
  if (!origin || origin === "null" || origin.length > MAX_SERVER_URL_LENGTH) {
    return { ok: false, error: origin.length > MAX_SERVER_URL_LENGTH ? "too_long" : "invalid" }
  }
  return {
    ok: true,
    server: { url: origin, origin, hostname: parsed.hostname },
  }
}

/** Default label for a server: its hostname without a leading `www.`. */
export function defaultServerLabel(server: NormalizedServerUrl | string): string {
  const hostname = typeof server === "string" ? hostnameOf(server) : server.hostname
  return hostname.replace(/^www\./i, "")
}

function hostnameOf(value: string): string {
  try {
    return new URL(value).hostname
  } catch {
    return value.trim()
  }
}

/**
 * Two-letter uppercase monogram: first letters of up to two words, otherwise
 * the first two alphanumerics. Falls back to a stable `MH`.
 */
export function serverMonogram(label: string, fallback = ""): string {
  const words = label
    .trim()
    .split(/[\s._\-/]+/)
    .filter(Boolean)
  if (words.length >= 2) {
    const pair = `${alphanumeric(words[0]!)[0] ?? ""}${alphanumeric(words[1]!)[0] ?? ""}`
    if (/^[a-z]{2}$/i.test(pair)) return pair.toUpperCase()
  }
  const single = words.join("")
  const letters = alphanumeric(single).slice(0, 2)
  if (letters.length === 2) return letters.toUpperCase()
  const fallbackLetters = alphanumeric(fallback).slice(0, 2)
  return (letters || fallbackLetters || "MH").toUpperCase()
}

function alphanumeric(value: string): string {
  return value.replace(/[^\p{L}\p{N}]/gu, "")
}

/** Trims and caps a user-entered label, falling back to the hostname. */
export function normalizeServerLabel(label: string | null | undefined, url: string): string {
  const trimmed = (label ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .replace(/\s+/g, " ")
  if (!trimmed) return defaultServerLabel(url)
  return trimmed.slice(0, MAX_SERVER_LABEL_LENGTH)
}

/** Current browser origin, when one exists (web/desktop). Native passes its own. */
export function browserOrigin(): string | null {
  const location = (globalThis as { location?: { origin?: string } }).location
  return location?.origin ?? null
}

/** True when `url` has the same origin as `currentOrigin`. */
export function isSameOrigin(url: string, currentOrigin: string | null = browserOrigin()): boolean {
  if (!currentOrigin) return false
  try {
    return new URL(url).origin === new URL(currentOrigin).origin
  } catch {
    return false
  }
}

/**
 * Cookie auth is only possible for the origin that served the page; every
 * other server needs its own device token.
 */
export function serverAuthMode(
  url: string,
  currentOrigin: string | null = browserOrigin(),
): ServerAuthMode {
  return isSameOrigin(url, currentOrigin) ? "cookie" : "device"
}

/**
 * Browsers block `https:` pages from calling plain `http:` remotes. Loopback
 * hosts are exempt (they are considered potentially trustworthy).
 */
export function isMixedContentBlocked(
  url: string,
  pageUrl: string | null = browserOrigin(),
): boolean {
  if (!pageUrl) return false
  try {
    const target = new URL(url)
    const page = new URL(pageUrl)
    return page.protocol === "https:" && target.protocol === "http:" && !isLoopbackHostname(target.hostname)
  } catch {
    return false
  }
}

/** User-facing copy for a rejected URL (English, shared by both clients). */
export function serverUrlErrorMessage(
  error: ServerUrlError,
  options: { allowPrivateNetwork?: boolean } = {},
): string {
  switch (error) {
    case "empty":
      return "Enter the server URL"
    case "too_long":
      return "That URL is too long"
    case "https_required":
      return options.allowPrivateNetwork === true
        ? "Use https:// — plain http:// is only allowed for localhost and private LAN addresses"
        : "Use https:// — plain http:// is only allowed for localhost"
    case "credentials":
      return "Remove the username or password from the URL"
    case "query":
      return "Remove the query string from the URL"
    case "hash":
      return "Remove the # fragment from the URL"
    case "path":
      return "Use the server root URL without a path"
    case "invalid":
      return "Enter a valid URL, for example https://masterhand.example.com"
  }
}
