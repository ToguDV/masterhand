/**
 * Local-bundle protocol for the desktop shell.
 *
 * The installer ships the web build and serves it from a privileged
 * `masterhand://app` origin, so the app's own Servers screen owns server
 * selection and the shell never needs a remote origin to boot.
 *
 * URL resolution is kept dependency-free and Electron-free so the desktop
 * test runner can cover traversal and MIME mapping with plain Node.
 */

import { extname, resolve, sep } from "node:path"

export const APP_SCHEME = "masterhand"
export const APP_HOST = "app"
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`
export const APP_URL = `${APP_ORIGIN}/index.html`

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
}

export interface ResolvedAsset {
  /** Absolute path inside the bundled renderer directory. */
  file: string
  /** Response content type derived from the extension. */
  mime: string
}

/**
 * True when `value` belongs to the bundled app origin. Node's `URL` reports
 * non-special schemes with an opaque origin (`"null"`), so the navigation
 * guard must compare scheme + host rather than `origin`.
 */
export function isAppUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === `${APP_SCHEME}:` && url.host === APP_HOST
  } catch {
    return false
  }
}

/**
 * Maps a `masterhand://app/...` request to a file under `root`.
 *
 * Returns `null` for another host, another scheme, a malformed URL, a NUL
 * byte, or any path that would escape `root` after decoding (encoded
 * separators such as `%2f`). The root itself serves `index.html`.
 */
export function resolveAppAsset(root: string, requestUrl: string): ResolvedAsset | null {
  let url: URL
  try {
    url = new URL(requestUrl)
  } catch {
    return null
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) return null

  let pathname: string
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return null
  }
  if (pathname.includes("\0")) return null
  if (pathname === "" || pathname === "/") pathname = "/index.html"

  const base = resolve(root)
  const file = resolve(base, `.${pathname}`)
  if (file !== base && !file.startsWith(`${base}${sep}`)) return null

  return {
    file,
    mime: MIME_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
  }
}
