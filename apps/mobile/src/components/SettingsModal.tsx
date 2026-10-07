import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native"
import type { Client } from "@masterhand/client-core"
import { Screen } from "./Screen"
import { ProvidersSection } from "./ProvidersSection"
import { CheckIcon, CloseIcon, GearIcon } from "./icons"
import { useTheme, useThemedStyles, type Fonts, type Palette, type ThemeMode } from "../theme"

const MODES: Array<{ value: ThemeMode; label: string; hint: string }> = [
  { value: "system", label: "System", hint: "Follow this device" },
  { value: "light", label: "Light", hint: "Paper" },
  { value: "dark", label: "Dark", hint: "Ink" },
]

/**
 * App-level settings (issue #119): a full-screen modal opened from the Sessions
 * header gear. Appearance owns the mode (System clears the stored choice);
 * Account (sign out) and later sections append below.
 */
export function SettingsModal({
  visible,
  client,
  mode,
  onSelectMode,
  onSignOut,
  onClose,
}: {
  visible: boolean
  client: Client
  mode: ThemeMode
  onSelectMode: (mode: ThemeMode) => void
  onSignOut: () => void
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
          <View accessibilityRole="radiogroup" accessibilityLabel="Theme mode">
            {MODES.map((option) => {
              const selected = mode === option.value
              return (
                <Pressable
                  key={option.value}
                  style={[styles.option, selected && styles.optionSelected]}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected }}
                  accessibilityLabel={option.label}
                  onPress={() => onSelectMode(option.value)}
                >
                  <View style={styles.optionText}>
                    <Text style={styles.optionTitle}>{option.label}</Text>
                    <Text style={styles.optionHint}>{option.hint}</Text>
                  </View>
                  {selected ? <CheckIcon size={16} color={colors.accent} /> : null}
                </Pressable>
              )
            })}
          </View>

          <Text style={[styles.sectionTitle, styles.accountTitle]}>Providers</Text>
          <ProvidersSection client={client} />

          <Text style={[styles.sectionTitle, styles.accountTitle]}>Account</Text>
          <Pressable
            style={styles.signOut}
            accessibilityRole="button"
            accessibilityLabel="Sign out"
            onPress={() => {
              onClose()
              onSignOut()
            }}
          >
            <Text style={styles.signOutText}>Sign out</Text>
          </Pressable>
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
    option: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      minHeight: 56,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      borderRadius: 12,
      backgroundColor: colors.surface,
      paddingHorizontal: 14,
      paddingVertical: 10,
      marginTop: 8,
    },
    optionSelected: {
      borderColor: colors.accentLine,
      backgroundColor: colors.accentSoft,
    },
    optionText: {
      flex: 1,
      gap: 2,
    },
    optionTitle: {
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 15,
      fontWeight: "500",
    },
    optionHint: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 12,
    },
    accountTitle: {
      marginTop: 18,
    },
    signOut: {
      minHeight: 48,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.dangerLine,
      borderRadius: 12,
      backgroundColor: colors.dangerSoft,
      marginTop: 8,
    },
    signOutText: {
      color: colors.danger,
      fontFamily: fonts.ui,
      fontSize: 15,
      fontWeight: "600",
    },
  })
}
