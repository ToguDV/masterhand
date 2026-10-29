import { useState } from "react"
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native"
import { ServerMonogram, ServerStatus } from "./ServerStatus"
import { LogOutIcon, PencilIcon, TrashIcon } from "./icons"
import { useTheme, useThemedStyles, type Fonts, type Palette } from "../theme"
import type { StoredServerProfile } from "../storage"

/** Settings > Servers: rename, disconnect and remove saved profiles. */
export function ServersSection({
  profiles,
  activeID,
  onRename,
  onDisconnect,
  onRemove,
  onAdd,
}: {
  profiles: StoredServerProfile[]
  activeID: string | null
  onRename: (profile: StoredServerProfile, label: string) => void
  onDisconnect: (profile: StoredServerProfile) => void
  onRemove: (profile: StoredServerProfile) => void
  onAdd: () => void
}) {
  const [renamingID, setRenamingID] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState("")
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()

  function confirmRemove(profile: StoredServerProfile): void {
    Alert.alert(
      "Remove server",
      `Remove ${profile.label} from this device? Sessions keep running on that server; you can add it again later.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Remove", style: "destructive", onPress: () => onRemove(profile) },
      ],
    )
  }

  function confirmDisconnect(profile: StoredServerProfile): void {
    Alert.alert(
      "Disconnect",
      `Clear this device's session for ${profile.label}? The profile stays saved.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Disconnect", style: "destructive", onPress: () => onDisconnect(profile) },
      ],
    )
  }

  return (
    <View>
      <View style={styles.head}>
        <View style={styles.headText}>
          <Text style={styles.title}>Servers</Text>
          <Text style={styles.desc}>Each profile keeps its own URL and credential. One is connected at a time.</Text>
        </View>
        <Pressable
          onPress={onAdd}
          accessibilityRole="button"
          accessibilityLabel="Add server"
          style={styles.addButton}
        >
          <Text style={styles.addButtonText}>Add server</Text>
        </Pressable>
      </View>

      <View style={styles.list}>
        {profiles.map((profile) => {
          const active = profile.id === activeID
          return (
            <View key={profile.id} style={[styles.row, active && styles.rowActive]}>
              <ServerMonogram label={profile.label} active={active} />
              <View style={styles.rowBody}>
                {renamingID === profile.id ? (
                  <View style={styles.renameRow}>
                    <TextInput
                      style={styles.renameInput}
                      value={renameValue}
                      onChangeText={setRenameValue}
                      maxLength={64}
                      autoFocus
                      accessibilityLabel={`Name for ${profile.label}`}
                    />
                    <Pressable
                      onPress={() => {
                        const next = renameValue.trim()
                        if (next) onRename(profile, next)
                        setRenamingID(null)
                      }}
                      accessibilityRole="button"
                      accessibilityLabel="Save name"
                      style={styles.smallAction}
                    >
                      <Text style={styles.saveText}>Save</Text>
                    </Pressable>
                  </View>
                ) : (
                  <>
                    <Text style={styles.rowName} numberOfLines={1}>
                      {profile.label}
                    </Text>
                    <Text style={styles.rowHost} numberOfLines={1}>
                      {hostOf(profile.url)}
                    </Text>
                  </>
                )}
              </View>
              {renamingID === profile.id ? null : (
                <>
                  <ServerStatus status={active ? "connected" : profile.expired ? "expired" : "saved"} />
                  <View style={styles.actions}>
                    <Pressable
                      onPress={() => {
                        setRenamingID(profile.id)
                        setRenameValue(profile.label)
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={`Rename ${profile.label}`}
                      style={styles.action}
                    >
                      <PencilIcon size={17} color={colors.textMuted} />
                    </Pressable>
                    <Pressable
                      onPress={() => confirmDisconnect(profile)}
                      accessibilityRole="button"
                      accessibilityLabel={`Disconnect ${profile.label}`}
                      style={styles.action}
                    >
                      <LogOutIcon size={17} color={colors.textMuted} />
                    </Pressable>
                    <Pressable
                      onPress={() => confirmRemove(profile)}
                      accessibilityRole="button"
                      accessibilityLabel={`Remove ${profile.label}`}
                      style={styles.action}
                    >
                      <TrashIcon size={17} color={colors.textMuted} />
                    </Pressable>
                  </View>
                </>
              )}
            </View>
          )
        })}
      </View>

      <Text style={styles.note}>
        Disconnect clears this device&apos;s session but keeps the profile. Remove forgets the profile and revokes
        its device token when the server is reachable.
      </Text>
    </View>
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
    head: {
      flexDirection: "row",
      alignItems: "flex-start",
      justifyContent: "space-between",
      gap: 8,
      marginBottom: 12,
    },
    headText: {
      flex: 1,
      gap: 4,
    },
    title: {
      color: colors.text,
      fontFamily: fonts.display,
      fontSize: 22,
      fontWeight: "500",
    },
    desc: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 13,
      lineHeight: 18,
    },
    addButton: {
      minHeight: 44,
      justifyContent: "center",
      paddingHorizontal: 10,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairlineStrong,
      borderRadius: 10,
    },
    addButtonText: {
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 13,
      fontWeight: "500",
    },
    list: {
      gap: 2,
    },
    row: {
      minHeight: 62,
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingHorizontal: 8,
      paddingVertical: 8,
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
    actions: {
      flexDirection: "row",
      alignItems: "center",
    },
    action: {
      width: 40,
      height: 44,
      alignItems: "center",
      justifyContent: "center",
    },
    renameRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    renameInput: {
      flex: 1,
      minHeight: 40,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairlineStrong,
      borderRadius: 8,
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 14,
      paddingHorizontal: 8,
    },
    smallAction: {
      minHeight: 40,
      justifyContent: "center",
      paddingHorizontal: 6,
    },
    saveText: {
      color: colors.accent,
      fontFamily: fonts.ui,
      fontSize: 13,
      fontWeight: "600",
    },
    note: {
      marginTop: 14,
      paddingTop: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.hairline,
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 12,
      lineHeight: 17,
    },
  })
}
