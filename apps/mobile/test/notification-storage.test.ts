import {
  loadAgentActivityPreferences,
  loadBusySnapshot,
  loadNotificationsEnabled,
  saveAgentActivityPreferences,
  saveBusySnapshot,
  saveNotificationsEnabled,
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

import * as SecureStore from "expo-secure-store"

const store = (SecureStore as unknown as { __store: Map<string, string> }).__store

beforeEach(() => {
  store.clear()
  jest.clearAllMocks()
})

describe("notification storage", () => {
  it("defaults to disabled and round-trips the flag", async () => {
    expect(await loadNotificationsEnabled()).toBe(false)
    await saveNotificationsEnabled(true)
    expect(await loadNotificationsEnabled()).toBe(true)
    await saveNotificationsEnabled(false)
    expect(await loadNotificationsEnabled()).toBe(false)
  })

  it("defaults every event kind to on and round-trips them", async () => {
    expect(await loadAgentActivityPreferences()).toEqual({
      finished: true,
      failed: true,
      permission: true,
      question: true,
    })
    await saveAgentActivityPreferences({
      finished: false,
      failed: true,
      permission: false,
      question: true,
    })
    expect(await loadAgentActivityPreferences()).toEqual({
      finished: false,
      failed: true,
      permission: false,
      question: true,
    })
    store.set("masterhand.notifications.kinds", "not-json")
    expect(await loadAgentActivityPreferences()).toEqual({
      finished: true,
      failed: true,
      permission: true,
      question: true,
    })
  })

  it("round-trips the per-profile busy snapshot and ignores garbage", async () => {
    expect(await loadBusySnapshot("p1")).toEqual({})
    await saveBusySnapshot("p1", { ses_1: { title: "Demo", workspaceID: "ws1" } })
    expect(await loadBusySnapshot("p1")).toEqual({
      ses_1: { title: "Demo", workspaceID: "ws1" },
    })
    expect(await loadBusySnapshot("p2")).toEqual({})
    store.set("masterhand.notifyBusy.p1", "not-json")
    expect(await loadBusySnapshot("p1")).toEqual({})
  })
})
