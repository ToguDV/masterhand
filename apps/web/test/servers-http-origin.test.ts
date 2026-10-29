/**
 * @vitest-environment jsdom
 * @vitest-environment-options {"url":"http://192.168.1.20:3000/"}
 */
import { beforeEach, describe, expect, it } from "vitest"
import { normalizeServerUrl } from "@masterhand/client-core"
import { loadRegistry } from "../src/servers"

beforeEach(() => {
  window.localStorage.clear()
})

describe("plain-http serving origin", () => {
  it("accepts the page origin even though it is not loopback", () => {
    expect(
      normalizeServerUrl("http://192.168.1.20:3000", {
        allowInsecureOrigin: window.location.origin,
      }),
    ).toMatchObject({ ok: true, server: { url: "http://192.168.1.20:3000" } })
  })

  it("keeps a saved cookie profile on reload and still drops a remote http server", () => {
    window.localStorage.setItem(
      "masterhand.servers",
      JSON.stringify([
        { id: "lan", url: "http://192.168.1.20:3000", label: "LAN", authMode: "cookie" },
        { id: "remote", url: "http://192.168.1.21:8787", label: "Remote" },
      ]),
    )
    window.localStorage.setItem("masterhand.servers.active", "lan")

    const registry = loadRegistry()
    expect(registry.profiles.map((profile) => profile.id)).toEqual(["lan"])
    expect(registry.profiles[0]).toMatchObject({ url: "http://192.168.1.20:3000", authMode: "cookie" })
    expect(registry.activeID).toBe("lan")
  })
})
