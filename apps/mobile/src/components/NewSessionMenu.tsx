import { useState } from "react"
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from "react-native"
import { useTheme, useThemedStyles, type Fonts, type Palette } from "../theme"
import { CheckIcon, PlusIcon } from "./icons"

/**
 * The Sessions header's new-session action (web parity, issue #92): a `+`
 * icon that opens a compact popover with the isolated-worktree option and the
 * create action. The inline toggle that used to live in the filter row is gone.
 */
export function NewSessionMenu({
  creating,
  disabled,
  onCreate,
}: {
  creating: boolean
  disabled: boolean
  onCreate: (isolated: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const [isolated, setIsolated] = useState(false)
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()

  function close(): void {
    setOpen(false)
    setIsolated(false)
  }

  return (
    <>
      <Pressable
        style={[styles.trigger, (disabled || creating) && styles.disabled]}
        testID="new-session-button"
        accessibilityRole="button"
        accessibilityLabel="New session"
        disabled={disabled || creating}
        onPress={() => setOpen(true)}
      >
        {creating ? (
          <ActivityIndicator size="small" color={colors.onAccent} />
        ) : (
          <PlusIcon size={18} color={colors.onAccent} />
        )}
      </Pressable>

      <Modal transparent visible={open} animationType="fade" onRequestClose={close}>
        <Pressable style={styles.scrim} onPress={close} accessibilityLabel="Close new session menu">
          <View style={styles.card}>
            <Pressable
              style={styles.option}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: isolated }}
              accessibilityLabel="Isolated session"
              onPress={() => setIsolated((value) => !value)}
            >
              <View style={[styles.checkbox, isolated && styles.checkboxChecked]}>
                {isolated ? <CheckIcon size={12} color={colors.onAccent} /> : null}
              </View>
              <View style={styles.optionText}>
                <Text style={styles.optionTitle}>Isolated session</Text>
                <Text style={styles.optionHint}>Runs in its own git worktree and branch</Text>
              </View>
            </Pressable>
            <Pressable
              style={styles.create}
              accessibilityRole="button"
              onPress={() => {
                onCreate(isolated)
                close()
              }}
            >
              <Text style={styles.createText}>Create session</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>
    </>
  )
}

function createStyles(colors: Palette, fonts: Fonts) {
  return StyleSheet.create({
    trigger: {
      width: 34,
      height: 34,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.accent,
      borderRadius: 10,
    },
    disabled: {
      opacity: 0.5,
    },
    scrim: {
      flex: 1,
      alignItems: "flex-end",
      backgroundColor: colors.overlay,
      paddingTop: 56,
      paddingRight: 12,
    },
    card: {
      width: 250,
      gap: 10,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      borderRadius: 16,
      backgroundColor: colors.surface,
      padding: 12,
    },
    option: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 10,
      paddingHorizontal: 4,
      paddingVertical: 4,
    },
    checkbox: {
      width: 18,
      height: 18,
      alignItems: "center",
      justifyContent: "center",
      marginTop: 1,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairlineStrong,
      borderRadius: 5,
    },
    checkboxChecked: {
      backgroundColor: colors.accent,
      borderColor: colors.accent,
    },
    optionText: {
      flex: 1,
      gap: 2,
    },
    optionTitle: {
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 14,
    },
    optionHint: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 12,
    },
    create: {
      alignItems: "center",
      backgroundColor: colors.accent,
      borderRadius: 10,
      paddingVertical: 10,
    },
    createText: {
      color: colors.onAccent,
      fontFamily: fonts.ui,
      fontSize: 14,
      fontWeight: "600",
    },
  })
}
