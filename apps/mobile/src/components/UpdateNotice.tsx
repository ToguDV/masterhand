import { useMemo, useState } from "react"
import { Linking, Modal, Pressable, StyleSheet, Switch, Text, View } from "react-native"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { queryKeys, type Client } from "@masterhand/client-core"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useTheme, useThemedStyles, type Fonts, type Palette } from "../theme"
import {
  FDROID_WEBSITE_URL,
  checkMobileUpdate,
  installedVersion,
  openFdroidListing,
} from "../update"
import { CloseIcon } from "./icons"

const UPDATE_POLL_MS = 60 * 60 * 1000

function useMobileUpdate(client: Client, enabled = true) {
  const installed = useMemo(() => installedVersion(), [])
  return {
    installed,
    query: useQuery({
      queryKey: [...queryKeys.update, "mobile"],
      queryFn: () => checkMobileUpdate({ client, installed }),
      enabled,
      staleTime: UPDATE_POLL_MS,
      refetchInterval: enabled ? UPDATE_POLL_MS : false,
      retry: false,
    }),
  }
}

/**
 * Android update notice (#133): a dismissible popup instead of a permanent
 * banner. The check prefers the BFF manifest and falls back to the F-Droid
 * index; either way the only install action deep-links into F-Droid (or its
 * website) — MasterHand never downloads or installs an APK itself.
 *
 * Checks run only when enabled in Settings > About. "Later" hides the notice
 * for this session; "Don't show again" persists the dismissed tag, so a newer
 * release can still announce itself.
 */
export function UpdateBanner({
  client,
  enabled = true,
  dismissedTag = null,
  onDismiss,
  suppressed = false,
}: {
  client: Client
  enabled?: boolean
  dismissedTag?: string | null
  onDismiss?: (tag: string) => void
  /** Keeps the popup from covering another modal (e.g. Settings). */
  suppressed?: boolean
}) {
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const { query } = useMobileUpdate(client, enabled)
  const [hiddenTag, setHiddenTag] = useState<string | null>(null)
  const update = query.data?.update ?? null

  if (!enabled || !update || suppressed) return null
  if (update.tag === dismissedTag || update.tag === hiddenTag) return null

  function later(): void {
    if (update) setHiddenTag(update.tag)
  }

  function never(): void {
    if (!update) return
    setHiddenTag(update.tag)
    onDismiss?.(update.tag)
  }

  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent onRequestClose={later}>
      <Pressable
        style={styles.backdrop}
        onPress={later}
        accessible={false}
        importantForAccessibility="no"
      >
        <Pressable
          style={[styles.sheet, { paddingBottom: Math.max(16, insets.bottom + 12) }]}
          onPress={() => {}}
          accessible={false}
          accessibilityViewIsModal
        >
          <View style={styles.head}>
            <Text style={styles.title}>Update available</Text>
            <Pressable
              onPress={later}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Close update notice"
              style={styles.close}
            >
              <CloseIcon size={18} color={colors.textMuted} />
            </Pressable>
          </View>
          <Text style={styles.message}>
            MasterHand {update.version} is available
            {update.source === "fdroid" ? " on F-Droid" : ""}.
          </Text>
          <View style={styles.actions}>
            <Pressable
              onPress={() => void openFdroidListing()}
              accessibilityRole="button"
              accessibilityLabel="Open F-Droid"
              style={styles.primary}
            >
              <Text style={styles.primaryText}>Open F-Droid</Text>
            </Pressable>
            <Pressable
              onPress={later}
              accessibilityRole="button"
              accessibilityLabel="Later"
              style={styles.secondary}
            >
              <Text style={styles.secondaryText}>Later</Text>
            </Pressable>
          </View>
          <Pressable
            onPress={never}
            accessibilityRole="button"
            accessibilityLabel="Don't show again"
            style={styles.dismiss}
          >
            <Text style={styles.dismissText}>Don&apos;t show again</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

/**
 * Settings > About (#133): installed version/build, the automatic-check
 * switch, the latest known release, the last check and the F-Droid entry
 * points (client listing + repo website). The manual check works even when
 * automatic checks are off.
 */
export function AboutSection({
  client,
  checksEnabled = true,
  onToggleChecks,
}: {
  client: Client
  checksEnabled?: boolean
  onToggleChecks?: (enabled: boolean) => void
}) {
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()
  const queryClient = useQueryClient()
  const installed = useMemo(() => installedVersion(), [])
  const { query } = useMobileUpdate(client, checksEnabled)
  const update = query.data?.update ?? null
  const lastChecked =
    query.dataUpdatedAt > 0 ? new Date(query.dataUpdatedAt).toLocaleString() : "never"

  async function checkNow(): Promise<void> {
    try {
      // One-shot fetch: works even when automatic checks are off.
      await queryClient.fetchQuery({
        queryKey: [...queryKeys.update, "mobile"],
        queryFn: () => checkMobileUpdate({ client, installed }),
        staleTime: 0,
      })
    } catch {
      // checkMobileUpdate already degrades every failure to `{ update: null }`.
    }
  }

  return (
    <View>
      <Text style={styles.sectionTitle}>About</Text>
      <Text style={styles.desc}>Release identity and updates.</Text>

      <View style={styles.row}>
        <View style={styles.rowText}>
          <Text style={styles.rowLabel}>Check for updates automatically</Text>
          <Text style={styles.rowDesc}>Looks for a newer release at most once an hour.</Text>
        </View>
        <Switch
          value={checksEnabled}
          accessibilityLabel="Check for updates automatically"
          trackColor={{ true: colors.accent }}
          onValueChange={(value) => onToggleChecks?.(value)}
        />
      </View>

      <View style={styles.rows}>
        <View style={styles.row}>
          <Text style={styles.label}>Installed version</Text>
          <Text style={styles.value}>{installed.versionName}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Build</Text>
          <Text style={styles.value}>{installed.versionCode}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Latest release</Text>
          <Text style={styles.value}>
            {query.isPending && checksEnabled ? "checking…" : update ? update.version : "not checked"}
          </Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Last checked</Text>
          <Text style={styles.value}>{lastChecked}</Text>
        </View>
      </View>
      <Text style={[styles.desc, { color: update ? colors.text : colors.textMuted }]}>
        {!checksEnabled
          ? "Automatic update checks are off. Check manually whenever you like."
          : update
            ? `MasterHand ${update.version} is available${update.source === "fdroid" ? " on F-Droid" : ""}.`
            : "You are up to date, or the release manifest is unreachable."}
      </Text>
      <View style={styles.actions}>
        <Pressable
          onPress={() => void checkNow()}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Check for updates"
          style={styles.button}
        >
          <Text style={styles.buttonText}>{query.isFetching ? "Checking…" : "Check for updates"}</Text>
        </Pressable>
        <Pressable
          onPress={() => void openFdroidListing()}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Open F-Droid"
          style={styles.button}
        >
          <Text style={styles.buttonText}>Open F-Droid</Text>
        </Pressable>
        <Pressable
          onPress={() => void Linking.openURL(FDROID_WEBSITE_URL)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Open F-Droid repository website"
          style={styles.button}
        >
          <Text style={styles.buttonText}>Repo website</Text>
        </Pressable>
      </View>
    </View>
  )
}

function createStyles(colors: Palette, fonts: Fonts) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      justifyContent: "flex-end",
      backgroundColor: colors.overlay,
    },
    sheet: {
      gap: 10,
      paddingTop: 8,
      paddingHorizontal: 16,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      backgroundColor: colors.surface,
    },
    head: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    title: {
      flex: 1,
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 16,
      fontWeight: "600",
    },
    close: {
      width: 40,
      height: 40,
      alignItems: "center",
      justifyContent: "center",
    },
    message: {
      color: colors.textSoft,
      fontFamily: fonts.ui,
      fontSize: 14,
      lineHeight: 20,
    },
    actions: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
      marginTop: 4,
    },
    primary: {
      flexGrow: 1,
      minHeight: 44,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 16,
      borderRadius: 10,
      backgroundColor: colors.accent,
    },
    primaryText: {
      color: "#fff",
      fontFamily: fonts.ui,
      fontSize: 14,
      fontWeight: "600",
    },
    secondary: {
      flexGrow: 1,
      minHeight: 44,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 16,
      borderRadius: 10,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairlineStrong,
    },
    secondaryText: {
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 14,
      fontWeight: "600",
    },
    dismiss: {
      minHeight: 44,
      alignItems: "center",
      justifyContent: "center",
    },
    dismissText: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 13,
    },
    sectionTitle: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 11,
      letterSpacing: 0.8,
      textTransform: "uppercase",
      fontWeight: "600",
    },
    desc: {
      marginTop: 6,
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 13,
    },
    rows: {
      marginTop: 12,
      gap: 6,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    rowText: {
      flex: 1,
      paddingRight: 12,
    },
    rowLabel: {
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 14,
      fontWeight: "600",
    },
    rowDesc: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 12,
      marginTop: 2,
    },
    label: {
      width: 130,
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 13,
    },
    value: {
      flex: 1,
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 13,
    },
    button: {
      minHeight: 44,
      justifyContent: "center",
      paddingHorizontal: 14,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.hairlineStrong,
      backgroundColor: colors.surface,
    },
    buttonText: {
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 13,
      fontWeight: "600",
    },
  })
}
