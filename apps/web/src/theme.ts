import { useCallback, useEffect, useState } from "react"

/**
 * Theme resolution shared by the app shell and the settings panel.
 *
 * Three user-facing modes map to one resolved theme:
 * - `system` (default): no stored key; follow `prefers-color-scheme` live.
 * - `light` / `dark`: stored under `mh-theme`; win over the system.
 *
 * `data-theme` on `<html>` always carries the *resolved* theme (index.html
 * resolves it before first paint) because the CSS tokens use `light-dark()`
 * and only flip with `color-scheme`.
 */

export type ThemeMode = "system" | "light" | "dark"
export type ResolvedTheme = "light" | "dark"

const THEME_STORAGE_KEY = "mh-theme"
const THEME_COLORS: Record<ResolvedTheme, string> = { light: "#fafaf7", dark: "#0c0c0b" }

/** Stored mode; anything unknown (or unreadable) falls back to the system. */
export function storedThemeMode(): ThemeMode {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY)
    return value === "light" || value === "dark" ? value : "system"
  } catch {
    return "system"
  }
}

export function systemTheme(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  return mode === "system" ? systemTheme() : mode
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
 * system listener stays active even while the settings panel is closed.
 */
export function useThemeMode(): ThemeModeState {
  const [mode, setModeState] = useState<ThemeMode>(storedThemeMode)
  const [theme, setTheme] = useState<ResolvedTheme>(currentTheme)

  // Sync the metas with the resolved theme (and fix a missing data-theme).
  useEffect(() => {
    applyTheme(currentTheme())
    const media = window.matchMedia("(prefers-color-scheme: dark)")
    function onSystemChange(event: MediaQueryListEvent): void {
      // A stored light/dark wins; only the system mode follows the OS.
      if (storedThemeMode() !== "system") return
      const next = event.matches ? "dark" : "light"
      applyTheme(next)
      setTheme(next)
    }
    media.addEventListener("change", onSystemChange)
    return () => media.removeEventListener("change", onSystemChange)
  }, [])

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next)
    const resolved = resolveTheme(next)
    applyTheme(resolved)
    setTheme(resolved)
    try {
      // `system` clears the stored choice so the OS decides again.
      if (next === "system") window.localStorage.removeItem(THEME_STORAGE_KEY)
      else window.localStorage.setItem(THEME_STORAGE_KEY, next)
    } catch {
      // storage may be unavailable (private mode)
    }
  }, [])

  return { mode, theme, setMode }
}
