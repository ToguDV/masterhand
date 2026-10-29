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

export const MAX_SERVER_URL_LENGTH = 2048
export const MAX_SERVER_LABEL_LENGTH = 64

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
 * Normalizes a user-entered server URL:
 * - trims, accepts scheme-less input by assuming `https://`
 * - requires `https://` except on loopback hosts
 * - rejects credentials, query strings, hashes and non-root paths
 * - strips trailing slashes and default ports through `URL.origin`
 */
export function normalizeServerUrl(input: string): NormalizeServerUrlResult {
  const trimmed = input.trim()
  if (!trimmed) return { ok: false, error: "empty" }
  if (trimmed.length > MAX_SERVER_URL_LENGTH) return { ok: false, error: "too_long" }

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`

  let parsed: URL
  try {
    parsed = new URL(withScheme)
  } catch {
    return { ok: false, error: "invalid" }
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, error: "invalid" }
  }
  if (parsed.username || parsed.password) return { ok: false, error: "credentials" }
  if (parsed.search) return { ok: false, error: "query" }
  if (parsed.hash) return { ok: false, error: "hash" }
  if (parsed.pathname.replace(/\/+$/, "") !== "") return { ok: false, error: "path" }
  if (parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname)) {
    return { ok: false, error: "https_required" }
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
export function serverUrlErrorMessage(error: ServerUrlError): string {
  switch (error) {
    case "empty":
      return "Enter the server URL"
    case "too_long":
      return "That URL is too long"
    case "https_required":
      return "Use https:// — plain http:// is only allowed for localhost"
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
