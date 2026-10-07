import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native"
import type { Client } from "@masterhand/client-core"
import { Screen } from "./Screen"
import { ProvidersSection } from "./ProvidersSection"
import { CheckIcon, CloseIcon, GearIcon } from "./icons"
import { useTheme, useThemedStyles, type Fonts, type Palette, type ThemeMode } from "../theme"

const THEMES: Array<{ value: ThemeMode; label: string; swatches: [string, string] }> = [
  { value: "light", label: "Light", swatches: ["#FAFAF7", "#0B6B53"] },
  { value: "dark", label: "Dark", swatches: ["#0C0C0B", "#3ED8A8"] },
]

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
                  <View
                    style={[styles.drop, selected && styles.dropSelected]}
                    accessibilityElementsHidden
                  >
                    <View style={styles.dropInner}>
                      <View style={[styles.dropHalf, { backgroundColor: option.swatches[0] }]} />
                      <View style={[styles.dropHalf, { backgroundColor: option.swatches[1] }]} />
                    </View>
                    {selected ? (
                      <View style={styles.dropCheck}>
                        <CheckIcon size={16} color="#FFFFFF" />
                      </View>
                    ) : null}
                  </View>
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
    // Teardrop: a rotated square with three round corners. The inner row
    // counter-rotates so the two main colors split vertically; the check
    // counter-rotates to stay upright.
    drop: {
      width: 44,
      height: 44,
      borderWidth: 1,
      borderColor: colors.hairlineStrong,
      borderRadius: 22,
      borderBottomLeftRadius: 4,
      transform: [{ rotate: "-45deg" }],
      overflow: "hidden",
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.surface,
    },
    dropSelected: {
      borderColor: colors.accent,
    },
    dropInner: {
      position: "absolute",
      width: 64,
      height: 64,
      flexDirection: "row",
      transform: [{ rotate: "45deg" }],
    },
    dropHalf: {
      flex: 1,
    },
    dropCheck: {
      transform: [{ rotate: "45deg" }],
    },
    accountTitle: {
      marginTop: 18,
    },
  })
}
