import { Pressable, StyleSheet, Text } from "react-native"
import { useTheme, useThemedStyles, type Palette } from "../theme"

/**
 * Light/dark switch with web parity: a compact sun/moon glyph that flips the
 * theme and persists the choice (`masterhand.theme`). Until the user makes a
 * choice the theme follows the system.
 */
export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme()
  const styles = useThemedStyles(createStyles)
  const label = theme === "dark" ? "Switch to light theme" : "Switch to dark theme"

  return (
    <Pressable
      onPress={toggleTheme}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID="theme-toggle"
      hitSlop={4}
      style={styles.button}
    >
      <Text style={styles.glyph}>{theme === "dark" ? "☀" : "☾"}</Text>
    </Pressable>
  )
}

function createStyles(colors: Palette) {
  return StyleSheet.create({
    button: {
      width: 36,
      height: 36,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairlineStrong,
      borderRadius: 8,
      backgroundColor: colors.surface,
    },
    glyph: {
      color: colors.textMuted,
      fontSize: 16,
      lineHeight: 18,
    },
  })
}
