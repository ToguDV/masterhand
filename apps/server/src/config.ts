import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
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
  masterhandPassword: string
  sessionSecret: string
  sessionTtlHours: number
  cookieSecure: boolean
  dataDir: string
  webDist: string | null
  allowedOrigins: string[]
  /** Base directory under which every workspace subfolder is created. */
  workspacesRoot: string
  /** Base directory for per-session git worktrees (inside the shared mount). */
  worktreesRoot: string
  /** Author used for commits MasterHand creates in isolated worktrees. */
  gitUserName: string
  gitUserEmail: string
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
}

function intFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function boolFromEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  return value === "true" || value === "1"
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const masterhandPassword = env.MASTERHAND_PASSWORD ?? ""
  if (!masterhandPassword) {
    throw new Error("MASTERHAND_PASSWORD is required (UI access password)")
  }
  const sessionSecret = env.SESSION_SECRET ?? ""
  if (!sessionSecret) {
    throw new Error("SESSION_SECRET is required (cookie/token signing; generate one with `openssl rand -hex 32`)")
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
  return {
    port: intFromEnv(env.PORT, 8787),
    opencodeUrl,
    opencodeAuth,
    // Internal calls are interactive; a wedged upstream must fail fast instead
    // of holding the route (and its socket) open forever.
    opencodeTimeoutMs: Math.max(1000, intFromEnv(env.OPENCODE_TIMEOUT_MS, 10_000)),
    masterhandPassword,
    sessionSecret,
    sessionTtlHours: intFromEnv(env.SESSION_TTL_HOURS, 720),
    cookieSecure: boolFromEnv(env.COOKIE_SECURE, true),
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
    previewEnabled: boolFromEnv(env.PREVIEW_ENABLED, true),
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
  }
}
