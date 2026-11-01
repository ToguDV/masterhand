import { useEffect, useState } from "react"
import {
  KeyboardAvoidingView,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
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
  const insets = useSafeAreaInsets()

  useEffect(() => {
    if (!visible) setQuery("")
  }, [visible])

  const term = query.trim().toLowerCase()
  const filtered = term ? options.filter((option) => option.label.toLowerCase().includes(term)) : options

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.root} behavior="padding">
        <Pressable style={styles.backdrop} onPress={onClose}>
          <Pressable
            style={[styles.sheet, { paddingBottom: Math.max(16, insets.bottom + 12) }]}
            onPress={() => {}}
          >
            <View style={styles.grab} />
            <Text style={styles.title}>{title}</Text>
            {/* Always available: model and agent catalogs are long enough that
                scrolling alone is not a usable picker. */}
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search…"
              placeholderTextColor={colors.textFaint}
              autoCorrect={false}
              autoCapitalize="none"
              accessibilityLabel={`Search ${title}`}
              style={styles.search}
            />
            <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
              {filtered.length === 0 && <Text style={styles.empty}>No matches</Text>}
              {filtered.map((option) => (
                <Pressable
                  key={option.value}
                  testID={`choice-${option.value}`}
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
      </KeyboardAvoidingView>
    </Modal>
  )
}

function createStyles(colors: Palette, fonts: Fonts) {
  return StyleSheet.create({
    root: {
      flex: 1,
    },
    backdrop: {
      flex: 1,
      justifyContent: "flex-end",
      backgroundColor: colors.overlay,
    },
    sheet: {
      maxHeight: "80%",
      overflow: "hidden",
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      backgroundColor: colors.surface,
    },
    grab: {
      alignSelf: "center",
      width: 36,
      height: 4,
      marginTop: 8,
      borderRadius: 2,
      backgroundColor: colors.hairlineStrong,
    },
    title: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 11,
      fontWeight: "600",
      letterSpacing: 0.8,
      textTransform: "uppercase",
      paddingHorizontal: 16,
      paddingTop: 12,
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
      flexShrink: 1,
    },
    option: {
      paddingHorizontal: 16,
      paddingVertical: 12,
      minHeight: 44,
      justifyContent: "center",
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
