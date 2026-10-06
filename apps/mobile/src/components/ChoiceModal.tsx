import { useEffect, useState } from "react"
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native"
import { useTheme, useThemedStyles, type Fonts, type Palette } from "../theme"

export interface ChoiceOption {
  value: string
  label: string
}

export function ChoiceModal({
  visible,
  title,
  options,
  selected,
  onSelect,
  onClose,
}: {
  visible: boolean
  title: string
  options: ChoiceOption[]
  selected: string
  onSelect: (value: string) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState("")
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()

  useEffect(() => {
    if (!visible) setQuery("")
  }, [visible])

  const term = query.trim().toLowerCase()
  const filtered = term ? options.filter((option) => option.label.toLowerCase().includes(term)) : options

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <Text style={styles.title}>{title}</Text>
          {options.length > 8 && (
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search…"
              placeholderTextColor={colors.textFaint}
              autoCorrect={false}
              autoCapitalize="none"
              style={styles.search}
            />
          )}
          <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
            {filtered.length === 0 && <Text style={styles.empty}>No matches</Text>}
            {filtered.map((option) => (
              <Pressable
                key={option.value}
                style={[styles.option, option.value === selected && styles.optionSelected]}
                onPress={() => {
                  onSelect(option.value)
                  onClose()
                }}
              >
                <Text style={[styles.optionText, option.value === selected && styles.optionTextSelected]}>
                  {option.label}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

function createStyles(colors: Palette, fonts: Fonts) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      justifyContent: "flex-end",
      backgroundColor: colors.overlay,
    },
    sheet: {
      maxHeight: "70%",
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      backgroundColor: colors.surface,
      paddingBottom: 24,
    },
    title: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 11,
      fontWeight: "600",
      letterSpacing: 0.8,
      textTransform: "uppercase",
      paddingHorizontal: 16,
      paddingTop: 16,
      paddingBottom: 8,
    },
    search: {
      marginHorizontal: 16,
      marginBottom: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairlineStrong,
      backgroundColor: colors.surface,
      borderRadius: 12,
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 15,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    empty: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 14,
      paddingHorizontal: 16,
      paddingVertical: 16,
    },
    list: {
      flexGrow: 0,
    },
    option: {
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.hairline,
    },
    optionSelected: {
      backgroundColor: colors.surfaceMuted,
    },
    optionText: {
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 15,
    },
    optionTextSelected: {
      color: colors.accent,
      fontWeight: "600",
    },
  })
}
