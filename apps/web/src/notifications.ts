import {
  DEFAULT_AGENT_ACTIVITY_PREFERENCES,
  normalizeAgentActivityPreferences,
  type AgentActivityKind,
  type AgentActivityPreferences,
} from "@masterhand/client-core"

/** One localStorage entry keeps the master switch and the per-kind switches together. */
const STORAGE_KEY = "mh-notifications"

export interface NotificationPreferences {
  enabled: boolean
  kinds: AgentActivityPreferences
}

/** On by default: the desktop shell grants the OS permission without a prompt. */
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  enabled: true,
  kinds: DEFAULT_AGENT_ACTIVITY_PREFERENCES,
}

export interface AgentNotificationData {
  profileID: string
  sessionID: string
  workspaceID?: string
  kind: AgentActivityKind
}

const openBySession = new Map<string, Set<Notification>>()

function normalizeStored(value: unknown): NotificationPreferences {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : true,
    kinds: normalizeAgentActivityPreferences(record.kinds),
  }
}

export function loadNotificationPreferences(): NotificationPreferences {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw ? normalizeStored(JSON.parse(raw) as unknown) : DEFAULT_NOTIFICATION_PREFERENCES
  } catch {
    return DEFAULT_NOTIFICATION_PREFERENCES
  }
}

export function saveNotificationPreferences(preferences: NotificationPreferences): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences))
  } catch {
    // Storage may be unavailable (private mode); this session still works.
  }
}

/**
 * Notification API present and usable: secure context (HTTPS or localhost) in
 * a browser. The Electron shell owns its own permission model and supports
 * plain-HTTP LAN deployments, so it skips the secure-context gate.
 */
export function notificationsSupported(): boolean {
  if (typeof window === "undefined" || !("Notification" in window)) return false
  const electron =
    typeof navigator !== "undefined" && /(?:^|\s)Electron\//.test(navigator.userAgent)
  return electron || window.isSecureContext !== false
}

/** `unsupported` covers old browsers and plain-HTTP deployments. */
export function notificationPermission(): NotificationPermission | "unsupported" {
  if (!notificationsSupported()) return "unsupported"
  try {
    return Notification.permission
  } catch {
    return "unsupported"
  }
}

/**
 * Asks the browser/OS for permission. Must be called from a user gesture
 * (Settings > Notifications). Electron grants it without a prompt.
 */
export async function requestNotificationPermission(): Promise<boolean> {
  if (!notificationsSupported()) return false
  try {
    if (Notification.permission === "granted") return true
    const result = await Notification.requestPermission()
    return result === "granted"
  } catch {
    return false
  }
}

function forget(sessionID: string, notification: Notification): void {
  const set = openBySession.get(sessionID)
  if (!set) return
  set.delete(notification)
  if (set.size === 0) openBySession.delete(sessionID)
}

/**
 * Shows one local OS notification. Best-effort: unsupported/denied permissions
 * and a failing OS call resolve null instead of throwing into the SSE handler.
 */
export function showAgentNotification(input: {
  title: string
  body: string
  data: AgentNotificationData
  onClick?: () => void
}): Notification | null {
  if (notificationPermission() !== "granted") return null
  try {
    const notification = new Notification(input.title, {
      body: input.body,
      // Replacing the same kind for the same session avoids stacking stale
      // banners while still allowing permission + question to coexist.
      tag: `masterhand-${input.data.sessionID}-${input.data.kind}`,
      ...(input.data.kind === "permission" || input.data.kind === "question"
        ? { requireInteraction: true }
        : {}),
    })
    const set = openBySession.get(input.data.sessionID) ?? new Set<Notification>()
    set.add(notification)
    openBySession.set(input.data.sessionID, set)
    notification.onclose = () => forget(input.data.sessionID, notification)
    notification.onclick = () => {
      try {
        window.focus()
      } catch {
        // Focus is best-effort (some window managers refuse it).
      }
      input.onClick?.()
      notification.close()
      forget(input.data.sessionID, notification)
    }
    return notification
  } catch {
    return null
  }
}

/** Sends the Settings > Notifications test alert. */
export function sendTestNotification(): void {
  showAgentNotification({
    title: "Test notification",
    body: "Agent notifications are working on this device.",
    data: { profileID: "test", sessionID: "test", kind: "finished" },
  })
}

/** Closing the opened session's banners, or a new turn superseding them. */
export function dismissSessionNotifications(sessionID: string): void {
  const set = openBySession.get(sessionID)
  if (!set) return
  for (const notification of set) {
    try {
      notification.close()
    } catch {
      // Best-effort cleanup.
    }
  }
  openBySession.delete(sessionID)
}

/** Profile switch / logout / unmount: nothing from the old server stays visible. */
export function closeAllNotifications(): void {
  for (const sessionID of [...openBySession.keys()]) dismissSessionNotifications(sessionID)
}
