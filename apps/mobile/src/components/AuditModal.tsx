import { useState } from "react"
import { ActivityIndicator, FlatList, Modal, Pressable, StyleSheet, Text, View } from "react-native"
import { useQueryClient } from "@tanstack/react-query"
import { formatRelative, queryKeys, useAudit, type Client } from "@masterhand/client-core"
import { useTheme, useThemedStyles, type Fonts, type Palette } from "../theme"

/**
 * Visible log of blocked actions: commands denied by the session permission
 * guard, with the reason opencode returned.
 */
export function AuditModal({ client, onClose }: { client: Client; onClose: () => void }) {
  const queryClient = useQueryClient()
  const auditQuery = useAudit(client)
  const [busy, setBusy] = useState(false)
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()
  const events = auditQuery.data ?? []

  async function clear() {
    setBusy(true)
    try {
      await client.api.clearAudit()
      queryClient.setQueryData(queryKeys.audit, [])
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.heading}>Denied commands</Text>
          <View style={styles.spacer} />
          {busy ? (
            <ActivityIndicator color={colors.accent} />
          ) : events.length > 0 ? (
            <Pressable style={styles.button} onPress={() => void clear()}>
              <Text style={styles.buttonText}>Clear</Text>
            </Pressable>
          ) : null}
          <Pressable style={styles.button} onPress={onClose}>
            <Text style={styles.buttonText}>Close</Text>
          </Pressable>
        </View>

        <FlatList
          data={events}
          keyExtractor={(event) => String(event.id)}
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            <Text style={styles.empty}>
              Nothing blocked yet. Dangerous process commands an agent tries to run show up here.
            </Text>
          }
          renderItem={({ item }) => (
            <View style={styles.card}>
              <View style={styles.meta}>
                <Text style={styles.badge}>
                  {item.kind === "permission_denied" ? "permission denied" : "run rejected"}
                </Text>
                <Text style={styles.muted}>{formatRelative(item.at)}</Text>
              </View>
              {item.command ? <Text style={styles.command}>{item.command}</Text> : null}
              {item.reason ? <Text style={styles.reason}>{item.reason}</Text> : null}
            </View>
          )}
        />
      </View>
    </Modal>
  )
}

function createStyles(colors: Palette, fonts: Fonts) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.canvas },
    header: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.hairline,
    },
    heading: {
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 15,
      fontWeight: "600",
    },
    spacer: { flex: 1 },
    button: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairlineStrong,
      backgroundColor: colors.surface,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 6,
    },
    buttonText: {
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 12,
      fontWeight: "500",
    },
    list: { padding: 12, gap: 8 },
    empty: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 14,
      textAlign: "center",
      paddingVertical: 40,
    },
    card: {
      gap: 4,
      borderRadius: 16,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      backgroundColor: colors.surface,
      padding: 12,
    },
    meta: { flexDirection: "row", alignItems: "center", gap: 8 },
    badge: {
      color: colors.warning,
      backgroundColor: colors.warningSoft,
      borderRadius: 999,
      paddingHorizontal: 8,
      paddingVertical: 2,
      fontFamily: fonts.ui,
      fontSize: 10,
      fontWeight: "600",
    },
    muted: { color: colors.textMuted, fontFamily: fonts.ui, fontSize: 11 },
    command: { color: colors.text, fontFamily: fonts.mono, fontSize: 12 },
    reason: { color: colors.textMuted, fontFamily: fonts.ui, fontSize: 12 },
  })
}
