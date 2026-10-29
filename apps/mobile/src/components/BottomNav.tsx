import type { ComponentType } from "react"
import { Pressable, StyleSheet, Text, View } from "react-native"
import { ChatBubbleIcon, ClockIcon, GearIcon, KanbanIcon, type IconProps } from "./icons"
import { useTheme, useThemedStyles, type Fonts, type Palette } from "../theme"

/** Home sections, mirroring the web sidebar rail (Sessions/Board/Scheduler). */
export type HomeSection = "sessions" | "board" | "scheduler"

type SectionItem = {
  id: HomeSection
  label: string
  accessibilityLabel: string
  icon: ComponentType<IconProps>
}

const SECTIONS: SectionItem[] = [
  { id: "sessions", label: "Sessions", accessibilityLabel: "Show sessions", icon: ChatBubbleIcon },
  { id: "board", label: "Board", accessibilityLabel: "Show board", icon: KanbanIcon },
  { id: "scheduler", label: "Scheduler", accessibilityLabel: "Show scheduler", icon: ClockIcon },
]

/**
 * Mobile primary navigation: the home sections plus Settings, pinned above the
 * bottom safe area. Settings is an action (it opens the full-screen settings
 * surface), never an active tab; the sign-out action lives inside settings.
 * The bar is home chrome only: an open chat takes over the screen and its
 * back chevron returns here.
 */
export function BottomNav({
  section,
  onSelectSection,
  onOpenSettings,
  showBoard = true,
  showScheduler = true,
}: {
  section: HomeSection
  onSelectSection: (section: HomeSection) => void
  onOpenSettings: () => void
  /** Board/scheduler slots are optional outside the app shell (tests, embeds). */
  showBoard?: boolean
  showScheduler?: boolean
}) {
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()
  const sections = SECTIONS.filter((item) =>
    item.id === "sessions" ? true : item.id === "board" ? showBoard : showScheduler,
  )

  return (
    <View
      style={styles.bar}
      accessibilityRole="tablist"
      accessibilityLabel="Main navigation"
      testID="bottom-nav"
    >
      {sections.map((item) => {
        const Icon = item.icon
        const active = section === item.id
        return (
          <Pressable
            key={item.id}
            onPress={() => onSelectSection(item.id)}
            accessibilityRole="tab"
            accessibilityLabel={item.accessibilityLabel}
            accessibilityState={{ selected: active }}
            style={styles.item}
          >
            <View style={[styles.iconPill, active && styles.iconPillActive]}>
              <Icon size={20} color={active ? colors.accent : colors.textMuted} />
            </View>
            <Text style={[styles.label, active && styles.labelActive]} numberOfLines={1}>
              {item.label}
            </Text>
          </Pressable>
        )
      })}

      <Pressable
        onPress={onOpenSettings}
        accessibilityRole="button"
        accessibilityLabel="Settings"
        style={styles.item}
      >
        <View style={styles.iconPill}>
          <GearIcon size={20} color={colors.textMuted} />
        </View>
        <Text style={styles.label} numberOfLines={1}>
          Settings
        </Text>
      </Pressable>
    </View>
  )
}

function createStyles(colors: Palette, fonts: Fonts) {
  return StyleSheet.create({
    bar: {
      flexDirection: "row",
      alignItems: "stretch",
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.hairline,
      backgroundColor: colors.canvas,
      paddingHorizontal: 4,
      paddingTop: 2,
    },
    item: {
      flex: 1,
      minHeight: 52,
      alignItems: "center",
      justifyContent: "center",
      gap: 3,
      paddingVertical: 4,
    },
    iconPill: {
      minWidth: 44,
      height: 26,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 999,
    },
    iconPillActive: {
      backgroundColor: colors.accentSoft,
    },
    label: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 10,
      fontWeight: "500",
    },
    labelActive: {
      color: colors.accent,
      fontWeight: "600",
    },
  })
}
