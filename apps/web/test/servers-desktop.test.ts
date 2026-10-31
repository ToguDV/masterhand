// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { loadRegistry, webDeviceName } from "../src/servers"

function setDesktopFlag(value: unknown): void {
  Object.defineProperty(globalThis, "masterhandDesktop", {
    value,
    configurable: true,
    writable: true,
  })
}

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  delete (globalThis as { masterhandDesktop?: unknown }).masterhandDesktop
})

describe("bundled desktop app", () => {
  it("labels its device registration as the desktop app", () => {
    expect(webDeviceName()).toBe("Web browser")
    setDesktopFlag(true)
    expect(webDeviceName()).toBe("Desktop app")
  })

  it("keeps plain-http LAN profiles that the browser build rejects", () => {
    window.localStorage.setItem(
      "masterhand.servers",
      JSON.stringify([{ id: "lan", url: "http://192.168.1.21:8787", label: "LAN" }]),
    )
    window.localStorage.setItem("masterhand.servers.active", "lan")

    expect(loadRegistry().profiles).toHaveLength(0)

    setDesktopFlag(true)
    const registry = loadRegistry()
    expect(registry.profiles).toHaveLength(1)
    expect(registry.profiles[0]).toMatchObject({
      id: "lan",
      url: "http://192.168.1.21:8787",
      authMode: "device",
    })
    expect(registry.activeID).toBe("lan")
  })
})
