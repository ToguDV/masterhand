import { useMemo, useState, type ReactNode } from "react"
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native"
import { Popover, usePopover } from "./Popover"
import { ChevronDownIcon } from "./icons"
import { useTheme, useThemedStyles, type Fonts, type Palette } from "../theme"

export interface SearchSelectOption {
  value: string
  label: string
  /** Compact text shown in the trigger instead of `label` (the list keeps `label`). */
  triggerLabel?: string
}

/**
 * Native counterpart of the web `SearchSelect` (agent, model and effort in the
 * composer): a compact ghost pill that opens a small anchored menu. Search
 * appears only when the list is longer than `previewCount`, the selected row
 * keeps the accent color and the five/six-row preview expands through
 * "Show all" — the same interaction and typography as the web popover.
 */
export function SearchSelect({
  value,
  options,
  onChange,
  ariaLabel,
  placeholder,
  previewCount = 6,
  disabled = false,
  icon,
  placement = "up",
  testID,
}: {
  value: string
  options: SearchSelectOption[]
  onChange: (value: string) => void
  /** Accessible name of the trigger (web `ariaLabel`). */
  ariaLabel: string
  placeholder: string
  previewCount?: number
  disabled?: boolean
  /** Optional leading glyph (kept out of the accessible name). */
  icon?: ReactNode
  placement?: "up" | "down"
  testID?: string
}) {
  const [query, setQuery] = useState("")
  const [expanded, setExpanded] = useState(false)
  const popover = usePopover()
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()

  const selected = options.find((option) => option.value === value)
  const searchable = options.length > previewCount
  const visible = useMemo(() => {
    const term = query.trim().toLowerCase()
    if (term) return options.filter((option) => option.label.toLowerCase().includes(term))
    if (!searchable || expanded) return options
    const pinned = selected
      ? [selected, ...options.filter((option) => option.value !== selected.value)]
      : options
    return pinned.slice(0, previewCount)
  }, [options, query, searchable, expanded, selected, previewCount])
  const truncated = searchable && !expanded && !query.trim()

  function close(): void {
    popover.hide()
    setQuery("")
    setExpanded(false)
  }

  return (
    <View style={styles.root}>
      <Pressable
        ref={popover.triggerRef}
        onPress={popover.toggle}
        onPressIn={popover.measure}
        onLayout={popover.measure}
        disabled={disabled}
        hitSlop={8}
        style={({ pressed }) => [
          styles.trigger,
          pressed && !disabled && styles.triggerPressed,
          disabled && styles.disabled,
        ]}
        accessibilityRole="button"
        accessibilityLabel={ariaLabel}
        accessibilityValue={{ text: selected?.triggerLabel ?? selected?.label ?? placeholder }}
        accessibilityState={{ expanded: popover.open, disabled }}
        testID={testID}
      >
        <View style={styles.labelRow}>
          {icon}
          <Text
            style={[styles.triggerText, selected ? styles.triggerTextSelected : styles.triggerTextEmpty]}
            numberOfLines={1}
          >
            {selected?.triggerLabel ?? selected?.label ?? placeholder}
          </Text>
        </View>
        <ChevronDownIcon size={14} color={colors.textMuted} />
      </Pressable>

      <Popover open={popover.open} anchor={popover.anchor} placement={placement} onClose={close}>
        {searchable ? (
          <TextInput
            value={query}
            onChangeText={setQuery}
            onSubmitEditing={() => {
              const first = visible[0]
              if (!first) return
              onChange(first.value)
              close()
            }}
            placeholder="Search…"
            placeholderTextColor={colors.textFaint}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            accessibilityLabel={`Search ${ariaLabel.toLowerCase()}`}
            style={styles.search}
          />
        ) : null}
        <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
          {visible.map((option) => (
            <Pressable
              key={option.value}
              onPress={() => {
                onChange(option.value)
                close()
              }}
              style={({ pressed }) => [styles.option, pressed && styles.optionPressed]}
              accessibilityRole="menuitem"
              accessibilityState={{ selected: option.value === value }}
              testID={testID ? `${testID}-${option.value}` : undefined}
            >
              <Text
                style={[styles.optionText, option.value === value && styles.optionTextSelected]}
                numberOfLines={1}
              >
                {option.label}
              </Text>
            </Pressable>
          ))}
          {visible.length === 0 ? <Text style={styles.empty}>No matches</Text> : null}
          {truncated ? (
            <Pressable
              onPress={() => setExpanded(true)}
              style={styles.showAll}
              hitSlop={{ top: 6, bottom: 6 }}
              accessibilityRole="button"
              accessibilityLabel={`Show all ${options.length} ${ariaLabel.toLowerCase()}s`}
            >
              <Text style={styles.showAllText}>
                Show all {options.length} {ariaLabel.toLowerCase()}s
              </Text>
            </Pressable>
          ) : null}
        </ScrollView>
      </Popover>
    </View>
  )
}

function createStyles(colors: Palette, fonts: Fonts) {
  return StyleSheet.create({
    root: {
      minWidth: 0,
    },
    trigger: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 6,
      maxWidth: 224,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: "transparent",
      borderRadius: 999,
      paddingHorizontal: 10,
      paddingVertical: 5,
    },
    triggerPressed: {
      backgroundColor: colors.surfaceMuted,
    },
    labelRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      flexShrink: 1,
      minWidth: 0,
    },
    triggerText: {
      flexShrink: 1,
      fontFamily: fonts.ui,
      fontSize: 12,
    },
    triggerTextSelected: {
      color: colors.text,
    },
    triggerTextEmpty: {
      color: colors.textMuted,
    },
    disabled: {
      opacity: 0.5,
    },
    search: {
      marginBottom: 8,
      minHeight: 32,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      borderRadius: 4,
      backgroundColor: colors.surfaceMuted,
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 12,
      paddingHorizontal: 8,
      paddingVertical: 6,
    },
    list: {
      maxHeight: 240,
      flexShrink: 1,
    },
    option: {
      minHeight: 32,
      justifyContent: "center",
      borderRadius: 4,
      paddingHorizontal: 8,
      paddingVertical: 6,
    },
    optionPressed: {
      backgroundColor: colors.surfaceMuted,
    },
    optionText: {
      color: colors.textSoft,
      fontFamily: fonts.ui,
      fontSize: 12,
    },
    optionTextSelected: {
      color: colors.accent,
    },
    empty: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 12,
      paddingHorizontal: 8,
      paddingVertical: 12,
    },
    showAll: {
      marginTop: 4,
      minHeight: 32,
      justifyContent: "center",
      borderRadius: 4,
      paddingHorizontal: 8,
      paddingVertical: 6,
    },
    showAllText: {
      color: colors.accent,
      fontFamily: fonts.ui,
      fontSize: 12,
    },
  })
}
