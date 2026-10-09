import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native"
import { ClipPath, Defs, G, Path, Svg } from "react-native-svg"
import { DEFAULT_PALETTE, PALETTES, type Client } from "@masterhand/client-core"
import { Screen } from "./Screen"
import { GoalReviewSection } from "./GoalReviewSection"
import { ProvidersSection } from "./ProvidersSection"
import { CloseIcon, GearIcon } from "./icons"
import {
  PALETTE_IDS,
  useTheme,
  useThemedStyles,
  type Fonts,
  type Palette,
  type PaletteID,
  type ThemeMode,
} from "../theme"

const THEMES: Array<{ value: ThemeMode; label: string; canvas: string }> = [
  { value: "light", label: "Light", canvas: "#FAFAF7" },
  { value: "dark", label: "Dark", canvas: "#0C0C0B" },
]

const DROP_D = "M24 2 C27.5 9 42 25 42 40 A18 18 0 0 1 6 40 C6 25 20.5 9 24 2 Z"
const WAVE_TOP_D = "M-4 -4 H52 V31 C40 39 32 41 25 36 C18 31 12 29 -4 36 Z"

/**
 * App-level settings (issue #119): a full-screen modal opened from the Sessions
 * header gear. Appearance owns the explicit theme (light/dark) plus the accent
 * palette (#124); Account (sign out) and later sections append below.
 */
export function SettingsModal({
  visible,
  client,
  mode,
  onSelectMode,
  palette,
  onSelectPalette,
  onClose,
}: {
  visible: boolean
  client: Client
  mode: ThemeMode
  onSelectMode: (mode: ThemeMode) => void
  palette: PaletteID
  onSelectPalette: (palette: PaletteID) => void
  onClose: () => void
}) {
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <Screen>
        <View style={styles.header}>
          <GearIcon size={18} color={colors.textMuted} />
          <Text style={styles.title}>Settings</Text>
          <Pressable
            onPress={onClose}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Close settings"
            style={styles.close}
          >
            <CloseIcon size={20} color={colors.textMuted} />
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.sectionTitle}>Appearance</Text>
          <Text style={styles.themeLabel}>Theme color</Text>
          <View
            accessibilityRole="radiogroup"
            accessibilityLabel="Theme color"
            style={styles.swatches}
          >
            {THEMES.map((option) => {
              const selected = mode === option.value
              const accent =
                option.value === "light" ? PALETTES[palette].light.accent : PALETTES[palette].dark.accent
              return (
                <Pressable
                  key={option.value}
                  style={styles.swatchOption}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected }}
                  accessibilityLabel={option.label}
                  onPress={() => onSelectMode(option.value)}
                >
                  <Text style={styles.swatchName}>{option.label}</Text>
                  <ThemeDrop
                    top={option.canvas}
                    bottom={accent}
                    selected={selected}
                    stroke={selected ? colors.accent : colors.hairlineStrong}
                    clipId={`mh-drop-${option.value}`}
                  />
                </Pressable>
              )
            })}
          </View>

          <Text style={styles.themeLabel}>Color theme</Text>
          <View accessibilityRole="radiogroup" accessibilityLabel="Color theme" style={styles.paletteGrid}>
            {PALETTE_IDS.map((id) => {
              const entry = PALETTES[id]
              const selected = palette === id
              return (
                <Pressable
                  key={id}
                  style={[styles.paletteOption, selected && styles.paletteOptionSelected]}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected }}
                  accessibilityLabel={entry.label}
                  onPress={() => onSelectPalette(id)}
                >
                  <Text style={styles.paletteName} numberOfLines={1} ellipsizeMode="tail">
                    {entry.label}
                  </Text>
                  <View
                    style={[styles.paletteDot, { borderColor: colors.hairlineStrong }]}
                    accessibilityElementsHidden
                    importantForAccessibility="no"
                  >
                    <View style={[styles.paletteHalf, { backgroundColor: entry.light.canvas }]} />
                    <View style={[styles.paletteHalf, { backgroundColor: entry.light.accent }]} />
                    <View style={[styles.paletteHalf, { backgroundColor: entry.dark.accent }]} />
                  </View>
                </Pressable>
              )
            })}
          </View>
          {palette !== DEFAULT_PALETTE ? (
            <Pressable
              onPress={() => onSelectPalette(DEFAULT_PALETTE)}
              accessibilityRole="button"
              accessibilityLabel={`Reset to ${PALETTES[DEFAULT_PALETTE].label}`}
              style={styles.resetRow}
            >
              <Text style={styles.resetText}>Reset to {PALETTES[DEFAULT_PALETTE].label}</Text>
            </Pressable>
          ) : null}

          <View style={styles.goalSection}>
            <GoalReviewSection client={client} />
          </View>

          <Text style={[styles.sectionTitle, styles.accountTitle]}>Providers</Text>
          <ProvidersSection client={client} />
        </ScrollView>
      </Screen>
    </Modal>
  )
}

/**
 * Stylized teardrop swatch pointing up (same geometry as web): the two theme
 * colors meet at an S-curved "liquid" division, clipped to the drop outline.
 */
function ThemeDrop({
  top,
  bottom,
  selected,
  stroke,
  clipId,
}: {
  top: string
  bottom: string
  selected: boolean
  stroke: string
  clipId: string
}) {
  return (
    <View accessibilityElementsHidden importantForAccessibility="no">
      <Svg viewBox="0 0 48 64" width={40} height={54}>
        <Defs>
          <ClipPath id={clipId}>
            <Path d={DROP_D} />
          </ClipPath>
        </Defs>
        <Path d={DROP_D} fill={bottom} />
        <G clipPath={`url(#${clipId})`}>
          <Path d={WAVE_TOP_D} fill={top} />
        </G>
        <Path d={DROP_D} fill="none" stroke={stroke} strokeWidth={selected ? 2 : 1.5} />
        {selected ? (
          <Path
            d="M17.5 41.5 L22.5 46.5 L30.5 36.5"
            fill="none"
            stroke="rgba(0, 0, 0, 0.45)"
            strokeWidth={4.6}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : null}
        {selected ? (
          <Path
            d="M17.5 41.5 L22.5 46.5 L30.5 36.5"
            fill="none"
            stroke="#FFFFFF"
            strokeWidth={3.2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : null}
      </Svg>
    </View>
  )
}

function createStyles(colors: Palette, fonts: Fonts) {
  return StyleSheet.create({
    header: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingHorizontal: 14,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.hairline,
    },
    title: {
      flex: 1,
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 16,
      fontWeight: "600",
    },
    close: {
      width: 40,
      height: 40,
      alignItems: "center",
      justifyContent: "center",
    },
    content: {
      padding: 14,
      gap: 8,
    },
    sectionTitle: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 11,
      letterSpacing: 0.8,
      textTransform: "uppercase",
      fontWeight: "600",
    },
    themeLabel: {
      marginTop: 12,
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 12,
    },
    swatches: {
      flexDirection: "row",
      gap: 20,
      marginTop: 12,
    },
    swatchOption: {
      alignItems: "center",
      gap: 8,
      minWidth: 64,
      padding: 4,
    },
    swatchName: {
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 13,
      fontWeight: "500",
    },
    paletteGrid: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
      marginTop: 12,
    },
    paletteOption: {
      alignItems: "center",
      gap: 8,
      minWidth: 88,
      flexGrow: 1,
      flexShrink: 1,
      flexBasis: 88,
      minHeight: 44,
      paddingHorizontal: 8,
      paddingVertical: 6,
      borderWidth: 1,
      borderColor: "transparent",
      borderRadius: 12,
      overflow: "hidden",
    },
    paletteOptionSelected: {
      borderColor: colors.accent,
      backgroundColor: colors.accentSoft,
    },
    paletteDot: {
      width: 20,
      height: 20,
      borderRadius: 10,
      borderWidth: 1,
      overflow: "hidden",
      flexDirection: "row",
    },
    paletteHalf: {
      flex: 1,
    },
    paletteName: {
      width: "100%",
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 13,
      fontWeight: "500",
      textAlign: "center",
    },
    resetRow: {
      alignSelf: "flex-start",
      marginTop: 8,
      minHeight: 44,
      justifyContent: "center",
      paddingHorizontal: 8,
    },
    resetText: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 13,
    },
    accountTitle: {
      marginTop: 18,
    },
    goalSection: {
      marginTop: 18,
    },
  })
}
