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
import {
  DEFAULT_PALETTE,
  PALETTES,
  resolvePalette,
  type PaletteID,
} from "@masterhand/client-core"
import { loadPalette, loadTheme, savePalette, saveTheme } from "./storage"

export type ThemeName = "light" | "dark"

/** User-facing choice: one explicit theme (new users start on the resolved system theme). */
export type ThemeMode = ThemeName

export type { PaletteID }

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
  // Syntax tokens (#123): one tuned palette for the dark code surface.
  // `function` follows the palette's dark accent (readable on dark code).
  syntax: SyntaxPalette
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

/** Token colors for highlighted code; shared with the web `--mh-syn-*` vars. */
export interface SyntaxPalette {
  keyword: string
  string: string
  number: string
  comment: string
  function: string
  type: string
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
    syntax: {
      keyword: "#C792EA",
      string: "#9ECE8A",
      number: "#E3B341",
      comment: "#7A7A76",
      function: "#3ED8A8",
      type: "#7DD3FC",
    },
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
    syntax: {
      keyword: "#C792EA",
      string: "#9ECE8A",
      number: "#E3B341",
      comment: "#7A7A76",
      function: "#3ED8A8",
      type: "#7DD3FC",
    },
    overlay: "rgba(0, 0, 0, 0.6)",
    bubbleUser: "#06372C",
    bubbleUserText: "#D9EAE3",
  }),
}

/** The light palette; use `useTheme()` for theme-reactive consumers. */
export const colors = palettes.light

/**
 * Full palette for a color theme + mode: the paper base with every theme
 * token applied (canvas/surface/text/hairlines plus the accent family,
 * code surfaces and syntax hues). Unknown ids fall back to paper.
 */
export function paletteFor(id: string, theme: ThemeName): Palette {
  const resolved = resolvePalette(id)
  if (resolved === DEFAULT_PALETTE) return palettes[theme]
  const accents = PALETTES[resolved][theme]
  return {
    ...palettes[theme],
    canvas: accents.canvas,
    surface: accents.surface,
    surfaceMuted: accents.surfaceMuted,
    text: accents.text,
    textSoft: accents.textSoft,
    textMuted: accents.textMuted,
    textFaint: accents.textFaint,
    hairline: accents.hairline,
    hairlineStrong: accents.hairlineStrong,
    accent: accents.accent,
    accentStrong: accents.accentStrong,
    accentSoft: accents.accentSoft,
    accentLine: accents.accentLine,
    onAccent: accents.onAccent,
    bubbleUser: accents.bubbleUser,
    bubbleUserText: accents.bubbleUserText,
    codeSurface: accents.codeSurface,
    codeSurfaceSoft: accents.codeSurfaceSoft,
    syntax: {
      ...palettes[theme].syntax,
      keyword: accents.synKeyword,
      string: accents.synString,
      number: accents.synNumber,
      comment: accents.synComment,
      function: PALETTES[resolved].dark.accent,
      type: accents.synType,
    },
    background: accents.canvas,
    border: accents.hairline,
    muted: accents.textMuted,
    accentMuted: accents.accentStrong,
  }
}

/** Ordered theme ids for the settings picker (paper first). */
export { PALETTE_IDS } from "@masterhand/client-core"

export { DEFAULT_PALETTE, PALETTES }

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
  /** The color theme; `colors` is resolved from it (paper default). */
  palette: PaletteID
  setTheme: (theme: ThemeName) => void
  /** Sets the explicit theme. */
  setMode: (mode: ThemeMode) => void
  /** Sets the color theme (persisted; unknown values fall back). */
  setPalette: (palette: PaletteID) => void
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
  palette: PaletteID,
  fontSet: Fonts,
  setMode: (mode: ThemeMode) => void,
  setPalette: (palette: PaletteID) => void,
): ThemeContextValue {
  return {
    theme,
    mode,
    palette,
    colors: paletteFor(palette, theme),
    fonts: fontSet,
    setTheme: (next) => setMode(next),
    setMode,
    setPalette,
    toggleTheme: () => setMode(theme === "dark" ? "light" : "dark"),
  }
}

/**
 * Resolves and provides the active theme. The stored choice is read from
 * SecureStore (`masterhand.theme`, tolerant of failures); until the user makes
 * one, the theme starts on the system scheme and falls back to light. The
 * color theme (`masterhand.palette`) resolves independently the same way.
 */
export function ThemeProvider({
  children,
  fonts: fontSet = systemFonts,
}: PropsWithChildren<{ fonts?: Fonts }>) {
  const system = useColorScheme()
  const [stored, setStored] = useState<ThemeName | null>(null)
  const [storedPalette, setStoredPalette] = useState<PaletteID>(DEFAULT_PALETTE)

  useEffect(() => {
    let active = true
    void loadTheme()
      .then((value) => {
        if (active && value) setStored(value)
      })
      .catch(() => {
        // A SecureStore failure must not block the app on a theme read.
      })
    void loadPalette()
      .then((value) => {
        if (active && value) setStoredPalette(resolvePalette(value))
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [])

  const theme = resolveTheme(stored, system)
  const mode: ThemeMode = stored ?? theme
  const value = useMemo(
    () =>
      themeValue(
        theme,
        mode,
        storedPalette,
        fontSet,
        (next) => {
          setStored(next)
          void saveTheme(next).catch(() => {})
        },
        (next) => {
          const resolved = resolvePalette(next)
          setStoredPalette(resolved)
          void savePalette(resolved).catch(() => {})
        },
      ),
    [theme, mode, storedPalette, fontSet],
  )

  return createElement(ThemeContext.Provider, { value }, children)
}

/** The active theme; outside a provider it starts on the system scheme (light fallback). */
export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext)
  const system = useColorScheme()
  const fallback = useMemo(() => {
    const resolved = resolveTheme(null, system)
    return themeValue(resolved, resolved, DEFAULT_PALETTE, systemFonts, () => {}, () => {})
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
