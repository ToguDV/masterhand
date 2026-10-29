/**
 * Server URL validation for the desktop bootstrap screen. The web app repeats
 * this check (it can add remote profiles), but the shell needs its own guard:
 * the value is persisted and becomes the window's navigation origin, so it
 * must be a plain http(s) origin without credentials, query or path.
 *
 * Kept dependency-free and Electron-free so it can be unit-tested with Node's
 * test runner against the compiled output.
 */

export const MAX_SERVER_URL_LENGTH = 2048

export type ServerUrlResult = { ok: true; url: string } | { ok: false; error: string }

export function normalizeDesktopServerUrl(input: unknown): ServerUrlResult {
  if (typeof input !== "string") return { ok: false, error: "Enter a server URL." }
  const trimmed = input.trim()
  if (!trimmed) return { ok: false, error: "Enter a server URL." }
  if (trimmed.length > MAX_SERVER_URL_LENGTH) {
    return { ok: false, error: "The server URL is too long." }
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, error: "Enter a valid URL, for example https://masterhand.example.com." }
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "Only http:// and https:// URLs are supported." }
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: "Remove the credentials from the URL." }
  }
  if (parsed.search || parsed.hash) {
    return { ok: false, error: "Remove the query string and fragment from the URL." }
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    return { ok: false, error: "Use the server origin without a path." }
  }

  return { ok: true, url: parsed.origin }
}
