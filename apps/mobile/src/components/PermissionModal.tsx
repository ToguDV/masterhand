import { Modal, Pressable, StyleSheet, Text, View } from "react-native"
import type { Permission } from "@masterhand/client-core"
import { useThemedStyles, type Fonts, type Palette } from "../theme"

export function PermissionModal({
  permission,
  busy,
  onRespond,
}: {
  permission: Permission
  busy: boolean
  onRespond: (response: "once" | "always" | "reject") => void
}) {
  const styles = useThemedStyles(createStyles)
  const resources = permission.resources.join(", ")

  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => {}}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <Text style={styles.heading}>Permission required</Text>
          <Text style={styles.title}>{permission.action}</Text>
          {resources ? <Text style={styles.meta}>{resources}</Text> : null}

          <View style={styles.actions}>
            <Pressable
              style={[styles.button, styles.reject]}
              disabled={busy}
              onPress={() => onRespond("reject")}
            >
              <Text style={[styles.buttonText, styles.rejectText]}>Reject</Text>
            </Pressable>
            <Pressable
              style={[styles.button, styles.always]}
              disabled={busy}
              onPress={() => onRespond("always")}
            >
              <Text style={styles.buttonText}>Always</Text>
            </Pressable>
            <Pressable
              style={[styles.button, styles.once, busy && styles.disabled]}
              disabled={busy}
              onPress={() => onRespond("once")}
            >
              <Text style={[styles.buttonText, styles.onceText]}>Once</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  )
}

function createStyles(colors: Palette, fonts: Fonts) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      justifyContent: "center",
      padding: 16,
      backgroundColor: colors.overlay,
    },
    sheet: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.warningLine,
      backgroundColor: colors.surface,
      borderRadius: 16,
      padding: 16,
    },
    heading: {
      color: colors.warning,
      fontFamily: fonts.ui,
      fontSize: 11,
      fontWeight: "600",
      letterSpacing: 0.8,
      textTransform: "uppercase",
    },
    title: {
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 16,
      fontWeight: "600",
      marginTop: 4,
    },
    meta: {
      color: colors.textMuted,
      fontFamily: fonts.mono,
      fontSize: 12,
      marginTop: 4,
    },
    actions: {
      flexDirection: "row",
      gap: 8,
      marginTop: 16,
    },
    button: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      minHeight: 44,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: "transparent",
    },
    reject: {
      backgroundColor: colors.dangerSoft,
      borderColor: colors.dangerLine,
    },
    always: {
      backgroundColor: colors.surface,
      borderColor: colors.hairlineStrong,
    },
    once: {
      backgroundColor: colors.accent,
    },
    disabled: {
      opacity: 0.5,
    },
    buttonText: {
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 14,
      fontWeight: "500",
    },
    rejectText: {
      color: colors.danger,
    },
    onceText: {
      color: colors.onAccent,
    },
  })
}
