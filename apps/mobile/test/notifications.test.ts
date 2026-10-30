jest.mock("expo-notifications", () => ({
  AndroidImportance: { HIGH: 4 },
  getPermissionsAsync: jest.fn(async () => ({ status: "granted", granted: true })),
  requestPermissionsAsync: jest.fn(async () => ({ status: "granted", granted: true })),
  setNotificationChannelAsync: jest.fn(async () => null),
  scheduleNotificationAsync: jest.fn(async () => "notif-id"),
  dismissNotificationAsync: jest.fn(async () => {}),
  getPresentedNotificationsAsync: jest.fn(async () => []),
  setNotificationHandler: jest.fn(),
}))

jest.mock("react-native", () => ({
  Platform: { OS: "android" },
}))

import * as SystemNotifications from "expo-notifications"
import {
  AGENT_ACTIVITY_CHANNEL_ID,
  dismissSessionNotifications,
  ensureAgentChannel,
  getNotificationPermission,
  notifyAgentActivity,
  requestNotificationPermission,
  sendTestNotification,
  setupNotificationHandler,
} from "../src/notifications"

const system = SystemNotifications as unknown as {
  getPermissionsAsync: jest.Mock
  requestPermissionsAsync: jest.Mock
  setNotificationChannelAsync: jest.Mock
  scheduleNotificationAsync: jest.Mock
  getPresentedNotificationsAsync: jest.Mock
  dismissNotificationAsync: jest.Mock
  setNotificationHandler: jest.Mock
}

beforeEach(() => {
  jest.clearAllMocks()
  system.getPermissionsAsync.mockResolvedValue({ status: "granted", granted: true })
  system.getPresentedNotificationsAsync.mockResolvedValue([])
})

describe("notifications wrapper", () => {
  it("creates the agent channel", async () => {
    await ensureAgentChannel()
    expect(system.setNotificationChannelAsync).toHaveBeenCalledWith(
      AGENT_ACTIVITY_CHANNEL_ID,
      expect.objectContaining({ name: expect.any(String) }),
    )
  })

  it("returns granted without prompting when already allowed", async () => {
    await expect(requestNotificationPermission()).resolves.toBe(true)
    expect(system.requestPermissionsAsync).not.toHaveBeenCalled()
  })

  it("requests permission when undetermined", async () => {
    system.getPermissionsAsync.mockResolvedValueOnce({ status: "undetermined", granted: false })
    system.requestPermissionsAsync.mockResolvedValueOnce({ status: "granted", granted: true })
    await expect(requestNotificationPermission()).resolves.toBe(true)
  })

  it("schedules on the agent channel with session data", async () => {
    await notifyAgentActivity({
      title: "Agent finished",
      body: "My session",
      data: { profileID: "p1", sessionID: "ses_1", kind: "finished" },
    })
    expect(system.scheduleNotificationAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({
          title: "Agent finished",
          data: expect.objectContaining({ sessionID: "ses_1" }),
        }),
        trigger: expect.objectContaining({ channelId: AGENT_ACTIVITY_CHANNEL_ID }),
      }),
    )
  })

  it("dismisses only the session's presented notifications", async () => {
    system.getPresentedNotificationsAsync.mockResolvedValueOnce([
      { request: { identifier: "a", content: { data: { sessionID: "ses_1" } } } },
      { request: { identifier: "b", content: { data: { sessionID: "ses_2" } } } },
    ])
    await dismissSessionNotifications("ses_1")
    expect(system.dismissNotificationAsync).toHaveBeenCalledTimes(1)
    expect(system.dismissNotificationAsync).toHaveBeenCalledWith("a")
  })

  it("sets up the foreground handler without throwing", () => {
    expect(() => setupNotificationHandler()).not.toThrow()
    expect(system.setNotificationHandler).toHaveBeenCalled()
    const handler = system.setNotificationHandler.mock.calls[0]?.[0] as {
      handleNotification: () => Promise<Record<string, boolean>>
    }
    return expect(handler.handleNotification()).resolves.toEqual(
      expect.objectContaining({ shouldShowBanner: true }),
    )
  })

  it("reports permission state and denial", async () => {
    system.getPermissionsAsync.mockResolvedValueOnce({ status: "denied", granted: false })
    await expect(getNotificationPermission()).resolves.toBe(false)
    system.getPermissionsAsync.mockResolvedValueOnce({ status: "undetermined", granted: false })
    system.requestPermissionsAsync.mockResolvedValueOnce({ status: "denied", granted: false })
    await expect(requestNotificationPermission()).resolves.toBe(false)
  })

  it("treats permission lookup failures as denied", async () => {
    system.getPermissionsAsync.mockRejectedValueOnce(new Error("no host"))
    await expect(getNotificationPermission()).resolves.toBe(false)
    system.getPermissionsAsync.mockResolvedValueOnce({ status: "undetermined", granted: false })
    system.requestPermissionsAsync.mockRejectedValueOnce(new Error("no host"))
    await expect(requestNotificationPermission()).resolves.toBe(false)
  })

  it("returns null when scheduling fails and swallows dismiss errors", async () => {
    system.scheduleNotificationAsync.mockRejectedValueOnce(new Error("no host"))
    await expect(
      notifyAgentActivity({
        title: "t",
        body: "b",
        data: { profileID: "p", sessionID: "s", kind: "finished" },
      }),
    ).resolves.toBeNull()
    system.getPresentedNotificationsAsync.mockRejectedValueOnce(new Error("no host"))
    await expect(dismissSessionNotifications("s")).resolves.toBeUndefined()
  })

  it("sends a test notification", async () => {
    await sendTestNotification()
    expect(system.scheduleNotificationAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({ title: "Test notification" }),
      }),
    )
  })
})
