import { useCallback, useEffect, useState } from "react"
import { Linking, Pressable, StyleSheet, Switch, Text, View } from "react-native"
import { useTheme, useThemedStyles, type Fonts, type Palette } from "../theme"
import {
  loadNotificationsEnabled,
  saveNotificationsEnabled,
} from "../storage"
import {
  getNotificationPermission,
  requestNotificationPermission,
  sendTestNotification,
} from "../notifications"
import { registerAgentActivityTask, unregisterAgentActivityTask } from "../background-notifications"

/**
 * Settings > Notifications: local agent-activity alerts without Play Console
 * or Firebase. Off by default; enabling asks the OS permission once, creates
 * the Android channel and registers the 15-minute background check. The
 * background check is best-effort (WorkManager decides the exact timing).
 */
export function NotificationsSection() {
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()
  const [enabled, setEnabled] = useState(false)
  const [granted, setGranted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [stored, permission] = await Promise.all([
        loadNotificationsEnabled().catch(() => false),
        getNotificationPermission().catch(() => false),
      ])
      if (cancelled) return
      setEnabled(stored)
      setGranted(permission)
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
          await registerAgentActivityTask()
          setEnabled(true)
        } else {
          await saveNotificationsEnabled(false)
          await unregisterAgentActivityTask()
          setEnabled(false)
        }
      } finally {
        setBusy(false)
      }
    },
    [],
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
