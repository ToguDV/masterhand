import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")

function fromRepoRoot(value: string | undefined, fallback: string): string {
  return resolve(repoRoot, value?.trim() || fallback)
}

export interface PreviewPortRange {
  min: number
  max: number
}

export interface Config {
  port: number
  opencodeUrl: string
  opencodeAuth: string | null
  /** Deadline for every internal opencode call (seconds at the HTTP layer). */
  opencodeTimeoutMs: number
  /**
   * Allow loopback targets in provider model discovery. Off by default
   * (SSRF hardening); native installs with a local provider opt in.
   */
  providersAllowLoopback: boolean
  /** Cap on proxied opencode request bodies (MB), so a chunked body cannot OOM the BFF. */
  proxyBodyLimitMb: number
  /** Max size of one chat attachment (MB). Also bounds the upload route's body. */
  attachmentMaxMb: number
  /** Per-session storage cap for chat attachments (MB). */
  attachmentMaxPerSessionMb: number
  /** Retention window for orphaned attachment directories (days; 0 disables). */
  attachmentTtlDays: number
  masterhandPassword: string
  sessionSecret: string
  sessionTtlHours: number
  cookieSecure: boolean
  dataDir: string
  webDist: string | null
  /**
   * CSRF allowlist for cookie mutations; NOT the CORS allowlist. Bearer
   * requests are CORS-open (`*`, without credentials) by design (ADR-39).
   */
  allowedOrigins: string[]
  /** Base directory under which every workspace subfolder is created. */
  workspacesRoot: string
  /** Base directory for per-session git worktrees (inside the shared mount). */
  worktreesRoot: string
  /** Author used for commits MasterHand creates in isolated worktrees. */
  gitUserName: string
  gitUserEmail: string
  /**
   * Release identity served by `/api/status` (#131). Baked in at image build
   * time (`MASTERHAND_VERSION`/`MASTERHAND_BUILD`); local builds report the
   * package version with a `dev` build id.
   */
  version: string
  build: string
  /**
   * `version.json` manifest fetched by `GET /api/update` (#131). Defaults to
   * the file attached to the latest GitHub release.
   */
  updateManifestUrl: string
  /** TTL of the in-memory update manifest cache (10–15 min window). */
  updateCacheMs: number
  /**
   * Opt-in BFF self-updater sidecar (issue #134). `null` keeps the v1 manual
   * flow (`docker compose pull && up -d`); the token is shared only with the
   * updater service on the internal network and never reaches clients.
   */
  updateUrl: string | null
  updateToken: string | null
  /**
   * Docker image tag this deployment tracks. One-click updates require the
   * floating `latest` tag; a pinned deployment keeps the manual command.
   */
  updateTrack: string
  /** Enables the Cloudflare quick-tunnel preview feature. */
  previewEnabled: boolean
  /** Host (no port) where the agent's dev server listens, as seen by the tunnel. */
  previewOrigin: string
  /** Inclusive port pool reserved for session previews. */
  previewPortRange: PreviewPortRange
  /** How long to wait for a fresh tunnel URL to become reachable (0 disables the check). */
  previewReadinessMs: number
  /** `cloudflared` executable name or path. */
  cloudflaredBin: string
  /** Free space on the data volume below which `/api/status` reports `storage.low`. */
  diskLowWatermarkMb: number
  /**
   * MasterHand-owned opencode config file holding custom OpenAI-compatible
   * providers. Lives in opencode's global config dir, loaded with `OPENCODE_CONFIG`.
   */
  customProvidersFile: string
  /**
   * Setuid helper inside the opencode container that launches managed runs as
   * the unprivileged `agent` user. Empty keeps the native behavior (the PTY
   * runs as the user that runs `opencode serve`).
   */
  managedRunLauncher: string
}

function intFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

const TRUE_VALUES = new Set(["true", "1", "yes", "on"])
const FALSE_VALUES = new Set(["false", "0", "no", "off"])

/**
 * Strict boolean parser: a typo ("Truee", "maybe") must fail at boot instead of
 * silently reading as `false` (issue #183). Unset keeps the documented default.
 */
function boolFromEnv(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  const normalized = value.trim().toLowerCase()
  if (TRUE_VALUES.has(normalized)) return true
  if (FALSE_VALUES.has(normalized)) return false
  throw new Error(`${name} must be a boolean (true/false, 1/0, yes/no, on/off); got "${value}"`)
}

const MIN_PRODUCTION_SECRET_BYTES = 32
const OPENSSL_HINT = "generate one with `openssl rand -hex 32`"

/** Stand-ins shipped by the env examples or obviously not secrets. */
const PLACEHOLDER_VALUES = new Set([
  "x",
  "changeme",
  "change-me",
  "change_me",
  "secret",
  "password",
  "example",
  "test",
  "dev-password",
  "dev-session-secret-change-me",
])

const PLACEHOLDER_MARKERS = [
  "changeme",
  "change-me",
  "change_me",
  "placeholder",
  "example",
  "dev-password",
  "dev-session-secret",
  "your-secret",
  "your_secret",
  "replace-me",
  "replace_me",
]

function isPlaceholderSecret(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  return (
    PLACEHOLDER_VALUES.has(normalized) || PLACEHOLDER_MARKERS.some((marker) => normalized.includes(marker))
  )
}

/** Production credentials must be random and long enough to resist guessing. */
function assertStrongSecret(name: string, value: string): void {
  if (isPlaceholderSecret(value)) {
    throw new Error(`${name} looks like an example/placeholder value in production; ${OPENSSL_HINT}`)
  }
  const bytes = Buffer.byteLength(value, "utf8")
  if (bytes < MIN_PRODUCTION_SECRET_BYTES) {
    throw new Error(
      `${name} must be at least ${MIN_PRODUCTION_SECRET_BYTES} bytes in production (got ${bytes}); ${OPENSSL_HINT}`,
    )
  }
}

/** Development keeps working with short values, but the operator is warned. */
function warnWeakDevSecret(name: string, value: string): void {
  if (Buffer.byteLength(value, "utf8") >= MIN_PRODUCTION_SECRET_BYTES && !isPlaceholderSecret(value)) return
  console.warn(
    `[masterhand] ${name} is weak for a deployed server (use at least ${MIN_PRODUCTION_SECRET_BYTES} random bytes; ${OPENSSL_HINT}); allowed because NODE_ENV is not production`,
  )
}

function listFromEnv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

const DEFAULT_PREVIEW_PORT_RANGE: PreviewPortRange = { min: 3200, max: 3299 }

function portRangeFromEnv(value: string | undefined, fallback = DEFAULT_PREVIEW_PORT_RANGE): PreviewPortRange {
  const match = /^\s*(\d{1,5})\s*-\s*(\d{1,5})\s*$/.exec(value ?? "")
  if (!match) return fallback
  const min = Number.parseInt(match[1]!, 10)
  const max = Number.parseInt(match[2]!, 10)
  const valid = (port: number) => port >= 1024 && port <= 65535
  if (!valid(min) || !valid(max) || min > max) return fallback
  return { min, max }
}

/** Host of a URL (no port); used for the tunnel origin when it is not set. */
function hostFromUrl(value: string, fallback: string): string {
  try {
    return new URL(value).hostname || fallback
  } catch {
    return fallback
  }
}

const MAX_LAUNCHER_LENGTH = 256

const UPDATE_TOKEN_MIN_BYTES = 16

/**
 * Opt-in self-updater sidecar (#134). Both the URL and the token are required
 * to enable it; a pinned image tag disables the one-click path (the sidecar
 * would only re-pull the same tag). Misconfiguration fails at boot: a
 * half-configured updater would silently advertise a button that cannot work.
 */
function updaterFromEnv(env: NodeJS.ProcessEnv): {
  url: string | null
  token: string | null
  track: string
} {
  const track = env.MASTERHAND_UPDATE_TRACK?.trim() || "latest"
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(track)) {
    throw new Error(
      `MASTERHAND_UPDATE_TRACK must be a Docker image tag (letters, digits, ".", "_", "-"; max 128); got "${track}"`,
    )
  }

  const rawUrl = env.MASTERHAND_UPDATE_URL?.trim() ?? ""
  const token = env.MASTERHAND_UPDATE_TOKEN?.trim() ?? ""
  if (!rawUrl) {
    if (token) {
      throw new Error("MASTERHAND_UPDATE_TOKEN is set but MASTERHAND_UPDATE_URL is empty")
    }
    return { url: null, token: null, track }
  }

  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error(`MASTERHAND_UPDATE_URL is not a valid URL (got "${rawUrl}")`)
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("MASTERHAND_UPDATE_URL must be an http:// or https:// URL")
  }
  if (parsed.username || parsed.password) {
    throw new Error("MASTERHAND_UPDATE_URL must not contain credentials")
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new Error("MASTERHAND_UPDATE_URL must be an origin without a path")
  }
  if (parsed.search || parsed.hash) {
    throw new Error("MASTERHAND_UPDATE_URL must not contain a query string or fragment")
  }
  if (!token) {
    throw new Error("MASTERHAND_UPDATE_URL requires MASTERHAND_UPDATE_TOKEN")
  }
  if (Buffer.byteLength(token, "utf8") < UPDATE_TOKEN_MIN_BYTES) {
    throw new Error(
      `MASTERHAND_UPDATE_TOKEN must be at least ${UPDATE_TOKEN_MIN_BYTES} bytes (generate one with \`openssl rand -hex 32\`)`,
    )
  }

  return { url: parsed.origin, token, track }
}

/**
 * The managed-run launcher is executed by opencode inside its own container, so
 * it must be an absolute container path — a host path or bare name would fail
 * at the first Start with an opaque spawn error. Empty keeps native installs
 * working (the PTY runs as the user that runs `opencode serve`).
 */
function launcherFromEnv(value: string | undefined): string {
  const launcher = value?.trim() ?? ""
  if (!launcher) return ""
  if (launcher.length > MAX_LAUNCHER_LENGTH || /[\u0000-\u001f\u007f]/.test(launcher)) {
    throw new Error(
      `MANAGED_RUN_LAUNCHER must be at most ${MAX_LAUNCHER_LENGTH} characters with no control characters`,
    )
  }
  if (!isAbsolute(launcher)) {
    throw new Error(`MANAGED_RUN_LAUNCHER must be an absolute path inside the opencode container (got "${launcher}")`)
  }
  return launcher
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const masterhandPassword = env.MASTERHAND_PASSWORD ?? ""
  if (!masterhandPassword) {
    throw new Error("MASTERHAND_PASSWORD is required (UI access password)")
  }
  const sessionSecret = env.SESSION_SECRET ?? ""
  if (!sessionSecret) {
    throw new Error("SESSION_SECRET is required (cookie/token signing; generate one with `openssl rand -hex 32`)")
  }
  if (env.NODE_ENV === "production") {
    assertStrongSecret("MASTERHAND_PASSWORD", masterhandPassword)
    assertStrongSecret("SESSION_SECRET", sessionSecret)
  } else {
    warnWeakDevSecret("MASTERHAND_PASSWORD", masterhandPassword)
    warnWeakDevSecret("SESSION_SECRET", sessionSecret)
  }

  const opencodeUsername = env.OPENCODE_SERVER_USERNAME ?? "opencode"
  const opencodePassword = env.OPENCODE_SERVER_PASSWORD ?? ""
  const opencodeAuth = opencodePassword
    ? `Basic ${Buffer.from(`${opencodeUsername}:${opencodePassword}`).toString("base64")}`
    : null

  const allowedOrigins = new Set(listFromEnv(env.ALLOWED_ORIGINS))
  if (env.NODE_ENV !== "production") {
    allowedOrigins.add("http://localhost:5173")
    allowedOrigins.add("http://127.0.0.1:5173")
  }

  const workspacesRoot = fromRepoRoot(env.WORKSPACES_ROOT, "workspace")
  const opencodeUrl = env.OPENCODE_URL ?? "http://127.0.0.1:4096"
  const updater = updaterFromEnv(env)
  const cookieSecure = boolFromEnv("COOKIE_SECURE", env.COOKIE_SECURE, true)
  if (!cookieSecure) {
    // The BFF listens on every interface; without HTTPS the session cookie
    // travels in clear text. Keep the documented dev setup working, loudly.
    console.warn(
      "[masterhand] COOKIE_SECURE=false: session cookies are sent over plain HTTP; enable TLS before exposing this server",
    )
  }
  return {
    port: intFromEnv(env.PORT, 8787),
    opencodeUrl,
    opencodeAuth,
    // Internal calls are interactive; a wedged upstream must fail fast instead
    // of holding the route (and its socket) open forever.
    opencodeTimeoutMs: Math.max(1000, intFromEnv(env.OPENCODE_TIMEOUT_MS, 10_000)),
    // Prompts can be large; the cap keeps a chunked body from being buffered
    // without bound (issue #180). 1 MB..1 GB.
    proxyBodyLimitMb: Math.min(1024, Math.max(1, intFromEnv(env.PROXY_BODY_LIMIT_MB, 10))),
    // One attachment is bounded independently from the prompt proxy: the file
    // travels as multipart to the BFF, never base64 through the opencode proxy.
    attachmentMaxMb: Math.min(200, Math.max(1, intFromEnv(env.ATTACHMENT_MAX_MB, 50))),
    attachmentMaxPerSessionMb: Math.min(10_240, Math.max(1, intFromEnv(env.ATTACHMENT_MAX_PER_SESSION_MB, 1000))),
    attachmentTtlDays: Math.min(3650, Math.max(0, intFromEnv(env.ATTACHMENT_TTL_DAYS, 90))),
    providersAllowLoopback: boolFromEnv("PROVIDERS_ALLOW_LOOPBACK", env.PROVIDERS_ALLOW_LOOPBACK, false),
    masterhandPassword,
    sessionSecret,
    sessionTtlHours: intFromEnv(env.SESSION_TTL_HOURS, 720),
    cookieSecure,
    dataDir: fromRepoRoot(env.DATA_DIR, "data"),
    webDist: env.WEB_DIST === "" ? null : (env.WEB_DIST ?? "apps/web/dist"),
    allowedOrigins: [...allowedOrigins],
    workspacesRoot,
    // Worktrees must live inside the shared mount so opencode sees them.
    worktreesRoot: env.WORKTREES_ROOT?.trim()
      ? fromRepoRoot(env.WORKTREES_ROOT, ".worktrees")
      : resolve(workspacesRoot, ".worktrees"),
    gitUserName: env.GIT_COMMIT_NAME?.trim() || "MasterHand",
    gitUserEmail: env.GIT_COMMIT_EMAIL?.trim() || "masterhand@localhost",
    version: env.MASTERHAND_VERSION?.trim() || "0.1.0",
    build: env.MASTERHAND_BUILD?.trim() || "dev",
    updateManifestUrl:
      env.UPDATE_MANIFEST_URL?.trim() ||
      "https://github.com/togudv/masterhand/releases/latest/download/version.json",
    updateCacheMs: Math.min(
      15 * 60 * 1000,
      Math.max(10 * 60 * 1000, intFromEnv(env.UPDATE_CACHE_MS, 12 * 60 * 1000)),
    ),
    updateUrl: updater.url,
    updateToken: updater.token,
    updateTrack: updater.track,
    previewEnabled: boolFromEnv("PREVIEW_ENABLED", env.PREVIEW_ENABLED, true),
    // In Docker the tunnel targets the opencode container by service name; in
    // development both processes run on the host.
    previewOrigin: env.PREVIEW_ORIGIN?.trim() || hostFromUrl(opencodeUrl, "127.0.0.1"),
    previewPortRange: portRangeFromEnv(env.PREVIEW_PORT_RANGE),
    previewReadinessMs: intFromEnv(env.PREVIEW_READINESS_MS, 25_000),
    cloudflaredBin: env.CLOUDFLARED_BIN?.trim() || "cloudflared",
    // A runaway build or agent workspace filling the shared disk takes SQLite
    // and git down with it; surface headroom below this watermark (0 disables).
    diskLowWatermarkMb: Math.max(0, intFromEnv(env.DISK_LOW_WATERMARK_MB, 512)),
    // Defaults next to opencode's own config: in Docker both containers share
    // the `opencode_config` volume at /home/node/.config/opencode, and natively
    // both run under the same HOME.
    customProvidersFile:
      env.OPENCODE_CUSTOM_PROVIDERS_FILE?.trim() ||
      join(homedir(), ".config", "opencode", "masterhand-providers.json"),
    managedRunLauncher: launcherFromEnv(env.MANAGED_RUN_LAUNCHER),
  }
}
