import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native"
import { ClipPath, Defs, G, Path, Svg } from "react-native-svg"
import type { Client } from "@masterhand/client-core"
import { Screen } from "./Screen"
import { ProvidersSection } from "./ProvidersSection"
import { CloseIcon, GearIcon } from "./icons"
import { useTheme, useThemedStyles, type Fonts, type Palette, type ThemeMode } from "../theme"

const THEMES: Array<{ value: ThemeMode; label: string; swatches: [string, string] }> = [
  { value: "light", label: "Light", swatches: ["#FAFAF7", "#0B6B53"] },
  { value: "dark", label: "Dark", swatches: ["#0C0C0B", "#3ED8A8"] },
]

const DROP_D = "M24 2 C27.5 9 42 25 42 40 A18 18 0 0 1 6 40 C6 25 20.5 9 24 2 Z"
const WAVE_TOP_D = "M-4 -4 H52 V31 C40 39 32 41 25 36 C18 31 12 29 -4 36 Z"

/**
 * App-level settings (issue #119): a full-screen modal opened from the Sessions
 * header gear. Appearance owns the explicit theme (light/dark);
 * Account (sign out) and later sections append below.
 */
export function SettingsModal({
  visible,
  client,
  mode,
  onSelectMode,
  onClose,
}: {
  visible: boolean
  client: Client
  mode: ThemeMode
  onSelectMode: (mode: ThemeMode) => void
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
                    top={option.swatches[0]}
                    bottom={option.swatches[1]}
                    selected={selected}
                    stroke={selected ? colors.accent : colors.hairlineStrong}
                    clipId={`mh-drop-${option.value}`}
                  />
                </Pressable>
              )
            })}
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
    accountTitle: {
      marginTop: 18,
    },
  })
}
