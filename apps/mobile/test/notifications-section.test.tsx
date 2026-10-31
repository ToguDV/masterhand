import { fireEvent, render, screen, waitFor } from "@testing-library/react-native"
import { ThemeProvider } from "../src/theme"
import { NotificationsSection } from "../src/components/NotificationsSection"
import * as storageModule from "../src/storage"
import * as notificationsModule from "../src/notifications"
import * as backgroundModule from "../src/background-notifications"

jest.mock("../src/storage", () => ({
  loadTheme: jest.fn(async () => null),
  saveTheme: jest.fn(async () => {}),
  clearTheme: jest.fn(async () => {}),
  loadPalette: jest.fn(async () => null),
  savePalette: jest.fn(async () => {}),
  clearPalette: jest.fn(async () => {}),
  loadNotificationsEnabled: jest.fn(async () => false),
  saveNotificationsEnabled: jest.fn(async () => {}),
  loadAgentActivityPreferences: jest.fn(async () => ({
    finished: true,
    failed: true,
    permission: true,
    question: true,
  })),
  saveAgentActivityPreferences: jest.fn(async () => {}),
  loadBusySnapshot: jest.fn(async () => ({})),
  saveBusySnapshot: jest.fn(async () => {}),
}))

jest.mock("../src/notifications", () => ({
  getNotificationPermission: jest.fn(async () => false),
  requestNotificationPermission: jest.fn(async () => true),
  sendTestNotification: jest.fn(async () => "id"),
}))

jest.mock("../src/background-notifications", () => ({
  registerAgentActivityTask: jest.fn(async () => {}),
  unregisterAgentActivityTask: jest.fn(async () => {}),
}))

const storage = storageModule as unknown as {
  loadNotificationsEnabled: jest.Mock
  saveNotificationsEnabled: jest.Mock
  loadAgentActivityPreferences: jest.Mock
  saveAgentActivityPreferences: jest.Mock
}
const notifications = notificationsModule as unknown as {
  requestNotificationPermission: jest.Mock
  sendTestNotification: jest.Mock
  getNotificationPermission: jest.Mock
}
const background = backgroundModule as unknown as {
  registerAgentActivityTask: jest.Mock
  unregisterAgentActivityTask: jest.Mock
}

async function setup() {
  await render(
    <ThemeProvider>
      <NotificationsSection />
    </ThemeProvider>,
  )
}

describe("NotificationsSection", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    storage.loadNotificationsEnabled.mockResolvedValue(false)
    storage.loadAgentActivityPreferences.mockResolvedValue({
      finished: true,
      failed: true,
      permission: true,
      question: true,
    })
    notifications.getNotificationPermission.mockResolvedValue(false)
    notifications.requestNotificationPermission.mockResolvedValue(true)
  })

  it("renders the toggle", async () => {
    await setup()
    expect(await screen.findByLabelText("Agent activity notifications")).toBeOnTheScreen()
  })

  it("enables notifications and registers the background task", async () => {
    await setup()
    const toggle = await screen.findByLabelText("Agent activity notifications")
    fireEvent(toggle, "onValueChange", true)
    await waitFor(() => expect(storage.saveNotificationsEnabled).toHaveBeenCalledWith(true))
    expect(background.registerAgentActivityTask).toHaveBeenCalled()
  })

  it("sends a test notification", async () => {
    await setup()
    fireEvent.press(await screen.findByLabelText("Send a test notification"))
    await waitFor(() => expect(notifications.sendTestNotification).toHaveBeenCalled())
  })

  it("warns when the OS permission is blocked", async () => {
    notifications.requestNotificationPermission.mockResolvedValue(false)
    await setup()
    fireEvent(await screen.findByLabelText("Agent activity notifications"), "onValueChange", true)
    expect(await screen.findByText(/blocked/)).toBeOnTheScreen()
    expect(storage.saveNotificationsEnabled).not.toHaveBeenCalled()
  })

  it("disables notifications and unregisters the task", async () => {
    storage.loadNotificationsEnabled.mockResolvedValue(true)
    await setup()
    const toggle = await screen.findByLabelText("Agent activity notifications")
    fireEvent(toggle, "onValueChange", false)
    await waitFor(() => expect(storage.saveNotificationsEnabled).toHaveBeenCalledWith(false))
    expect(background.unregisterAgentActivityTask).toHaveBeenCalled()
  })

  it("warns when the test is blocked and opens system settings", async () => {
    const { Linking } = require("react-native") as { Linking: { openSettings: jest.Mock } }
    Linking.openSettings = jest.fn(async () => {})
    notifications.requestNotificationPermission.mockResolvedValue(false)
    await setup()
    fireEvent.press(await screen.findByLabelText("Send a test notification"))
    expect(await screen.findByText(/blocked/)).toBeOnTheScreen()
    fireEvent.press(await screen.findByLabelText("Open system notification settings"))
    expect(Linking.openSettings).toHaveBeenCalled()
  })

  it("falls back when storage and permission fail", async () => {
    storage.loadNotificationsEnabled.mockRejectedValue(new Error("no store"))
    notifications.getNotificationPermission.mockRejectedValue(new Error("no host"))
    await setup()
    expect(await screen.findByLabelText("Agent activity notifications")).toBeOnTheScreen()
  })

  it("shows the granted state", async () => {
    storage.loadNotificationsEnabled.mockResolvedValue(true)
    notifications.getNotificationPermission.mockResolvedValue(true)
    await setup()
    expect(await screen.findByText("System permission granted")).toBeOnTheScreen()
  })

  it("renders the per-event switches disabled while the master is off", async () => {
    await setup()
    for (const label of [
      "Notify when an agent finishes",
      "Notify when an agent fails",
      "Notify for permission requests",
      "Notify for questions",
    ]) {
      // RNTL's toBeDisabled does not understand React Native's Switch props.
      const control = await screen.findByLabelText(label)
      expect(control.props.disabled).toBe(true)
    }
  })

  it("persists a per-event switch and reports it to the app", async () => {
    storage.loadNotificationsEnabled.mockResolvedValue(true)
    notifications.getNotificationPermission.mockResolvedValue(true)
    const onPreferencesChange = jest.fn()
    await render(
      <ThemeProvider>
        <NotificationsSection onPreferencesChange={onPreferencesChange} />
      </ThemeProvider>,
    )
    fireEvent(
      await screen.findByLabelText("Notify for questions"),
      "onValueChange",
      false,
    )
    await waitFor(() =>
      expect(storage.saveAgentActivityPreferences).toHaveBeenCalledWith({
        finished: true,
        failed: true,
        permission: true,
        question: false,
      }),
    )
    expect(onPreferencesChange).toHaveBeenCalledWith({
      finished: true,
      failed: true,
      permission: true,
      question: false,
    })
  })

  it("unregisters the background task when finishes are turned off", async () => {
    storage.loadNotificationsEnabled.mockResolvedValue(true)
    notifications.getNotificationPermission.mockResolvedValue(true)
    await setup()
    fireEvent(await screen.findByLabelText("Notify when an agent finishes"), "onValueChange", false)
    await waitFor(() => expect(background.unregisterAgentActivityTask).toHaveBeenCalled())
  })
})
