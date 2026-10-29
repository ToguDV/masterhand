import { useState } from "react"
import { Modal, Pressable, StyleSheet, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { CloseIcon, GearIcon, PlusIcon } from "./icons"
import { ServerMonogram, ServerStatus } from "./ServerStatus"
import { useTheme, useThemedStyles, type Fonts, type Palette } from "../theme"
import type { StoredServerProfile } from "../storage"

/**
 * Sessions-header server chip + bottom-sheet switcher (native). One server is
 * connected at a time; picking another remounts the authenticated tree.
 */
export function ServerSwitcher({
  profiles,
  activeProfile,
  onSwitch,
  onManage,
  onAdd,
}: {
  profiles: StoredServerProfile[]
  activeProfile: StoredServerProfile
  onSwitch: (profile: StoredServerProfile) => void
  onManage: () => void
  onAdd: () => void
}) {
  const [open, setOpen] = useState(false)
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()

  return (
    <>
      <Pressable
        testID="server-switcher-trigger"
        onPress={() => setOpen(true)}
        hitSlop={4}
        accessibilityRole="button"
        accessibilityLabel={`Server: ${activeProfile.label}`}
        style={styles.trigger}
      >
        <ServerMonogram label={activeProfile.label} size={30} />
        <ServerStatus status="connected" showLabel={false} />
      </Pressable>

      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.scrim} onPress={() => setOpen(false)} accessibilityLabel="Close servers">
          <Pressable
            style={[styles.sheet, { paddingBottom: Math.max(18, insets.bottom + 12) }]}
            onPress={(event) => event.stopPropagation()}
            accessibilityRole="menu"
            accessibilityLabel="Servers"
          >
            <View style={styles.grab} />
            <View style={styles.head}>
              <View style={styles.headText}>
                <Text style={styles.title}>Servers</Text>
                <Text style={styles.sub}>One connection at a time.</Text>
              </View>
              <Pressable
                onPress={() => setOpen(false)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Close servers"
                style={styles.close}
              >
                <CloseIcon size={18} color={colors.textMuted} />
              </Pressable>
            </View>

            {profiles.map((profile) => {
              const active = profile.id === activeProfile.id
              return (
                <Pressable
                  key={profile.id}
                  testID={`switcher-server-${profile.id}`}
                  disabled={active}
                  onPress={() => {
                    setOpen(false)
                    onSwitch(profile)
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`${profile.label}, ${active ? "Connected" : profile.expired ? "Expired" : "Saved"}`}
                  style={[styles.row, active && styles.rowActive]}
                >
                  <ServerMonogram label={profile.label} active={active} size={32} />
                  <View style={styles.rowBody}>
                    <Text style={styles.rowName} numberOfLines={1}>
                      {profile.label}
                    </Text>
                    <Text style={styles.rowHost} numberOfLines={1}>
                      {hostOf(profile.url)}
                    </Text>
                  </View>
                  <ServerStatus status={active ? "connected" : profile.expired ? "expired" : "saved"} />
                </Pressable>
              )
            })}

            <Pressable
              testID="switcher-add-server"
              onPress={() => {
                setOpen(false)
                onAdd()
              }}
              accessibilityRole="button"
              accessibilityLabel="Add another server"
              style={styles.addRow}
            >
              <View style={styles.plusTile}>
                <PlusIcon size={14} color={colors.textMuted} />
              </View>
              <Text style={styles.addText}>Add another server</Text>
            </Pressable>

            <Pressable
              onPress={() => {
                setOpen(false)
                onManage()
              }}
              accessibilityRole="button"
              accessibilityLabel="Manage servers"
              style={styles.manageRow}
            >
              <GearIcon size={16} color={colors.textMuted} />
              <Text style={styles.manageText}>Manage servers</Text>
            </Pressable>
            <Text style={styles.note}>Only the active server sends live updates.</Text>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  )
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function createStyles(colors: Palette, fonts: Fonts) {
  return StyleSheet.create({
    trigger: {
      minWidth: 44,
      minHeight: 44,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 4,
      paddingHorizontal: 4,
      borderRadius: 8,
    },
    scrim: {
      flex: 1,
      justifyContent: "flex-end",
      backgroundColor: colors.overlay,
    },
    sheet: {
      gap: 4,
      paddingHorizontal: 16,
      paddingTop: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.hairline,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      backgroundColor: colors.surface,
    },
    grab: {
      alignSelf: "center",
      width: 36,
      height: 4,
      borderRadius: 2,
      marginBottom: 8,
      backgroundColor: colors.hairlineStrong,
    },
    head: {
      flexDirection: "row",
      alignItems: "flex-start",
      justifyContent: "space-between",
      gap: 8,
      marginBottom: 4,
    },
    headText: {
      flex: 1,
      gap: 2,
    },
    title: {
      color: colors.text,
      fontFamily: fonts.display,
      fontSize: 24,
      fontWeight: "500",
    },
    sub: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 13,
    },
    close: {
      width: 44,
      height: 44,
      alignItems: "center",
      justifyContent: "center",
    },
    row: {
      minHeight: 56,
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderWidth: 1,
      borderColor: "transparent",
      borderRadius: 12,
    },
    rowActive: {
      borderColor: colors.hairline,
      backgroundColor: colors.surfaceMuted,
    },
    rowBody: {
      flex: 1,
      minWidth: 0,
      gap: 1,
    },
    rowName: {
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 14,
      fontWeight: "600",
    },
    rowHost: {
      color: colors.textFaint,
      fontFamily: fonts.mono,
      fontSize: 10,
    },
    addRow: {
      minHeight: 48,
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingHorizontal: 10,
      borderWidth: 1,
      borderStyle: "dashed",
      borderColor: colors.hairlineStrong,
      borderRadius: 12,
      marginTop: 4,
    },
    addText: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 13,
    },
    plusTile: {
      width: 24,
      height: 24,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: colors.hairlineStrong,
      borderRadius: 7,
    },
    manageRow: {
      minHeight: 44,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 10,
      borderRadius: 8,
    },
    manageText: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 13,
    },
    note: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 11,
      lineHeight: 16,
      paddingHorizontal: 4,
    },
  })
}
