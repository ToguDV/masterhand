import { Platform } from "react-native"
import * as SystemNotifications from "expo-notifications"

/** Android channel for agent activity (finished/failed/permission/question). */
export const AGENT_ACTIVITY_CHANNEL_ID = "agent-activity"

export interface AgentNotificationData {
  profileID: string
  sessionID: string
  kind: "finished" | "failed" | "permission" | "question"
  workspaceID?: string
}

/** Foreground handler: show the banner/list, no sound/badge by default. */
export function setupNotificationHandler(): void {
  try {
    SystemNotifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldPlaySound: false,
        shouldSetBadge: false,
        shouldShowBanner: true,
        shouldShowList: true,
      }),
    })
  } catch {
    // No native host under Jest: setup is best-effort.
  }
}

/** Creates the Android channel; no-op on other platforms. Never throws. */
export async function ensureAgentChannel(): Promise<void> {
  try {
    if (Platform.OS !== "android") return
    await SystemNotifications.setNotificationChannelAsync(AGENT_ACTIVITY_CHANNEL_ID, {
      name: "Agent activity",
      importance: SystemNotifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
    })
  } catch {
    // Best-effort: a missing channel falls back to Miscellaneous.
  }
}

async function isGranted(): Promise<boolean> {
  try {
    const settings = await SystemNotifications.getPermissionsAsync()
    return Boolean((settings as { granted?: boolean }).granted ?? settings.status === "granted")
  } catch {
    return false
  }
}

/**
 * Ensures the channel exists (Android needs it before the OS prompt), then
 * returns whether notifications are allowed. Never throws.
 */
export async function requestNotificationPermission(): Promise<boolean> {
  try {
    await ensureAgentChannel()
    if (await isGranted()) return true
    const next = await SystemNotifications.requestPermissionsAsync()
    return Boolean((next as { granted?: boolean }).granted ?? next.status === "granted")
  } catch {
    return false
  }
}

/** Current permission without prompting. Never throws. */
export async function getNotificationPermission(): Promise<boolean> {
  return isGranted()
}

/**
 * Schedules an immediate local notification on the agent channel.
 * Best-effort: resolves null when the native call fails (Jest/no host).
 */
export async function notifyAgentActivity(input: {
  title: string
  body: string
  data: AgentNotificationData
}): Promise<string | null> {
  try {
    return await SystemNotifications.scheduleNotificationAsync({
      content: {
        title: input.title,
        body: input.body,
        data: { ...input.data } as unknown as Record<string, unknown>,
      },
      trigger: { channelId: AGENT_ACTIVITY_CHANNEL_ID },
    })
  } catch {
    return null
  }
}

/** Sends a test notification (Settings > Notifications). */
export async function sendTestNotification(): Promise<string | null> {
  return notifyAgentActivity({
    title: "Test notification",
    body: "Agent notifications are working on this device.",
    data: { profileID: "test", sessionID: "test", kind: "finished" },
  })
}

/** Dismisses presented notifications of one session. Never throws. */
export async function dismissSessionNotifications(sessionID: string): Promise<void> {
  try {
    const presented = await SystemNotifications.getPresentedNotificationsAsync()
    const own = (presented ?? []).filter(
      (item) => (item.request.content.data as { sessionID?: string } | undefined)?.sessionID === sessionID,
    )
    await Promise.all(
      own.map((item) => SystemNotifications.dismissNotificationAsync(item.request.identifier)),
    )
  } catch {
    // Best-effort cleanup.
  }
}
