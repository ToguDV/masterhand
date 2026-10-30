import { useMemo } from "react"
import { Linking, Pressable, StyleSheet, Text, View } from "react-native"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { queryKeys, type Client } from "@masterhand/client-core"
import { useTheme, useThemedStyles, type Fonts, type Palette } from "../theme"
import {
  FDROID_WEBSITE_URL,
  checkMobileUpdate,
  installedVersion,
  openFdroidListing,
} from "../update"

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
      refetchInterval: UPDATE_POLL_MS,
      retry: false,
    }),
  }
}

/**
 * Android update banner (#133): "New version available — Open F-Droid".
 * The check prefers the BFF manifest and falls back to the F-Droid index;
 * either way the only action deep-links into F-Droid (or its website) —
 * MasterHand never downloads or installs an APK itself.
 */
export function UpdateBanner({ client }: { client: Client }) {
  const styles = useThemedStyles(createStyles)
  const { query } = useMobileUpdate(client)
  const update = query.data?.update ?? null
  if (!update) return null
  return (
    <View style={styles.banner} accessibilityRole="alert">
      <Text style={styles.bannerText} numberOfLines={2} ellipsizeMode="tail">
        New version {update.version} available — Open F-Droid
      </Text>
      <Pressable
        onPress={() => void openFdroidListing()}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Open F-Droid"
        style={styles.bannerButton}
      >
        <Text style={styles.bannerButtonText}>Open F-Droid</Text>
      </Pressable>
    </View>
  )
}

/**
 * Settings > About (#133): installed version/build, the latest known release,
 * the last check and the F-Droid entry points (client listing + repo website).
 */
export function AboutSection({ client }: { client: Client }) {
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()
  const queryClient = useQueryClient()
  const { installed, query } = useMobileUpdate(client)
  const update = query.data?.update ?? null
  const lastChecked =
    query.dataUpdatedAt > 0 ? new Date(query.dataUpdatedAt).toLocaleString() : "never"

  return (
    <View>
      <Text style={styles.sectionTitle}>About</Text>
      <Text style={styles.desc}>Release identity and updates.</Text>
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
          <Text style={styles.value}>{query.isPending ? "checking…" : (update ? update.version : "unknown")}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Last checked</Text>
          <Text style={styles.value}>{lastChecked}</Text>
        </View>
      </View>
      <Text style={[styles.desc, { color: update ? colors.text : colors.textMuted }]}>
        {update
          ? `MasterHand ${update.version} is available${update.source === "fdroid" ? " on F-Droid" : ""}.`
          : "You are up to date, or the release manifest is unreachable."}
      </Text>
      <View style={styles.actions}>
        <Pressable
          onPress={() => void queryClient.invalidateQueries({ queryKey: queryKeys.update })}
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
    banner: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingHorizontal: 14,
      paddingVertical: 10,
      backgroundColor: colors.accentSoft,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.hairline,
    },
    bannerText: {
      flex: 1,
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 13,
      fontWeight: "600",
    },
    bannerButton: {
      minHeight: 44,
      justifyContent: "center",
      paddingHorizontal: 12,
      borderRadius: 10,
      backgroundColor: colors.accent,
    },
    bannerButtonText: {
      color: "#fff",
      fontFamily: fonts.ui,
      fontSize: 13,
      fontWeight: "600",
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
      gap: 8,
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
    actions: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
      marginTop: 12,
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
