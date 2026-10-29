// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest"
import {
  clearServerToken,
  createProfile,
  findProfileByUrl,
  getOrCreateInstallID,
  loadRegistry,
  loadServerToken,
  migrateLegacyPreferences,
  removeProfile,
  saveRegistry,
  saveServerToken,
  tokenKey,
  type ServerProfile,
} from "../src/servers"

function profile(overrides: Partial<ServerProfile> = {}): ServerProfile {
  return {
    ...createProfile({ url: "https://home.example.com", label: "Home" }),
    ...overrides,
  }
}

beforeEach(() => {
  window.localStorage.clear()
})

describe("web server registry", () => {
  it("starts empty and persists profiles plus the active id", () => {
    expect(loadRegistry()).toEqual({ profiles: [], activeID: null })

    const home = profile()
    saveRegistry({ profiles: [home], activeID: home.id })

    const loaded = loadRegistry()
    expect(loaded.profiles).toHaveLength(1)
    expect(loaded.profiles[0]).toMatchObject({
      id: home.id,
      label: "Home",
      url: "https://home.example.com",
      authMode: "device",
    })
    expect(loaded.activeID).toBe(home.id)
  })

  it("drops an active id that no longer belongs to a profile", () => {
    const home = profile()
    window.localStorage.setItem("masterhand.servers", JSON.stringify([home]))
    window.localStorage.setItem("masterhand.servers.active", "missing")
    expect(loadRegistry().activeID).toBeNull()
  })

  it("deduplicates lookups by canonical URL and removes profiles", () => {
    const home = profile()
    const other = profile({ id: "other", url: "https://studio.example.com" })
    expect(findProfileByUrl([home, other], "https://home.example.com")?.id).toBe(home.id)
    expect(removeProfile([home, other], home.id)).toEqual([other])
  })

  it("rejects corrupt storage and invalid profiles instead of crashing", () => {
    window.localStorage.setItem("masterhand.servers", "{not json")
    expect(loadRegistry()).toEqual({ profiles: [], activeID: null })

    window.localStorage.setItem(
      "masterhand.servers",
      JSON.stringify([
        { id: "bad", url: "http://public.example.com" },
        { id: "good", url: "https://home.example.com", label: "Home" },
      ]),
    )
    const loaded = loadRegistry()
    expect(loaded.profiles.map((item) => item.id)).toEqual(["good"])
  })

  it("recomputes cookie auth for the serving origin", () => {
    const current = window.location.origin
    const local = profile({ url: current })
    saveRegistry({ profiles: [local], activeID: local.id })
    expect(loadRegistry().profiles[0]?.authMode).toBe("cookie")
  })

  it("keeps tokens out of the profile payload and scopes them per server", () => {
    const home = profile()
    const studio = profile({ id: "studio", url: "https://studio.example.com" })
    saveRegistry({ profiles: [home, studio], activeID: home.id })
    saveServerToken(home.id, "token-home")
    saveServerToken(studio.id, "token-studio")

    expect(window.localStorage.getItem("masterhand.servers")).not.toContain("token-home")
    expect(loadServerToken(home.id)).toBe("token-home")
    expect(loadServerToken(studio.id)).toBe("token-studio")
    expect(tokenKey(home.id)).toContain(home.id)

    clearServerToken(home.id)
    expect(loadServerToken(home.id)).toBeNull()
    expect(loadServerToken(studio.id)).toBe("token-studio")
  })

  it("keeps one stable install id across calls", () => {
    const first = getOrCreateInstallID()
    expect(getOrCreateInstallID()).toBe(first)
    expect(window.localStorage.getItem("masterhand.installID")).toBe(first)
  })

  it("migrates the legacy global preferences to the first profile", () => {
    window.localStorage.setItem("masterhand.workspace", "ws-1")
    window.localStorage.setItem("masterhand.autoAcceptSessions", JSON.stringify(["s1"]))
    window.localStorage.setItem("masterhand.lastSeenSessions", JSON.stringify({ s1: 1 }))

    migrateLegacyPreferences("p1")

    expect(window.localStorage.getItem("masterhand.workspace.p1")).toBe("ws-1")
    expect(window.localStorage.getItem("masterhand.autoAcceptSessions.p1")).toBe(JSON.stringify(["s1"]))
    expect(window.localStorage.getItem("masterhand.lastSeenSessions.p1")).toBe(JSON.stringify({ s1: 1 }))
    expect(window.localStorage.getItem("masterhand.workspace")).toBeNull()
  })
})
