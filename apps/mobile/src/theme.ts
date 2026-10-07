import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react"
import { Platform, useColorScheme } from "react-native"
import { loadTheme, saveTheme } from "./storage"

export type ThemeName = "light" | "dark"

/** User-facing choice: one explicit theme (new users start on the resolved system theme). */
export type ThemeMode = ThemeName

/**
 * The full ink-on-paper palette (design/DESIGN.md, mirrored from
 * design/design.css). Token names are semantic; both themes are equal citizens
 * and a theme flip is a value swap, not a redesign.
 *
 * The legacy names (`background`, `border`, `muted`, `accentMuted`) are kept as
 * aliases so consumers can migrate mechanically.
 */
export interface Palette {
  // Surfaces
  canvas: string
  surface: string
  surfaceMuted: string
  // Text
  text: string
  textSoft: string
  textMuted: string
  textFaint: string
  // Lines
  hairline: string
  hairlineStrong: string
  // The one accent (deep emerald)
  accent: string
  accentStrong: string
  accentSoft: string
  accentLine: string
  onAccent: string
  // Semantic
  success: string
  warning: string
  warningSoft: string
  warningLine: string
  danger: string
  dangerSoft: string
  dangerLine: string
  // Code — dark in both themes
  codeSurface: string
  codeSurfaceSoft: string
  codeText: string
  codeMuted: string
  // Overlay
  overlay: string
  // User bubble — deep emerald, never the brightest surface
  bubbleUser: string
  bubbleUserText: string
  // Legacy aliases
  background: string
  border: string
  muted: string
  accentMuted: string
}

type BasePalette = Omit<Palette, "background" | "border" | "muted" | "accentMuted">

function withAliases(base: BasePalette): Palette {
  return {
    ...base,
    background: base.canvas,
    border: base.hairline,
    muted: base.textMuted,
    accentMuted: base.accentStrong,
  }
}

export const palettes: Record<ThemeName, Palette> = {
  light: withAliases({
    canvas: "#FAFAF7",
    surface: "#FFFFFF",
    surfaceMuted: "#F2F2EE",
    text: "#0C0C0B",
    textSoft: "#4A4A46",
    textMuted: "#6E6E6A",
    textFaint: "#8E8E88",
    hairline: "#E8E8E2",
    hairlineStrong: "#D6D6D0",
    accent: "#0B6B53",
    accentStrong: "#085041",
    accentSoft: "#D9EAE3",
    accentLine: "rgba(11, 107, 83, 0.35)",
    onAccent: "#FFFFFF",
    success: "#0B6B53",
    warning: "#8A5A00",
    warningSoft: "rgba(138, 90, 0, 0.09)",
    warningLine: "rgba(138, 90, 0, 0.32)",
    danger: "#B3261E",
    dangerSoft: "rgba(179, 38, 30, 0.08)",
    dangerLine: "rgba(179, 38, 30, 0.32)",
    codeSurface: "#141413",
    codeSurfaceSoft: "#1C1C1A",
    codeText: "#EDEDE8",
    codeMuted: "#8E8E88",
    overlay: "rgba(12, 12, 11, 0.45)",
    bubbleUser: "#085041",
    bubbleUserText: "#FFFFFF",
  }),
  dark: withAliases({
    canvas: "#0C0C0B",
    surface: "#141413",
    surfaceMuted: "#1C1C1A",
    text: "#F2F2ED",
    textSoft: "#C9C9C2",
    textMuted: "#8E8E88",
    textFaint: "#6A6A65",
    hairline: "#262624",
    hairlineStrong: "#3A3A37",
    accent: "#3ED8A8",
    accentStrong: "#8BE9C9",
    accentSoft: "rgba(62, 216, 168, 0.14)",
    accentLine: "rgba(62, 216, 168, 0.35)",
    onAccent: "#04140E",
    success: "#3ED8A8",
    warning: "#E3B341",
    warningSoft: "rgba(227, 179, 65, 0.12)",
    warningLine: "rgba(227, 179, 65, 0.35)",
    danger: "#F08A82",
    dangerSoft: "rgba(240, 138, 130, 0.1)",
    dangerLine: "rgba(240, 138, 130, 0.35)",
    codeSurface: "#171716",
    codeSurfaceSoft: "#262624",
    codeText: "#EDEDE8",
    codeMuted: "#8E8E88",
    overlay: "rgba(0, 0, 0, 0.6)",
    bubbleUser: "#06372C",
    bubbleUserText: "#D9EAE3",
  }),
}

/** The light palette; use `useTheme()` for theme-reactive consumers. */
export const colors = palettes.light

export interface Fonts {
  display: string
  ui: string
  mono: string
}

/** Loaded Google-font families (Fraunces / Instrument Sans / JetBrains Mono). */
export const fonts: Fonts = {
  display: "Fraunces_500Medium",
  ui: "InstrumentSans_400Regular",
  mono: "JetBrainsMono_400Regular",
}

/** Sensible system fallbacks used until `useFonts` resolves (and outside a provider). */
export const systemFonts: Fonts = {
  display: Platform.select({ ios: "Georgia", android: "serif", default: "serif" })!,
  ui: Platform.select({ ios: "System", android: "sans-serif", default: "System" })!,
  mono: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" })!,
}

export interface ThemeContextValue {
  theme: ThemeName
  /** The user's choice; `theme` is the resolved result (both always explicit). */
  mode: ThemeMode
  colors: Palette
  fonts: Fonts
  setTheme: (theme: ThemeName) => void
  /** Sets the explicit theme. */
  setMode: (mode: ThemeMode) => void
  toggleTheme: () => void
}

/** Stored choice wins; otherwise the system scheme; otherwise light (web parity). */
export function resolveTheme(stored: ThemeName | null, system: string | null | undefined): ThemeName {
  if (stored) return stored
  return system === "dark" ? "dark" : "light"
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

function themeValue(
  theme: ThemeName,
  mode: ThemeMode,
  fontSet: Fonts,
  setMode: (mode: ThemeMode) => void,
): ThemeContextValue {
  return {
    theme,
    mode,
    colors: palettes[theme],
    fonts: fontSet,
    setTheme: (next) => setMode(next),
    setMode,
    toggleTheme: () => setMode(theme === "dark" ? "light" : "dark"),
  }
}

/**
 * Resolves and provides the active theme. The stored choice is read from
 * SecureStore (`masterhand.theme`, tolerant of failures); until the user makes
 * one, the theme starts on the system scheme and falls back to light.
 */
export function ThemeProvider({
  children,
  fonts: fontSet = systemFonts,
}: PropsWithChildren<{ fonts?: Fonts }>) {
  const system = useColorScheme()
  const [stored, setStored] = useState<ThemeName | null>(null)

  useEffect(() => {
    let active = true
    void loadTheme()
      .then((value) => {
        if (active && value) setStored(value)
      })
      .catch(() => {
        // A SecureStore failure must not block the app on a theme read.
      })
    return () => {
      active = false
    }
  }, [])

  const theme = resolveTheme(stored, system)
  const mode: ThemeMode = stored ?? theme
  const value = useMemo(
    () =>
      themeValue(theme, mode, fontSet, (next) => {
        setStored(next)
        void saveTheme(next).catch(() => {})
      }),
    [theme, mode, fontSet],
  )

  return createElement(ThemeContext.Provider, { value }, children)
}

/** The active theme; outside a provider it starts on the system scheme (light fallback). */
export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext)
  const system = useColorScheme()
  const fallback = useMemo(() => {
    const resolved = resolveTheme(null, system)
    return themeValue(resolved, resolved, systemFonts, () => {})
  }, [system])
  return context ?? fallback
}

/**
 * Theme-aware `StyleSheet.create`: declare the factory once at module level and
 * it is re-evaluated (memoized) only when the palette or the fonts change.
 */
export function useThemedStyles<T>(factory: (colors: Palette, fonts: Fonts) => T): T {
  const { colors: palette, fonts: fontSet } = useTheme()
  return useMemo(() => factory(palette, fontSet), [factory, palette, fontSet])
}
