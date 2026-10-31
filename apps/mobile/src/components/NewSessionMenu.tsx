import { ActivityIndicator, Pressable, StyleSheet } from "react-native"
import { useTheme, useThemedStyles, type Palette } from "../theme"
import { PlusIcon } from "./icons"

/**
 * The Sessions header's new-session action (web parity, issue #92): creates a
 * session immediately in the active workspace.
 */
export function NewSessionMenu({
  creating,
  disabled,
  onCreate,
}: {
  creating: boolean
  disabled: boolean
  onCreate: () => void
}) {
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()

  return (
    <Pressable
      style={[styles.trigger, (disabled || creating) && styles.disabled]}
      testID="new-session-button"
      accessibilityRole="button"
      accessibilityLabel="New session"
      disabled={disabled || creating}
      onPress={onCreate}
    >
      {creating ? (
        <ActivityIndicator size="small" color={colors.onAccent} />
      ) : (
        <PlusIcon size={18} color={colors.onAccent} />
      )}
    </Pressable>
  )
}

function createStyles(colors: Palette) {
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
  })
}
