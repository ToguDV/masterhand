// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_AGENT_ACTIVITY_PREFERENCES } from "@masterhand/client-core"
import { NotificationsSection } from "../src/components/NotificationsSection"
import type { NotificationPreferences } from "../src/notifications"

class FakeNotification {
  static permission: NotificationPermission = "granted"
  static requestPermission = vi.fn(async () => FakeNotification.permission)

  onclose: (() => void) | null = null
  onclick: (() => void) | null = null
  close = vi.fn()

  constructor(
    public title: string,
    public options?: NotificationOptions,
  ) {}
}

const defaults: NotificationPreferences = {
  enabled: true,
  kinds: DEFAULT_AGENT_ACTIVITY_PREFERENCES,
}

beforeEach(() => {
  FakeNotification.permission = "granted"
  FakeNotification.requestPermission = vi.fn(async () => FakeNotification.permission)
  vi.stubGlobal("Notification", FakeNotification)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("NotificationsSection", () => {
  it("renders the master switch and every event kind", () => {
    render(<NotificationsSection preferences={defaults} onChange={() => {}} />)

    expect(screen.getByRole("switch", { name: "Agent activity" }).getAttribute("aria-checked")).toBe(
      "true",
    )
    for (const label of ["Agent finished", "Agent failed", "Permission requests", "Questions"]) {
      expect(screen.getByRole("switch", { name: label })).toBeTruthy()
    }
    expect(screen.getByText("System permission granted")).toBeTruthy()
  })

  it("persists a category change", () => {
    const onChange = vi.fn()
    render(<NotificationsSection preferences={defaults} onChange={onChange} />)

    fireEvent.click(screen.getByRole("switch", { name: "Questions" }))
    expect(onChange).toHaveBeenCalledWith({
      ...defaults,
      kinds: { ...DEFAULT_AGENT_ACTIVITY_PREFERENCES, question: false },
    })
  })

  it("disables the kinds when the master switch is off", () => {
    render(
      <NotificationsSection preferences={{ ...defaults, enabled: false }} onChange={() => {}} />,
    )
    expect(screen.getByRole("switch", { name: "Agent finished" })).toHaveProperty("disabled", true)
  })

  it("requests the OS permission when it is still pending", async () => {
    FakeNotification.permission = "default"
    FakeNotification.requestPermission.mockResolvedValue("granted")
    const onChange = vi.fn()
    render(<NotificationsSection preferences={defaults} onChange={onChange} />)

    fireEvent.click(screen.getByRole("button", { name: "Allow notifications" }))
    await waitFor(() => expect(FakeNotification.requestPermission).toHaveBeenCalled())
    expect(onChange).toHaveBeenCalledWith(defaults)
  })

  it("explains a blocked permission", () => {
    FakeNotification.permission = "denied"
    render(<NotificationsSection preferences={defaults} onChange={() => {}} />)

    expect(screen.getByText(/Notifications are blocked/)).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Allow notifications" })).toBeNull()
  })

  it("sends a test notification when permission is granted", async () => {
    render(<NotificationsSection preferences={defaults} onChange={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: "Send test" }))
    await waitFor(() =>
      expect(screen.getByText("Test sent. Check the notification tray.")).toBeTruthy(),
    )
  })
})
