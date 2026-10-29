import { Linking } from "react-native"
import {
  FDROID_MARKET_URL,
  FDROID_REPO_URL,
  checkMobileUpdate,
  installedVersion,
  normalizeFdroidIndex,
  openFdroidListing,
  type InstalledVersion,
} from "../src/update"
import { fakeClient } from "./support/render"

// No native module under Jest: the installed build must read as the 0.1.0
// baseline instead of the jest-expo "mock" string.
jest.mock("expo-application", () => ({
  nativeApplicationVersion: null,
  nativeBuildVersion: null,
}))

const INSTALLED: InstalledVersion = { versionName: "0.1.0", versionCode: 100 }

function bffClient(latest: unknown, throws = false) {
  const client = fakeClient()
  client.api.update = {
    check: jest.fn(async () => {
      if (throws) throw new Error("unreachable")
      return { latest };
    }),
  } as unknown as typeof client.api.update
  return client
}

describe("checkMobileUpdate", () => {
  it("prefers the BFF manifest when it reports a newer release", async () => {
    const client = bffClient({ version: "0.2.0", tag: "v0.2.0", publishedAt: null, notes: "Fixes" })
    const result = await checkMobileUpdate({ client, installed: INSTALLED })
    expect(result.update).toEqual({ source: "bff", version: "0.2.0", tag: "v0.2.0", notes: "Fixes" })
  })

  it("falls back to the F-Droid index when the BFF is unreachable", async () => {
    const client = bffClient(null, true)
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ packages: { "dev.togudv.masterhand": [{ versionName: "0.2.0", versionCode: 200 }] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch
    const result = await checkMobileUpdate({ client, installed: INSTALLED, fetchImpl })
    expect(result.update).toEqual({ source: "fdroid", version: "0.2.0", tag: "v0.2.0", notes: null })
  })

  it("stays silent when installed is current on both channels", async () => {
    const client = bffClient(null)
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ packages: { "dev.togudv.masterhand": [{ versionName: "0.1.0", versionCode: 100 }] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch
    const result = await checkMobileUpdate({ client, installed: INSTALLED, fetchImpl })
    expect(result.update).toBeNull()
  })

  it("stays silent (never an error) when every channel fails", async () => {
    const client = bffClient(null, true)
    const fetchImpl = (async () => {
      throw new Error("offline")
    }) as typeof fetch
    const result = await checkMobileUpdate({ client, installed: INSTALLED, fetchImpl })
    expect(result.update).toBeNull()
  })
})

describe("normalizeFdroidIndex", () => {  it("picks the highest versionCode of the MasterHand package", () => {
    expect(
      normalizeFdroidIndex({
        packages: {
          "dev.togudv.masterhand": [
            { versionName: "0.1.0", versionCode: 100 },
            { versionName: "0.2.0", versionCode: 200 },
          ],
          "other.app": [{ versionName: "9.9.9", versionCode: 99999 }],
        },
      }),
    ).toEqual({ version: "0.2.0", versionCode: 200 })
  })

  it("returns null for anything without a usable MasterHand entry", () => {
    expect(normalizeFdroidIndex(null)).toBeNull()
    expect(normalizeFdroidIndex({})).toBeNull()
    expect(normalizeFdroidIndex({ packages: { "dev.togudv.masterhand": [] } })).toBeNull()
    expect(
      normalizeFdroidIndex({ packages: { "dev.togudv.masterhand": [{ versionName: "", versionCode: 5 }] } }),
    ).toBeNull()
    expect(
      normalizeFdroidIndex({
        packages: { "dev.togudv.masterhand": [{ versionName: "not-a-version", versionCode: 99999 }] },
      }),
    ).toBeNull()
  })
})

describe("installedVersion", () => {
  it("falls back to the 0.1.0 baseline without native data", () => {
    expect(installedVersion()).toEqual({ versionName: "0.1.0", versionCode: 100 })
  })
})

describe("openFdroidListing", () => {
  it("prefers the market intent and falls back to the repo website", async () => {
    const canOpen = jest.spyOn(Linking, "canOpenURL")
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined as never)
    try {
      canOpen.mockResolvedValue(true)
      await openFdroidListing()
      expect(open).toHaveBeenCalledWith(FDROID_MARKET_URL)
      canOpen.mockResolvedValue(false)
      await openFdroidListing()
      expect(open).toHaveBeenCalledWith(FDROID_REPO_URL)
    } finally {
      canOpen.mockRestore()
      open.mockRestore()
    }
  })
})
