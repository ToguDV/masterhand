import { useCallback, useEffect, useState } from "react"
import { Linking, Pressable, StyleSheet, Switch, Text, View } from "react-native"
import {
  DEFAULT_AGENT_ACTIVITY_PREFERENCES,
  type AgentActivityKind,
  type AgentActivityPreferences,
} from "@masterhand/client-core"
import { useTheme, useThemedStyles, type Fonts, type Palette } from "../theme"
import {
  loadAgentActivityPreferences,
  loadNotificationsEnabled,
  saveAgentActivityPreferences,
  saveNotificationsEnabled,
} from "../storage"
import {
  getNotificationPermission,
  requestNotificationPermission,
  sendTestNotification,
} from "../notifications"
import { registerAgentActivityTask, unregisterAgentActivityTask } from "../background-notifications"

const KINDS: Array<{
  kind: AgentActivityKind
  label: string
  description: string
  accessibilityLabel: string
}> = [
  {
    kind: "finished",
    label: "Agent finished",
    description: "A run completes or goes idle.",
    accessibilityLabel: "Notify when an agent finishes",
  },
  {
    kind: "failed",
    label: "Agent failed",
    description: "A run ends with an error.",
    accessibilityLabel: "Notify when an agent fails",
  },
  {
    kind: "permission",
    label: "Permission requests",
    description: "An agent needs approval to continue.",
    accessibilityLabel: "Notify for permission requests",
  },
  {
    kind: "question",
    label: "Questions",
    description: "An agent asks you for input.",
    accessibilityLabel: "Notify for questions",
  },
]

/**
 * Settings > Notifications: local agent-activity alerts without Play Console
 * or Firebase. Off by default; enabling asks the OS permission once, creates
 * the Android channel and registers the 15-minute background check. Each event
 * kind has its own switch, and the background task only runs for finishes.
 */
export function NotificationsSection({
  onEnabledChange,
  onPreferencesChange,
}: {
  onEnabledChange?: (enabled: boolean) => void
  onPreferencesChange?: (preferences: AgentActivityPreferences) => void
} = {}) {
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()
  const [enabled, setEnabled] = useState(false)
  const [granted, setGranted] = useState(false)
  const [preferences, setPreferences] = useState<AgentActivityPreferences>(
    DEFAULT_AGENT_ACTIVITY_PREFERENCES,
  )
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [stored, permission, kinds] = await Promise.all([
        loadNotificationsEnabled().catch(() => false),
        getNotificationPermission().catch(() => false),
        loadAgentActivityPreferences().catch(() => DEFAULT_AGENT_ACTIVITY_PREFERENCES),
      ])
      if (cancelled) return
      setEnabled(stored)
      setGranted(permission)
      setPreferences(kinds)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const refreshPermission = useCallback(async () => {
    setGranted(await getNotificationPermission().catch(() => false))
  }, [])

  const setOn = useCallback(
    async (on: boolean) => {
      setBusy(true)
      setNotice(null)
      try {
        if (on) {
          const allowed = await requestNotificationPermission()
          setGranted(allowed)
          if (!allowed) {
            setNotice("Notifications are blocked. Allow them in the system settings first.")
            return
          }
          await saveNotificationsEnabled(true)
          if (preferences.finished) await registerAgentActivityTask()
          setEnabled(true)
          onEnabledChange?.(true)
        } else {
          await saveNotificationsEnabled(false)
          await unregisterAgentActivityTask()
          setEnabled(false)
          onEnabledChange?.(false)
        }
      } finally {
        setBusy(false)
      }
    },
    [onEnabledChange, preferences.finished],
  )

  const setKind = useCallback(
    async (kind: AgentActivityKind, value: boolean) => {
      if (busy) return
      const next = { ...preferences, [kind]: value }
      setBusy(true)
      setNotice(null)
      setPreferences(next)
      try {
        await saveAgentActivityPreferences(next)
        onPreferencesChange?.(next)
        // The periodic task exists only for finishes: keep it in sync so the
        // device does not wake up for alerts the user turned off.
        if (kind === "finished") {
          if (enabled && value) await registerAgentActivityTask()
          if (!value) await unregisterAgentActivityTask()
        }
      } catch {
        // A failed write must not leave the switch lying about the device.
        setPreferences(preferences)
        setNotice("Could not save the notification settings.")
      } finally {
        setBusy(false)
      }
    },
    [busy, enabled, onPreferencesChange, preferences],
  )

  const sendTest = useCallback(async () => {
    setBusy(true)
    setNotice(null)
    try {
      const allowed = await requestNotificationPermission()
      setGranted(allowed)
      if (!allowed) {
        setNotice("Notifications are blocked. Allow them in the system settings first.")
        return
      }
      await sendTestNotification()
      setNotice("Test sent. Check the notification tray.")
    } finally {
      setBusy(false)
    }
  }, [])

  return (
    <View>
      <Text style={styles.sectionTitle}>Notifications</Text>
      <Text style={styles.desc}>
        Local alerts when an agent finishes, fails or needs approval while the app is in the
        background. No Play Store account, no Firebase.
      </Text>

      <View style={styles.row}>
        <View style={styles.rowText}>
          <Text style={styles.rowLabel}>Agent activity</Text>
          <Text style={styles.rowDesc}>
            {granted ? "System permission granted" : "System permission not granted"}
          </Text>
        </View>
        <Switch
          value={enabled}
          disabled={busy}
          accessibilityLabel="Agent activity notifications"
          trackColor={{ true: colors.accent }}
          onValueChange={(value) => void setOn(value)}
        />
      </View>

      {KINDS.map((item) => (
        <View key={item.kind} style={[styles.row, !enabled && styles.rowDisabled]}>
          <View style={styles.rowText}>
            <Text style={styles.rowLabel}>{item.label}</Text>
            <Text style={styles.rowDesc}>{item.description}</Text>
          </View>
          <Switch
            value={preferences[item.kind]}
            disabled={busy || !enabled}
            accessibilityLabel={item.accessibilityLabel}
            trackColor={{ true: colors.accent }}
            onValueChange={(value) => void setKind(item.kind, value)}
          />
        </View>
      ))}

      {!enabled ? (
        <Text style={styles.hint}>Turn on Agent activity to use these switches.</Text>
      ) : null}

      {notice ? <Text style={styles.notice}>{notice}</Text> : null}

      <View style={styles.actions}>
        <Pressable
          onPress={() => void sendTest()}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Send a test notification"
          style={styles.button}
        >
          <Text style={styles.buttonText}>Send test</Text>
        </Pressable>
        <Pressable
          onPress={() => {
            void Linking.openSettings().catch(() => {})
            void refreshPermission()
          }}
          accessibilityRole="button"
          accessibilityLabel="Open system notification settings"
          style={styles.button}
        >
          <Text style={styles.buttonText}>System settings</Text>
        </Pressable>
      </View>

      <Text style={styles.hint}>
        When the app is closed the check runs about every 15 minutes (Android decides the exact
        time). With the app in the background but alive, alerts arrive immediately.
      </Text>
    </View>
  )
}

function createStyles(colors: Palette, fonts: Fonts) {
  return StyleSheet.create({
    sectionTitle: {
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 16,
      fontWeight: "600",
      marginBottom: 6,
    },
    desc: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 13,
      marginBottom: 12,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingVertical: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.hairline,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.hairline,
    },
    rowDisabled: { opacity: 0.5 },
    rowText: { flex: 1, paddingRight: 12 },
    rowLabel: { color: colors.text, fontFamily: fonts.ui, fontSize: 14, fontWeight: "600" },
    rowDesc: { color: colors.textMuted, fontFamily: fonts.ui, fontSize: 12, marginTop: 2 },
    notice: { color: colors.warning, fontFamily: fonts.ui, fontSize: 12, marginTop: 8 },
    actions: { flexDirection: "row", gap: 8, marginTop: 12 },
    button: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairlineStrong,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      minHeight: 44,
      justifyContent: "center",
    },
    buttonText: { color: colors.text, fontFamily: fonts.ui, fontSize: 13, fontWeight: "600" },
    hint: { color: colors.textFaint, fontFamily: fonts.ui, fontSize: 12, marginTop: 12 },
  })
}
