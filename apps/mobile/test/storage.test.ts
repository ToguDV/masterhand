import * as SecureStore from "expo-secure-store"
import {
  clearDevice,
  clearPalette,
  clearToken,
  clearWorkspaceID,
  getOrCreateInstallID,
  loadAutoAcceptSessions,
  loadAutoAcceptSessionsFor,
  loadDevice,
  loadServerRegistry,
  loadServerToken,
  clearServerToken,
  loadPalette,
  loadServerUrl,
  loadSessionPreferences,
  loadTheme,
  loadToken,
  loadWorkspaceID,
  saveAutoAcceptSessions,
  saveAutoAcceptSessionsFor,
  saveDevice,
  saveServerRegistry,
  saveServerToken,
  savePalette,
  saveServerUrl,
  saveSessionPreferences,
  saveTheme,
  saveToken,
  saveWorkspaceID,
} from "../src/storage"

jest.mock("expo-secure-store", () => {
  const store = new Map<string, string>()
  return {
    __store: store,
    getItemAsync: jest.fn(async (key: string) => store.get(key) ?? null),
    setItemAsync: jest.fn(async (key: string, value: string) => {
      store.set(key, value)
    }),
    deleteItemAsync: jest.fn(async (key: string) => {
      store.delete(key)
    }),
  }
})

const store = (SecureStore as unknown as { __store: Map<string, string> }).__store

beforeEach(() => {
  store.clear()
})

describe("storage — server URL and token", () => {
  it("round-trips the server URL and token, and clears the token", async () => {
    expect(await loadServerUrl()).toBeNull()
    await saveServerUrl("https://host")
    expect(await loadServerUrl()).toBe("https://host")

    await saveToken("tok")
    expect(await loadToken()).toBe("tok")
    await clearToken()
    expect(await loadToken()).toBeNull()
  })
})

describe("storage — device", () => {
  it("round-trips the device and clears it", async () => {
    expect(await loadDevice()).toBeNull()
    await saveDevice({ id: "d1", name: "Pixel" })
    expect(await loadDevice()).toEqual({ id: "d1", name: "Pixel" })
    await clearDevice()
    expect(await loadDevice()).toBeNull()
  })

  it("tolerates a corrupted device record", async () => {
    await SecureStore.setItemAsync("masterhand.device", "{not json")

    expect(await loadDevice()).toBeNull()
  })
})

describe("storage — install id", () => {
  it("returns the same persisted install id on every call", async () => {
    const first = await getOrCreateInstallID()
    expect(first).toEqual(expect.any(String))
    expect(first.length).toBeGreaterThan(0)

    expect(await getOrCreateInstallID()).toBe(first)
    expect(await SecureStore.getItemAsync("masterhand.installID")).toBe(first)
  })

  it("coalesces concurrent calls into a single read", async () => {
    const getItem = SecureStore.getItemAsync as jest.Mock
    getItem.mockClear()

    const ids = await Promise.all(Array.from({ length: 5 }, () => getOrCreateInstallID()))
    expect(new Set(ids).size).toBe(1)
    expect(getItem).toHaveBeenCalledTimes(1)
  })

  it("falls back to an ephemeral id when SecureStore fails (#82)", async () => {
    ;(SecureStore.getItemAsync as jest.Mock).mockRejectedValueOnce(new Error("keychain unavailable"))

    await expect(getOrCreateInstallID()).resolves.toEqual(expect.any(String))
  })

  it("keeps the in-memory id when the secure store cannot persist it", async () => {
    ;(SecureStore.setItemAsync as jest.Mock).mockRejectedValueOnce(new Error("disk full"))

    const first = await getOrCreateInstallID()
    expect(await getOrCreateInstallID()).toBe(first)
  })

  it("survives sign-out: clearing the session never clears the install id", async () => {
    const id = await getOrCreateInstallID()

    await clearToken()
    await clearDevice()
    await clearWorkspaceID()

    expect(await getOrCreateInstallID()).toBe(id)
  })
})

describe("storage — workspace", () => {
  it("round-trips the workspace id and clears it", async () => {
    expect(await loadWorkspaceID()).toBeNull()
    await saveWorkspaceID("ws1")
    expect(await loadWorkspaceID()).toBe("ws1")
    await clearWorkspaceID()
    expect(await loadWorkspaceID()).toBeNull()
  })
})

describe("storage — auto-accept sessions", () => {
  it("defaults to an empty list and filters non-string entries", async () => {
    expect(await loadAutoAcceptSessions()).toEqual([])

    await saveAutoAcceptSessions(["s1", "s2"])
    expect(await loadAutoAcceptSessions()).toEqual(["s1", "s2"])

    await SecureStore.setItemAsync("masterhand.autoAcceptSessions", JSON.stringify(["s1", 3, null, "s2"]))
    expect(await loadAutoAcceptSessions()).toEqual(["s1", "s2"])
  })

  it("tolerates corrupted JSON", async () => {
    await SecureStore.setItemAsync("masterhand.autoAcceptSessions", "nope")

    expect(await loadAutoAcceptSessions()).toEqual([])
  })
})

describe("storage — theme", () => {
  it("round-trips the theme choice and rejects unknown values", async () => {
    expect(await loadTheme()).toBeNull()

    await saveTheme("dark")
    expect(await loadTheme()).toBe("dark")

    await SecureStore.setItemAsync("masterhand.theme", "purple")
    expect(await loadTheme()).toBeNull()
  })

  it("tolerates a failing secure store", async () => {
    const getItem = SecureStore.getItemAsync as jest.Mock
    getItem.mockRejectedValueOnce(new Error("keychain unavailable"))

    expect(await loadTheme()).toBeNull()
  })
})

describe("storage — palette (#124)", () => {
  it("round-trips the palette choice and clears it", async () => {
    expect(await loadPalette()).toBeNull()

    await savePalette("violet")
    expect(await loadPalette()).toBe("violet")

    await clearPalette()
    expect(await loadPalette()).toBeNull()
  })

  it("tolerates a failing secure store", async () => {
    const getItem = SecureStore.getItemAsync as jest.Mock
    getItem.mockRejectedValueOnce(new Error("keychain unavailable"))

    expect(await loadPalette()).toBeNull()
  })
})

describe("storage — session preferences", () => {
  it("returns nothing for an unknown session", async () => {
    expect(await loadSessionPreferences("missing")).toEqual({})
  })

  it("keeps only the string fields of a stored session", async () => {
    await SecureStore.setItemAsync(
      "masterhand.sessionPreferences",
      JSON.stringify({ s1: { agent: "build", model: 7, variant: "high" } }),
    )

    expect(await loadSessionPreferences("s1")).toEqual({ agent: "build", variant: "high" })
  })

  it("stores preferences per session without clobbering the others", async () => {
    await saveSessionPreferences("s1", { agent: "build", model: "test-model", variant: "low" })
    await saveSessionPreferences("s2", { agent: "explore", model: "alpha", variant: "" })

    expect(await loadSessionPreferences("s1")).toEqual({ agent: "build", model: "test-model", variant: "low" })
    expect(await loadSessionPreferences("s2")).toEqual({ agent: "explore", model: "alpha", variant: "" })
  })

  it("tolerates corrupted JSON", async () => {
    await SecureStore.setItemAsync("masterhand.sessionPreferences", "nope")

    expect(await loadSessionPreferences("s1")).toEqual({})
  })

  it("starts a fresh map when the stored one is corrupted", async () => {
    await SecureStore.setItemAsync("masterhand.sessionPreferences", "{not json")

    await saveSessionPreferences("s1", { agent: "build", model: "test-model", variant: "low" })

    expect(await loadSessionPreferences("s1")).toEqual({ agent: "build", model: "test-model", variant: "low" })
  })

  it("serializes concurrent saves so neither session loses its preferences (#82)", async () => {
    const first = { agent: "build", model: "test-model", variant: "low" }
    const second = { agent: "explore", model: "alpha", variant: "" }

    // Both calls start before either write lands: an unserialized
    // read-modify-write would have both read the same map and clobber one.
    await Promise.all([saveSessionPreferences("s1", first), saveSessionPreferences("s2", second)])

    expect(await loadSessionPreferences("s1")).toEqual(first)
    expect(await loadSessionPreferences("s2")).toEqual(second)
  })

  it("keeps saving after one write fails (#82)", async () => {
    const setItem = SecureStore.setItemAsync as jest.Mock
    setItem.mockRejectedValueOnce(new Error("keychain unavailable"))

    await expect(
      saveSessionPreferences("s1", { agent: "build", model: "test-model", variant: "low" }),
    ).rejects.toThrow("keychain unavailable")

    await saveSessionPreferences("s2", { agent: "explore", model: "alpha", variant: "" })
    expect(await loadSessionPreferences("s2")).toEqual({ agent: "explore", model: "alpha", variant: "" })
  })
})

describe("storage — multi-server registry", () => {
  it("migrates the legacy single-server session exactly once", async () => {
    await saveServerUrl("https://legacy.example.com/")
    await saveToken("legacy-token")
    await saveDevice({ id: "dev-1", name: "Pixel" })
    await saveWorkspaceID("ws-legacy")
    await saveAutoAcceptSessions(["s1"])

    const first = await loadServerRegistry()
    expect(first.profiles).toHaveLength(1)
    expect(first.activeID).toBe(first.profiles[0]?.id)
    expect(first.profiles[0]).toMatchObject({
      url: "https://legacy.example.com",
      label: "legacy.example.com",
      device: { id: "dev-1", name: "Pixel" },
      lastWorkspaceID: "ws-legacy",
    })
    expect(await loadServerToken(first.profiles[0]!.id)).toBe("legacy-token")
    expect(await loadAutoAcceptSessionsFor(first.profiles[0]!.id)).toEqual(["s1"])
    // Legacy keys are gone once the migration is written.
    expect(await loadServerUrl()).toBeNull()
    expect(await loadToken()).toBeNull()
    expect(await loadDevice()).toBeNull()
    expect(await loadWorkspaceID()).toBeNull()

    // A second boot reads the registry instead of migrating again.
    const second = await loadServerRegistry()
    expect(second.profiles.map((profile) => profile.id)).toEqual(first.profiles.map((profile) => profile.id))
  })

  it("keeps a saved URL without a token for re-authentication", async () => {
    await saveServerUrl("http://localhost:8787")
    const registry = await loadServerRegistry()
    expect(registry.profiles).toHaveLength(1)
    expect(registry.activeID).toBeNull()
    expect(await loadServerToken(registry.profiles[0]!.id)).toBeNull()
  })

  it("round-trips profiles, the active server and per-server tokens", async () => {
    const registry = {
      profiles: [
        {
          id: "a",
          label: "Home",
          url: "https://home.example.com",
          device: { id: "d1", name: "Phone" },
          lastWorkspaceID: null,
          lastSessionID: null,
          expired: false,
          lastUsedAt: 1,
        },
      ],
      activeID: "a",
    }
    await saveServerRegistry(registry)
    await saveServerToken("a", "tok-a")
    expect(await loadServerRegistry()).toEqual(registry)
    expect(await loadServerToken("a")).toBe("tok-a")
    expect(await loadServerToken("b")).toBeNull()
  })

  it("ignores corrupt registry JSON and invalid URLs", async () => {
    store.set("masterhand.servers.v2", "{bad")
    expect(await loadServerRegistry()).toEqual({ profiles: [], activeID: null })

    store.set(
      "masterhand.servers.v2",
      JSON.stringify({
        profiles: [
          { id: "bad", url: "ftp://public.example.com" },
          { id: "good", url: "https://home.example.com" },
        ],
        activeID: "bad",
      }),
    )
    const registry = await loadServerRegistry()
    expect(registry.profiles.map((profile) => profile.id)).toEqual(["good"])
    expect(registry.activeID).toBeNull()
  })
})

describe("storage — migration and list edge cases", () => {
  it("keeps a legacy plain-http LAN URL instead of dropping the session", async () => {
    await saveServerUrl("http://192.168.1.20:8787")
    await saveToken("lan-token")
    const registry = await loadServerRegistry()
    expect(registry.profiles[0]).toMatchObject({
      url: "http://192.168.1.20:8787",
      label: "192.168.1.20",
    })
    expect(registry.activeID).toBe(registry.profiles[0]?.id)
    expect(await loadServerToken(registry.profiles[0]!.id)).toBe("lan-token")
  })

  it("ignores an invalid legacy URL and reports no profiles", async () => {
    await saveServerUrl("not a valid url")
    expect(await loadServerRegistry()).toEqual({ profiles: [], activeID: null })
  })

  it("reads corrupt auto-accept lists as empty", async () => {
    store.set("masterhand.autoAcceptSessions.profile-1", "{bad")
    expect(await loadAutoAcceptSessionsFor("profile-1")).toEqual([])
  })

  it("caps the registry at the profile limit on load", async () => {
    const profiles = Array.from({ length: 51 }, (_, index) => ({
      id: `p${index}`,
      url: `https://s${index}.example.com`,
    }))
    store.set("masterhand.servers.v2", JSON.stringify({ profiles, activeID: "p0" }))
    const registry = await loadServerRegistry()
    expect(registry.profiles).toHaveLength(50)
    expect(registry.activeID).toBe("p0")
  })

  it("serializes registry writes so an older write cannot win", async () => {
    const firstRegistry = {
      profiles: [
        {
          id: "a",
          label: "A",
          url: "https://a.example.com",
          device: null,
          lastWorkspaceID: null,
          lastSessionID: null,
          expired: false,
          lastUsedAt: 1,
        },
      ],
      activeID: "a",
    }
    const secondRegistry = {
      profiles: [
        {
          id: "b",
          label: "B",
          url: "https://b.example.com",
          device: null,
          lastWorkspaceID: null,
          lastSessionID: null,
          expired: false,
          lastUsedAt: 2,
        },
      ],
      activeID: "b",
    }
    let releaseFirst!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const setItem = SecureStore.setItemAsync as jest.Mock
    setItem.mockImplementationOnce(async (key: string, value: string) => {
      await gate
      store.set(key, value)
    })

    const first = saveServerRegistry(firstRegistry)
    const second = saveServerRegistry(secondRegistry)
    releaseFirst()
    await Promise.all([first, second])

    expect(JSON.parse(store.get("masterhand.servers.v2")!)).toMatchObject({ activeID: "b" })
  })

  it("persists per-server auto-accept lists", async () => {
    await saveAutoAcceptSessionsFor("a", ["s1", "s2"])
    expect(await loadAutoAcceptSessionsFor("a")).toEqual(["s1", "s2"])
  })

  it("clears a per-server token", async () => {
    await saveServerToken("profile-1", "tok")
    expect(await loadServerToken("profile-1")).toBe("tok")
    await clearServerToken("profile-1")
    expect(await loadServerToken("profile-1")).toBeNull()
  })
})
