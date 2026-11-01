import { useEffect, useState, type ReactNode } from "react"
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
  previewCount,
  footer,
  emptyLabel = "No matches",
  showAllLabel,
}: {
  visible: boolean
  title: string
  options: ChoiceOption[]
  selected: string
  onSelect: (value: string) => void
  onClose: () => void
  /** When set, show this many options first plus a "Show all" action. */
  previewCount?: number
  /** Extra actions rendered under the list (management, filters, …). */
  footer?: ReactNode
  emptyLabel?: string
  showAllLabel?: string
}) {
  const [query, setQuery] = useState("")
  const [expanded, setExpanded] = useState(false)
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()

  useEffect(() => {
    if (visible) return
    setQuery("")
    setExpanded(false)
  }, [visible])

  const searchable = previewCount === undefined || options.length > previewCount
  const term = query.trim().toLowerCase()
  const filtered = term ? options.filter((option) => option.label.toLowerCase().includes(term)) : options
  const pinned = selected
    ? [options.find((option) => option.value === selected), ...filtered.filter((option) => option.value !== selected)]
    : filtered
  const truncated = searchable && previewCount !== undefined && !expanded && !term && options.length > previewCount
  const shown = truncated
    ? pinned.filter((option): option is ChoiceOption => Boolean(option)).slice(0, previewCount)
    : filtered

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
            {/* Model and agent catalogs are long enough that scrolling alone is
                not a usable picker; a short list can skip the field. */}
            {searchable ? (
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
            ) : null}
            <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
              {shown.length === 0 && <Text style={styles.empty}>{emptyLabel}</Text>}
              {shown.map((option) => (
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
              {truncated ? (
                <Pressable
                  style={styles.showAll}
                  onPress={() => setExpanded(true)}
                  accessibilityRole="button"
                  accessibilityLabel={showAllLabel ?? `Show all ${options.length}`}
                >
                  <Text style={styles.showAllText}>{showAllLabel ?? `Show all ${options.length}`}</Text>
                </Pressable>
              ) : null}
              {footer}
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
    showAll: {
      minHeight: 44,
      justifyContent: "center",
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.hairline,
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    showAllText: {
      color: colors.accent,
      fontFamily: fonts.ui,
      fontSize: 13,
      fontWeight: "500",
    },
  })
}
