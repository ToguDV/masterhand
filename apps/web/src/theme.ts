import { useCallback, useEffect, useState } from "react"

/**
 * Theme resolution shared by the app shell and the settings panel.
 *
 * Two explicit user-facing modes map to the resolved theme:
 * - `light` / `dark`: stored under `mh-theme`; new users start on the
 *   resolved system theme until they pick one.
 *
 * `data-theme` on `<html>` always carries the *resolved* theme (index.html
 * resolves it before first paint) because the CSS tokens use `light-dark()`
 * and only flip with `color-scheme`.
 */

export type ThemeMode = "light" | "dark"
export type ResolvedTheme = "light" | "dark"

const THEME_STORAGE_KEY = "mh-theme"
const THEME_COLORS: Record<ResolvedTheme, string> = { light: "#fafaf7", dark: "#0c0c0b" }

/** Stored mode; anything unknown (or unreadable) starts on the resolved system theme. */
export function storedThemeMode(): ThemeMode {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (value === "light" || value === "dark") return value
  } catch {
    // storage may be unavailable (private mode)
  }
  return systemTheme()
}

export function systemTheme(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  return mode
}

/** The theme currently painted; falls back to the system when `data-theme` is missing. */
export function currentTheme(): ResolvedTheme {
  const attribute = document.documentElement.getAttribute("data-theme")
  if (attribute === "dark" || attribute === "light") return attribute
  // No pre-paint resolution (file:// or private mode): fall back to the system.
  return systemTheme()
}

/** Applies the theme to the document and keeps the browser chrome in sync. */
export function applyTheme(theme: ResolvedTheme): void {
  document.documentElement.setAttribute("data-theme", theme)
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.content = THEME_COLORS[theme]
  }
}

export interface ThemeModeState {
  mode: ThemeMode
  theme: ResolvedTheme
  setMode: (mode: ThemeMode) => void
}

/**
 * Mode + resolved theme for the app shell. Mounted once in `App` so the
 * initial paint stays in sync even while the settings panel is closed.
 * The choice is always explicit (no system-following mode): it is read once
 * from storage (defaulting to the OS scheme) and only changes on selection.
 */
export function useThemeMode(): ThemeModeState {
  const [mode, setModeState] = useState<ThemeMode>(storedThemeMode)
  const [theme, setTheme] = useState<ResolvedTheme>(currentTheme)

  // Sync the metas with the resolved theme (and fix a missing data-theme).
  useEffect(() => {
    applyTheme(currentTheme())
  }, [])

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next)
    const resolved = resolveTheme(next)
    applyTheme(resolved)
    setTheme(resolved)
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next)
    } catch {
      // storage may be unavailable (private mode)
    }
  }, [])

  return { mode, theme, setMode }
}
