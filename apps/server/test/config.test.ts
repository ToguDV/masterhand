import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { loadConfig } from "../src/config.js"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const strongSecret = "0123456789abcdef".repeat(4)
let warnings: string[]

beforeEach(() => {
  warnings = []
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(" "))
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { MASTERHAND_PASSWORD: "pw", SESSION_SECRET: "secret", ...overrides }
}

/** A production environment whose secrets satisfy the hardened checks. */
function prodEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return env({ NODE_ENV: "production", MASTERHAND_PASSWORD: strongSecret, SESSION_SECRET: strongSecret, ...overrides })
}

describe("loadConfig", () => {
  it("throws when the masterhand password is missing", () => {
    expect(() => loadConfig({ SESSION_SECRET: "secret", MASTERHAND_PASSWORD: undefined })).toThrow(
      /MASTERHAND_PASSWORD/,
    )
    expect(() => loadConfig({ SESSION_SECRET: "secret", MASTERHAND_PASSWORD: "" })).toThrow(
      /MASTERHAND_PASSWORD/,
    )
  })

  it("throws when the session secret is missing", () => {
    expect(() => loadConfig({ MASTERHAND_PASSWORD: "pw", SESSION_SECRET: undefined })).toThrow(/SESSION_SECRET/)
    expect(() => loadConfig({ MASTERHAND_PASSWORD: "pw", SESSION_SECRET: "" })).toThrow(/SESSION_SECRET/)
  })

  it("applies the documented defaults", () => {
    const config = loadConfig(env())
    expect(config).toMatchObject({
      port: 8787,
      opencodeUrl: "http://127.0.0.1:4096",
      opencodeAuth: null,
      masterhandPassword: "pw",
      sessionSecret: "secret",
      sessionTtlHours: 720,
      cookieSecure: true,
      dataDir: resolve(repoRoot, "data"),
      webDist: "apps/web/dist",
    })
  })

  it("parses numeric overrides and falls back on invalid values", () => {
    expect(loadConfig(env({ PORT: "9123", SESSION_TTL_HOURS: "1" }))).toMatchObject({
      port: 9123,
      sessionTtlHours: 1,
    })
    expect(loadConfig(env({ PORT: "not-a-number" })).port).toBe(8787)
  })

  it("bounds the proxy body cap", () => {
    expect(loadConfig(env()).proxyBodyLimitMb).toBe(10)
    expect(loadConfig(env({ PROXY_BODY_LIMIT_MB: "32" })).proxyBodyLimitMb).toBe(32)
    expect(loadConfig(env({ PROXY_BODY_LIMIT_MB: "0" })).proxyBodyLimitMb).toBe(1)
    expect(loadConfig(env({ PROXY_BODY_LIMIT_MB: "99999" })).proxyBodyLimitMb).toBe(1024)
    expect(loadConfig(env({ PROXY_BODY_LIMIT_MB: "nope" })).proxyBodyLimitMb).toBe(10)
  })

  it("allows loopback provider discovery only when explicitly enabled", () => {
    expect(loadConfig(env()).providersAllowLoopback).toBe(false)
    expect(loadConfig(env({ PROVIDERS_ALLOW_LOOPBACK: "true" })).providersAllowLoopback).toBe(true)
    expect(() => loadConfig(env({ PROVIDERS_ALLOW_LOOPBACK: "maybe" }))).toThrow(/PROVIDERS_ALLOW_LOOPBACK/)
  })
  it("defaults the low-disk watermark and accepts overrides including zero", () => {
    expect(loadConfig(env()).diskLowWatermarkMb).toBe(512)
    expect(loadConfig(env({ DISK_LOW_WATERMARK_MB: "2048" })).diskLowWatermarkMb).toBe(2048)
    expect(loadConfig(env({ DISK_LOW_WATERMARK_MB: "0" })).diskLowWatermarkMb).toBe(0)
    expect(loadConfig(env({ DISK_LOW_WATERMARK_MB: "-5" })).diskLowWatermarkMb).toBe(0)
    expect(loadConfig(env({ DISK_LOW_WATERMARK_MB: "nope" })).diskLowWatermarkMb).toBe(512)
  })

  it("parses boolean overrides", () => {
    expect(loadConfig(env({ COOKIE_SECURE: "true" })).cookieSecure).toBe(true)
    expect(loadConfig(env({ COOKIE_SECURE: "1" })).cookieSecure).toBe(true)
    expect(loadConfig(env({ COOKIE_SECURE: "false" })).cookieSecure).toBe(false)
  })

  it("accepts documented boolean spellings regardless of case", () => {
    for (const value of ["true", "True", "TRUE", "1", "yes", "YES", "on", " On "]) {
      expect(loadConfig(env({ COOKIE_SECURE: value })).cookieSecure).toBe(true)
    }
    for (const value of ["false", "False", "FALSE", "0", "no", "OFF"]) {
      expect(loadConfig(env({ COOKIE_SECURE: value })).cookieSecure).toBe(false)
    }
    expect(loadConfig(env({ PREVIEW_ENABLED: "Yes" })).previewEnabled).toBe(true)
    expect(loadConfig(env({ PREVIEW_ENABLED: "off" })).previewEnabled).toBe(false)
  })

  it("rejects unrecognized boolean values naming the variable", () => {
    expect(() => loadConfig(env({ COOKIE_SECURE: "maybe" }))).toThrow(/COOKIE_SECURE[^\n]*maybe/)
    expect(() => loadConfig(env({ PREVIEW_ENABLED: "Maybe" }))).toThrow(/PREVIEW_ENABLED[^\n]*Maybe/)
    expect(() => loadConfig(env({ COOKIE_SECURE: "" }))).toThrow(/COOKIE_SECURE/)
  })

  it("warns when the cookie Secure flag is disabled", () => {
    expect(loadConfig(env({ COOKIE_SECURE: "true" })).cookieSecure).toBe(true)
    expect(warnings.some((line) => line.includes("COOKIE_SECURE"))).toBe(false)

    expect(loadConfig(env({ COOKIE_SECURE: "false" })).cookieSecure).toBe(false)
    expect(warnings.some((line) => line.includes("COOKIE_SECURE") && line.includes("false"))).toBe(true)
  })

  it("requires strong, non-placeholder secrets in production", () => {
    expect(loadConfig(prodEnv()).sessionSecret).toBe(strongSecret)
    expect(() => loadConfig(prodEnv({ SESSION_SECRET: "short-secret" }))).toThrow(/SESSION_SECRET[^\n]*32/)
    expect(() => loadConfig(prodEnv({ MASTERHAND_PASSWORD: "short-password" }))).toThrow(/MASTERHAND_PASSWORD[^\n]*32/)
    expect(() => loadConfig(prodEnv({ SESSION_SECRET: "changeme-changeme-changeme-changeme" }))).toThrow(
      /SESSION_SECRET[^\n]*placeholder/i,
    )
    expect(() => loadConfig(prodEnv({ MASTERHAND_PASSWORD: "example-example-example-example-example" }))).toThrow(
      /MASTERHAND_PASSWORD[^\n]*placeholder/i,
    )
    expect(() => loadConfig(prodEnv({ SESSION_SECRET: "dev-session-secret-change-me" }))).toThrow(
      /SESSION_SECRET[^\n]*placeholder/i,
    )
  })

  it("keeps short development secrets working with a warning", () => {
    const config = loadConfig(env({ MASTERHAND_PASSWORD: "pw", SESSION_SECRET: "secret" }))
    expect(config.sessionSecret).toBe("secret")
    expect(warnings.some((line) => line.includes("SESSION_SECRET"))).toBe(true)
  })

  it("disables webDist when WEB_DIST is an empty string", () => {
    expect(loadConfig(env({ WEB_DIST: "" })).webDist).toBeNull()
  })

  it("builds the opencode basic auth header with the default username", () => {
    const config = loadConfig(env({ OPENCODE_SERVER_PASSWORD: "oc" }))
    expect(config.opencodeAuth).toBe(`Basic ${Buffer.from("opencode:oc").toString("base64")}`)
  })

  it("respects a custom opencode username", () => {
    const config = loadConfig(env({ OPENCODE_SERVER_USERNAME: "admin", OPENCODE_SERVER_PASSWORD: "oc" }))
    expect(config.opencodeAuth).toBe(`Basic ${Buffer.from("admin:oc").toString("base64")}`)
  })

  it("parses and trims the allowed origins list", () => {
    const config = loadConfig(prodEnv({ ALLOWED_ORIGINS: " https://a.example , https://b.example ,," }))
    expect(config.allowedOrigins.sort()).toEqual(["https://a.example", "https://b.example"])
  })

  it("resolves data and workspaces roots against the repo root, not the cwd", () => {
    expect(loadConfig(env()).dataDir).toBe(resolve(repoRoot, "data"))
    expect(loadConfig(env()).workspacesRoot).toBe(resolve(repoRoot, "workspace"))
    expect(loadConfig(env({ WORKSPACES_ROOT: " /srv/workspaces " })).workspacesRoot).toBe("/srv/workspaces")
    expect(loadConfig(env({ WORKSPACES_ROOT: "" })).workspacesRoot).toBe(resolve(repoRoot, "workspace"))
    expect(loadConfig(env({ WORKSPACES_ROOT: "./custom" })).workspacesRoot).toBe(resolve(repoRoot, "custom"))
    expect(loadConfig(env({ DATA_DIR: "/var/lib/masterhand" })).dataDir).toBe("/var/lib/masterhand")
  })

  it("adds the local dev origins outside production", () => {
    const dev = loadConfig(env())
    expect(dev.allowedOrigins).toContain("http://localhost:5173")
    expect(dev.allowedOrigins).toContain("http://127.0.0.1:5173")

    const prod = loadConfig(prodEnv())
    expect(prod.allowedOrigins).not.toContain("http://localhost:5173")
  })

  it("applies the preview defaults and derives the tunnel origin from opencode", () => {
    const config = loadConfig(env())
    expect(config.previewEnabled).toBe(true)
    expect(config.previewOrigin).toBe("127.0.0.1")
    expect(config.previewPortRange).toEqual({ min: 3200, max: 3299 })
    expect(config.previewReadinessMs).toBe(25_000)
    expect(config.cloudflaredBin).toBe("cloudflared")

    const docker = loadConfig(env({ OPENCODE_URL: "http://opencode:4096" }))
    expect(docker.previewOrigin).toBe("opencode")
  })

  it("parses preview overrides", () => {
    const config = loadConfig(
      env({
        PREVIEW_ENABLED: "false",
        PREVIEW_ORIGIN: " 10.0.0.5 ",
        PREVIEW_PORT_RANGE: " 4000 - 4009 ",
        PREVIEW_READINESS_MS: "0",
        CLOUDFLARED_BIN: "/usr/local/bin/cloudflared",
      }),
    )
    expect(config.previewEnabled).toBe(false)
    expect(config.previewOrigin).toBe("10.0.0.5")
    expect(config.previewPortRange).toEqual({ min: 4000, max: 4009 })
    expect(config.previewReadinessMs).toBe(0)
    expect(config.cloudflaredBin).toBe("/usr/local/bin/cloudflared")
  })

  it("falls back to the default preview port range when it is invalid", () => {
    expect(loadConfig(env({ PREVIEW_PORT_RANGE: "nope" })).previewPortRange).toEqual({ min: 3200, max: 3299 })
    expect(loadConfig(env({ PREVIEW_PORT_RANGE: "4000-3000" })).previewPortRange).toEqual({ min: 3200, max: 3299 })
    expect(loadConfig(env({ PREVIEW_PORT_RANGE: "80-90" })).previewPortRange).toEqual({ min: 3200, max: 3299 })
    expect(loadConfig(env({ PREVIEW_PORT_RANGE: "70000-80000" })).previewPortRange).toEqual({ min: 3200, max: 3299 })
  })

  it("defaults the managed-run launcher to empty (native development)", () => {
    expect(loadConfig(env()).managedRunLauncher).toBe("")
    expect(loadConfig(env({ MANAGED_RUN_LAUNCHER: "   " })).managedRunLauncher).toBe("")
  })

  it("accepts an absolute managed-run launcher path", () => {
    expect(loadConfig(env({ MANAGED_RUN_LAUNCHER: " /usr/local/bin/agent-exec " })).managedRunLauncher).toBe(
      "/usr/local/bin/agent-exec",
    )
  })

  it("rejects a relative, overly long or control-character launcher path", () => {
    expect(() => loadConfig(env({ MANAGED_RUN_LAUNCHER: "bin/agent-exec" }))).toThrow(
      /MANAGED_RUN_LAUNCHER[^\n]*absolute/,
    )
    expect(() => loadConfig(env({ MANAGED_RUN_LAUNCHER: `/${"a".repeat(256)}` }))).toThrow(/MANAGED_RUN_LAUNCHER/)
    expect(() => loadConfig(env({ MANAGED_RUN_LAUNCHER: "/usr/local/bin/agent\n-exec" }))).toThrow(
      /MANAGED_RUN_LAUNCHER/,
    )
  })

  describe("self-updater (#134)", () => {
    const token = "0123456789abcdef0123456789abcdef"

    it("is disabled by default and tracks latest", () => {
      const config = loadConfig(env())
      expect(config.updateUrl).toBeNull()
      expect(config.updateToken).toBeNull()
      expect(config.updateTrack).toBe("latest")
    })

    it("accepts a sidecar origin and token, normalizing the URL", () => {
      const config = loadConfig(
        env({
          MASTERHAND_UPDATE_URL: " http://updater:8080/ ",
          MASTERHAND_UPDATE_TOKEN: ` ${token} `,
          MASTERHAND_UPDATE_TRACK: "latest",
        }),
      )
      expect(config.updateUrl).toBe("http://updater:8080")
      expect(config.updateToken).toBe(token)
      expect(config.updateTrack).toBe("latest")
    })

    it("rejects a half-configured, invalid or weak updater", () => {
      expect(() => loadConfig(env({ MASTERHAND_UPDATE_URL: "http://updater:8080" }))).toThrow(
        /MASTERHAND_UPDATE_URL requires MASTERHAND_UPDATE_TOKEN/,
      )
      expect(() => loadConfig(env({ MASTERHAND_UPDATE_TOKEN: token }))).toThrow(
        /MASTERHAND_UPDATE_TOKEN is set but MASTERHAND_UPDATE_URL is empty/,
      )
      expect(() => loadConfig(env({ MASTERHAND_UPDATE_URL: "not a url", MASTERHAND_UPDATE_TOKEN: token }))).toThrow(
        /MASTERHAND_UPDATE_URL is not a valid URL/,
      )
      expect(() =>
        loadConfig(env({ MASTERHAND_UPDATE_URL: "ftp://updater:8080", MASTERHAND_UPDATE_TOKEN: token })),
      ).toThrow(/http:\/\/ or https:\/\//)
      expect(() =>
        loadConfig(env({ MASTERHAND_UPDATE_URL: "http://updater:8080/admin", MASTERHAND_UPDATE_TOKEN: token })),
      ).toThrow(/origin without a path/)
      expect(() =>
        loadConfig(env({ MASTERHAND_UPDATE_URL: "http://updater:8080", MASTERHAND_UPDATE_TOKEN: "short" })),
      ).toThrow(/at least 16 bytes/)
      expect(() =>
        loadConfig(
          env({
            MASTERHAND_UPDATE_URL: "http://updater:8080",
            MASTERHAND_UPDATE_TOKEN: token,
            MASTERHAND_UPDATE_TRACK: "bad tag!",
          }),
        ),
      ).toThrow(/MASTERHAND_UPDATE_TRACK/)
    })
  })
})
