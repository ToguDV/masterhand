// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_AGENT_ACTIVITY_PREFERENCES } from "@masterhand/client-core"
import { createAgentActivityObserver } from "../src/agent-notifications"
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  dismissSessionNotifications,
  loadNotificationPreferences,
  saveNotificationPreferences,
  showAgentNotification,
  type NotificationPreferences,
} from "../src/notifications"

class FakeNotification {
  static permission: NotificationPermission = "granted"
  static instances: FakeNotification[] = []

  onclick: (() => void) | null = null
  onclose: (() => void) | null = null
  close = vi.fn(() => this.onclose?.())

  constructor(
    public title: string,
    public options?: NotificationOptions,
  ) {
    FakeNotification.instances.push(this)
  }
}

const KEY = "mh-notifications"

function prefs(overrides: Partial<NotificationPreferences> = {}): NotificationPreferences {
  return { ...DEFAULT_NOTIFICATION_PREFERENCES, ...overrides }
}

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("notification preferences storage", () => {
  it("is enabled with every kind by default", () => {
    expect(loadNotificationPreferences()).toEqual({
      enabled: true,
      kinds: DEFAULT_AGENT_ACTIVITY_PREFERENCES,
    })
  })

  it("round-trips the master switch and the kinds", () => {
    saveNotificationPreferences({
      enabled: false,
      kinds: { ...DEFAULT_AGENT_ACTIVITY_PREFERENCES, question: false },
    })
    expect(loadNotificationPreferences()).toEqual({
      enabled: false,
      kinds: { ...DEFAULT_AGENT_ACTIVITY_PREFERENCES, question: false },
    })
  })

  it("falls back field by field on malformed storage", () => {
    window.localStorage.setItem(KEY, "{not json")
    expect(loadNotificationPreferences()).toEqual(prefs())
    window.localStorage.setItem(KEY, JSON.stringify({ enabled: "no", kinds: { failed: false } }))
    expect(loadNotificationPreferences()).toEqual({
      enabled: true,
      kinds: { ...DEFAULT_AGENT_ACTIVITY_PREFERENCES, failed: false },
    })
  })
})

function session(overrides = {}) {
  return {
    id: "ses_1",
    title: "My session",
    parentID: null,
    fork: null,
    goalRole: undefined,
    ...overrides,
  }
}

function setup(options: {
  isActive?: boolean
  preferences?: NotificationPreferences
  sessions?: ReturnType<typeof session>[]
} = {}) {
  const notify = vi.fn()
  const dismissSession = vi.fn()
  const observer = createAgentActivityObserver({
    isActive: () => options.isActive ?? false,
    preferences: () => options.preferences ?? prefs(),
    sessions: () => options.sessions ?? [session()],
    notify,
    dismissSession,
  })
  return { observer, notify, dismissSession }
}

describe("agent activity observer", () => {
  it("notifies a finish only after a busy mark", () => {
    const { observer, notify } = setup()
    observer.observe({ type: "session.idle", data: { sessionID: "ses_1" } })
    expect(notify).not.toHaveBeenCalled()

    observer.observe({ type: "session.execution.started", data: { sessionID: "ses_1" } })
    observer.observe({ type: "session.idle", data: { sessionID: "ses_1" } })
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "finished", sessionID: "ses_1", title: "My session" }),
    )
  })

  it("seeds busy from a statuses snapshot", () => {
    const { observer, notify } = setup()
    observer.markBusy("ses_1")
    observer.observe({ type: "session.execution.succeeded", data: { sessionID: "ses_1" } })
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "finished" }))
  })

  it("stays silent while the window is active", () => {
    const { observer, notify } = setup({ isActive: true })
    observer.observe({ type: "session.execution.started", data: { sessionID: "ses_1" } })
    observer.observe({ type: "session.idle", data: { sessionID: "ses_1" } })
    expect(notify).not.toHaveBeenCalled()
  })

  it("honors the master switch and each kind", () => {
    const disabled = setup({ preferences: prefs({ enabled: false }) })
    disabled.observer.observe({ type: "session.execution.started", data: { sessionID: "ses_1" } })
    disabled.observer.observe({ type: "session.idle", data: { sessionID: "ses_1" } })
    expect(disabled.notify).not.toHaveBeenCalled()

    const noQuestions = setup({
      preferences: prefs({
        kinds: { ...DEFAULT_AGENT_ACTIVITY_PREFERENCES, question: false },
      }),
    })
    noQuestions.observer.observe({
      type: "form.created",
      data: { form: { id: "frm_1", sessionID: "ses_1", metadata: { kind: "question" } } },
    })
    expect(noQuestions.notify).not.toHaveBeenCalled()

    const noFinished = setup({
      preferences: prefs({
        kinds: { ...DEFAULT_AGENT_ACTIVITY_PREFERENCES, finished: false },
      }),
    })
    noFinished.observer.observe({ type: "session.execution.started", data: { sessionID: "ses_1" } })
    noFinished.observer.observe({ type: "session.idle", data: { sessionID: "ses_1" } })
    expect(noFinished.notify).not.toHaveBeenCalled()
  })

  it("dedups permission alerts until the reply event", () => {
    const { observer, notify } = setup()
    observer.observe({ type: "permission.asked", data: { id: "perm_1", sessionID: "ses_1" } })
    observer.observe({ type: "permission.asked", data: { id: "perm_1", sessionID: "ses_1" } })
    expect(notify).toHaveBeenCalledTimes(1)

    observer.observe({ type: "permission.replied", data: { requestID: "perm_1" } })
    observer.observe({ type: "permission.asked", data: { id: "perm_1", sessionID: "ses_1" } })
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it("notifies failures and ignores interrupted/internal runs", () => {
    const { observer, notify } = setup()
    observer.observe({ type: "session.execution.interrupted", data: { sessionID: "ses_1" } })
    expect(notify).not.toHaveBeenCalled()

    observer.observe({ type: "session.execution.failed", data: { sessionID: "ses_1" } })
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "failed" }))

    const internal = setup({ sessions: [session({ parentID: "ses_parent" })] })
    internal.observer.observe({ type: "permission.asked", data: { id: "perm_2", sessionID: "ses_1" } })
    expect(internal.notify).not.toHaveBeenCalled()
  })

  it("dismisses a session's stale banner when a new turn starts", () => {
    const { observer, dismissSession } = setup()
    observer.observe({ type: "session.execution.started", data: { sessionID: "ses_1" } })
    expect(dismissSession).toHaveBeenCalledWith("ses_1")
  })
})

describe("system notification wrapper", () => {
  beforeEach(() => {
    FakeNotification.permission = "granted"
    FakeNotification.instances = []
    vi.stubGlobal("Notification", FakeNotification)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("creates a notification, focuses the window and runs the click handler", () => {
    const onClick = vi.fn()
    const focus = vi.spyOn(window, "focus").mockImplementation(() => {})
    const notification = showAgentNotification({
      title: "Agent finished",
      body: "My session",
      data: { profileID: "p1", sessionID: "ses_1", kind: "finished" },
      onClick,
    })
    expect(notification).toBe(FakeNotification.instances[0])
    expect(FakeNotification.instances[0]?.options?.tag).toBe("masterhand-ses_1-finished")

    notification?.onclick?.(new Event("click"))
    expect(focus).toHaveBeenCalled()
    expect(onClick).toHaveBeenCalled()
  })

  it("dismisses every banner of one session", () => {
    showAgentNotification({
      title: "Agent finished",
      body: "One",
      data: { profileID: "p1", sessionID: "ses_1", kind: "finished" },
    })
    showAgentNotification({
      title: "Agent failed",
      body: "Two",
      data: { profileID: "p1", sessionID: "ses_1", kind: "failed" },
    })
    showAgentNotification({
      title: "Agent finished",
      body: "Other",
      data: { profileID: "p1", sessionID: "ses_2", kind: "finished" },
    })
    dismissSessionNotifications("ses_1")
    expect(FakeNotification.instances[0]?.close).toHaveBeenCalled()
    expect(FakeNotification.instances[1]?.close).toHaveBeenCalled()
    expect(FakeNotification.instances[2]?.close).not.toHaveBeenCalled()
  })

  it("stays silent without the OS permission", () => {
    FakeNotification.permission = "denied"
    expect(
      showAgentNotification({
        title: "Agent finished",
        body: "My session",
        data: { profileID: "p1", sessionID: "ses_1", kind: "finished" },
      }),
    ).toBeNull()
    expect(FakeNotification.instances).toHaveLength(0)
  })
})
