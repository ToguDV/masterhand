import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { loadConfig } from "../src/config.js"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { MASTERHAND_PASSWORD: "pw", SESSION_SECRET: "secret", ...overrides }
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
    expect(loadConfig(env({ COOKIE_SECURE: "" })).cookieSecure).toBe(false)
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
    const config = loadConfig(env({ ALLOWED_ORIGINS: " https://a.example , https://b.example ,,", NODE_ENV: "production" }))
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

    const prod = loadConfig(env({ NODE_ENV: "production" }))
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
})
