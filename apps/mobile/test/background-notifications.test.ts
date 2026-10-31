jest.mock("../src/storage", () => ({
  loadNotificationsEnabled: jest.fn(async () => true),
  loadAgentActivityPreferences: jest.fn(async () => ({
    finished: true,
    failed: true,
    permission: true,
    question: true,
  })),
  loadServerRegistry: jest.fn(async () => ({ profiles: [], activeID: null })),
  loadServerToken: jest.fn(async () => null),
  loadBusySnapshot: jest.fn(async () => ({})),
  saveBusySnapshot: jest.fn(async () => {}),
}))

jest.mock("../src/notifications", () => ({
  notifyAgentActivity: jest.fn(async () => "id"),
}))

jest.mock("@masterhand/client-core", () => ({
  createClient: jest.fn(),
}))

import * as BackgroundTask from "expo-background-task"
import * as TaskManager from "expo-task-manager"
import * as storageModule from "../src/storage"
import { createClient } from "@masterhand/client-core"
import {
  checkAgentActivityInBackground,
  diffBusySnapshots,
  reconcileBusySnapshots,
  registerAgentActivityTask,
  unregisterAgentActivityTask,
} from "../src/background-notifications"

describe("diffBusySnapshots", () => {
  it("reports finished sessions", () => {
    const previous = {
      ses_1: { title: "One" },
      ses_2: { title: "Two" },
    }
    expect(diffBusySnapshots(previous, new Set(["ses_2"]))).toEqual(["ses_1"])
    expect(diffBusySnapshots(previous, new Set(["ses_1", "ses_2"]))).toEqual([])
    expect(diffBusySnapshots({}, new Set(["ses_1"]))).toEqual([])
  })
})

describe("reconcileBusySnapshots", () => {
  it("notifies finished sessions and saves the new snapshot", async () => {
    const notified: string[] = []
    const saved: unknown[] = []
    const result = await reconcileBusySnapshots({
      enabled: true,
      previous: { ses_1: { title: "Demo" }, ses_2: { title: "Other" } },
      currentBusy: new Set(["ses_2"]),
      titles: { ses_2: { title: "Other" } },
      notify: async (entry) => {
        notified.push(entry.sessionID)
      },
      save: async (snapshot) => {
        saved.push(snapshot)
      },
      profile: { id: "p1" },
    })
    expect(notified).toEqual(["ses_1"])
    expect(result.notified).toEqual(["ses_1"])
    expect(saved[0]).toEqual({ ses_2: { title: "Other" } })
  })

  it("does nothing when disabled", async () => {
    const notified: string[] = []
    const result = await reconcileBusySnapshots({
      enabled: false,
      previous: { ses_1: { title: "Demo" } },
      currentBusy: new Set(),
      titles: {},
      notify: async () => {
        notified.push("x")
      },
      save: async () => {},
      profile: { id: "p1" },
    })
    expect(notified).toEqual([])
    expect(result.notified).toEqual([])
  })

  it("caps notifications to avoid spam", async () => {
    const previous: Record<string, { title: string }> = {}
    for (let i = 0; i < 10; i += 1) previous[`ses_${i}`] = { title: `S${i}` }
    const notified: string[] = []
    await reconcileBusySnapshots({
      enabled: true,
      previous,
      currentBusy: new Set(),
      titles: {},
      notify: async (entry) => {
        notified.push(entry.sessionID)
      },
      save: async () => {},
      profile: { id: "p1" },
    })
    expect(notified.length).toBeLessThanOrEqual(5)
  })

  it("tolerates notify and save failures", async () => {
    const result = await reconcileBusySnapshots({
      enabled: true,
      previous: { ses_1: { title: "Demo" } },
      currentBusy: new Set(),
      titles: {},
      notify: async () => {
        throw new Error("nope")
      },
      save: async () => {
        throw new Error("nope")
      },
      profile: { id: "p1" },
    })
    expect(result.notified).toEqual([])
  })
})

describe("background task registration", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("registers once and unregisters", async () => {
    const taskManager = TaskManager as unknown as { isTaskRegisteredAsync: jest.Mock }
    const background = BackgroundTask as unknown as {
      registerTaskAsync: jest.Mock
      unregisterTaskAsync: jest.Mock
    }
    taskManager.isTaskRegisteredAsync.mockResolvedValue(false)
    await registerAgentActivityTask()
    expect(background.registerTaskAsync).toHaveBeenCalled()
    taskManager.isTaskRegisteredAsync.mockResolvedValue(true)
    await registerAgentActivityTask()
    await unregisterAgentActivityTask()
    expect(background.unregisterTaskAsync).toHaveBeenCalled()
  })
})

describe("checkAgentActivityInBackground", () => {
  const storage = storageModule as unknown as {
    loadNotificationsEnabled: jest.Mock
    loadAgentActivityPreferences: jest.Mock
    loadServerRegistry: jest.Mock
    loadServerToken: jest.Mock
    loadBusySnapshot: jest.Mock
    saveBusySnapshot: jest.Mock
  }
  const createClientMock = createClient as unknown as jest.Mock

  beforeEach(() => {
    jest.clearAllMocks()
    storage.loadNotificationsEnabled.mockResolvedValue(true)
    storage.loadAgentActivityPreferences.mockResolvedValue({
      finished: true,
      failed: true,
      permission: true,
      question: true,
    })
    storage.loadServerRegistry.mockResolvedValue({ profiles: [], activeID: null })
    storage.loadServerToken.mockResolvedValue(null)
    storage.loadBusySnapshot.mockResolvedValue({})
  })

  it("does nothing when disabled", async () => {
    storage.loadNotificationsEnabled.mockResolvedValue(false)
    await expect(checkAgentActivityInBackground()).resolves.toEqual({ notified: [] })
    expect(createClientMock).not.toHaveBeenCalled()
  })

  it("does nothing when finishes are turned off", async () => {
    storage.loadAgentActivityPreferences.mockResolvedValue({
      finished: false,
      failed: true,
      permission: true,
      question: true,
    })
    await expect(checkAgentActivityInBackground()).resolves.toEqual({ notified: [] })
    expect(createClientMock).not.toHaveBeenCalled()
  })

  it("does nothing without an active profile or token", async () => {
    await expect(checkAgentActivityInBackground()).resolves.toEqual({ notified: [] })
    storage.loadServerRegistry.mockResolvedValue({
      profiles: [{ id: "p1", url: "https://host" }],
      activeID: "p1",
    })
    await expect(checkAgentActivityInBackground()).resolves.toEqual({ notified: [] })
  })

  it("notifies finished sessions from the busy baseline", async () => {
    storage.loadServerRegistry.mockResolvedValue({
      profiles: [{ id: "p1", url: "https://host" }],
      activeID: "p1",
    })
    storage.loadServerToken.mockResolvedValue("tok")
    storage.loadBusySnapshot.mockResolvedValue({ ses_1: { title: "Demo" } })
    createClientMock.mockReturnValue({
      api: {
        statuses: jest.fn(async () => ({})),
        sessions: { list: jest.fn(async () => ({ sessions: [] })) },
      },
      workspaces: { list: jest.fn(async () => []) },
    })
    await expect(checkAgentActivityInBackground()).resolves.toEqual({ notified: ["ses_1"] })
    expect(storage.saveBusySnapshot).toHaveBeenCalledWith("p1", {})
    const getToken = createClientMock.mock.calls.at(-1)?.[0]?.getToken as (() => string) | undefined
    expect(getToken?.()).toBe("tok")
  })

  it("resolves titles for still-busy sessions across workspaces", async () => {
    storage.loadServerRegistry.mockResolvedValue({
      profiles: [{ id: "p1", url: "https://host" }],
      activeID: "p1",
    })
    storage.loadServerToken.mockResolvedValue("tok")
    storage.loadBusySnapshot.mockResolvedValue({})
    const sessionsList = jest.fn(async () => ({
      sessions: [{ id: "ses_9", title: "Nine" }],
    }))
    createClientMock.mockReturnValue({
      api: {
        statuses: jest.fn(async () => ({ ses_9: { type: "busy" } })),
        sessions: { list: sessionsList },
      },
      workspaces: { list: jest.fn(async () => [{ id: "ws1" }]) },
    })
    await expect(checkAgentActivityInBackground()).resolves.toEqual({ notified: [] })
    expect(sessionsList).toHaveBeenCalledWith("ws1")
    expect(storage.saveBusySnapshot).toHaveBeenCalledWith("p1", {
      ses_9: { title: "Nine", workspaceID: "ws1" },
    })
  })

  it("returns empty when statuses are unreachable", async () => {
    storage.loadServerRegistry.mockResolvedValue({
      profiles: [{ id: "p1", url: "https://host" }],
      activeID: "p1",
    })
    storage.loadServerToken.mockResolvedValue("tok")
    createClientMock.mockReturnValue({
      api: {
        statuses: jest.fn(async () => {
          throw new Error("down")
        }),
        sessions: { list: jest.fn() },
      },
      workspaces: { list: jest.fn() },
    })
    // statuses().catch(() => null) is inside the implementation; a throwing
    // mock still resolves to empty via the outer catch.
    await expect(checkAgentActivityInBackground()).resolves.toEqual({ notified: [] })
  })

  it("returns empty when the registry cannot be read", async () => {
    storage.loadNotificationsEnabled.mockResolvedValue(true)
    storage.loadServerRegistry.mockRejectedValue(new Error("no store"))
    await expect(checkAgentActivityInBackground()).resolves.toEqual({ notified: [] })
  })

  it("returns empty when the client cannot be built", async () => {
    storage.loadServerRegistry.mockResolvedValue({
      profiles: [{ id: "p1", url: "https://host" }],
      activeID: "p1",
    })
    storage.loadServerToken.mockResolvedValue("tok")
    createClientMock.mockImplementationOnce(() => {
      throw new Error("no client")
    })
    await expect(checkAgentActivityInBackground()).resolves.toEqual({ notified: [] })
  })
})
