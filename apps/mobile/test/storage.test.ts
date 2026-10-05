import * as SecureStore from "expo-secure-store"
import {
  clearDevice,
  clearToken,
  clearWorkspaceID,
  loadAutoAcceptSessions,
  loadDevice,
  loadServerUrl,
  loadSessionPreferences,
  loadToken,
  loadWorkspaceID,
  saveAutoAcceptSessions,
  saveDevice,
  saveServerUrl,
  saveSessionPreferences,
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
