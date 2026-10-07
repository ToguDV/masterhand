import { useCallback, useEffect, useState } from "react"
import { DEFAULT_PALETTE, PALETTES, resolvePalette, type PaletteID } from "@masterhand/client-core"

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
 *
 * The accent palette (color themes) is an independent axis stored under
 * `mh-palette` and painted through `data-palette` (absent or `paper` =
 * the default ink-on-paper theme; unknown values fall back to paper).
 */

export type ThemeMode = "light" | "dark"
export type ResolvedTheme = "light" | "dark"
export type { PaletteID }

const THEME_STORAGE_KEY = "mh-theme"
const PALETTE_STORAGE_KEY = "mh-palette"

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
  syncThemeColorMeta()
}

/** Keeps the browser chrome (`theme-color`) on the active theme canvas. */
function syncThemeColorMeta(): void {
  const theme = currentTheme()
  const palette = storedPalette()
  const canvas = PALETTES[palette][theme].canvas
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.content = canvas
  }
}

/** Stored palette id; anything unknown (or unreadable) falls back to paper. */
export function storedPalette(): PaletteID {
  try {
    return resolvePalette(window.localStorage.getItem(PALETTE_STORAGE_KEY))
  } catch {
    return DEFAULT_PALETTE
  }
}

/** Applies the palette to the document (the CSS falls back when unset). */
export function applyPalette(palette: PaletteID): void {
  document.documentElement.setAttribute("data-palette", palette)
  syncThemeColorMeta()
}

export interface ThemeModeState {
  mode: ThemeMode
  theme: ResolvedTheme
  palette: PaletteID
  setMode: (mode: ThemeMode) => void
  setPalette: (palette: PaletteID) => void
}

/**
 * Mode + resolved theme + accent palette for the app shell. Mounted once in
 * `App` so the initial paint stays in sync even while the settings panel is
 * closed. The choice is always explicit (no system-following mode): it is
 * read once from storage (defaulting to the OS scheme for the mode and to
 * paper for the palette) and only changes on selection.
 */
export function useThemeMode(): ThemeModeState {
  const [mode, setModeState] = useState<ThemeMode>(storedThemeMode)
  const [theme, setTheme] = useState<ResolvedTheme>(currentTheme)
  const [palette, setPaletteState] = useState<PaletteID>(storedPalette)

  // Sync the metas with the resolved theme (and fix a missing data-theme).
  useEffect(() => {
    applyTheme(currentTheme())
    applyPalette(storedPalette())
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

  const setPalette = useCallback((next: PaletteID) => {
    const resolved = resolvePalette(next)
    setPaletteState(resolved)
    applyPalette(resolved)
    try {
      window.localStorage.setItem(PALETTE_STORAGE_KEY, resolved)
    } catch {
      // storage may be unavailable (private mode)
    }
  }, [])

  return { mode, theme, palette, setMode, setPalette }
}
