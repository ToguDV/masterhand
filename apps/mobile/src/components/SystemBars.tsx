import { useEffect } from "react"
import { StatusBar } from "react-native"
import { NavigationBar } from "expo-navigation-bar"
import { useTheme, type ThemeName } from "../theme"

/**
 * Syncs the Android system navigation bar with the app theme (issue #118).
 *
 * `ThemedStatusBar` only drove the status bar, so the bottom gesture/button
 * strip stayed white in dark theme. SDK 57 removed `setBackgroundColorAsync`:
 * edge-to-edge is forced, the bar is transparent and the themed canvas behind
 * it (see `Screen`, `backgroundColor: colors.canvas`) is what shows — this
 * only sets the button contrast (`dark` bar = light buttons). Best-effort:
 * never throws when the native module is missing (iOS, tests).
 */
export function syncSystemBars(theme: ThemeName): void {
  try {
    NavigationBar.setStyle(theme === "dark" ? "dark" : "light")
  } catch {
    // The native module may be unavailable (iOS, web, tests): the app theme
    // itself is unaffected, so swallow the failure silently.
  }
}

/** Status bar + Android navigation bar, kept in sync on every theme change. */
export function ThemedSystemBars() {
  const { theme } = useTheme()

  useEffect(() => {
    syncSystemBars(theme)
  }, [theme])

  return <StatusBar barStyle={theme === "dark" ? "light-content" : "dark-content"} />
}
