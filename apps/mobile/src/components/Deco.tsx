import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native"
import { useThemedStyles, type Palette } from "../theme"

export type DecoVariant = "blob" | "dots" | "hatch"

const DOT_ROWS = 5
const DOT_COLUMNS = 10
const HATCH_LINES = 12

/**
 * Organic decoration for genuinely empty surfaces only (login, empty session
 * list, empty transcript, empty workspace sheet): a soft blob, a halftone dot
 * field or a patch of line hatching, built from plain Views at low opacity.
 *
 * It is `aria-hidden`, `pointer-events: none`, and must never sit behind text,
 * diffs, code or tool output (design/DESIGN.md §Decoration).
 */
export function Deco({ variant, style }: { variant: DecoVariant; style?: StyleProp<ViewStyle> }) {
  const styles = useThemedStyles(createStyles)
  const hidden = {
    pointerEvents: "none" as const,
    accessibilityElementsHidden: true,
    importantForAccessibility: "no-hide-descendants" as const,
  }

  if (variant === "blob") {
    return <View {...hidden} style={[styles.blob, style]} />
  }

  if (variant === "dots") {
    return (
      <View {...hidden} style={[styles.dots, style]}>
        {Array.from({ length: DOT_ROWS }, (_, row) => (
          <View key={row} style={styles.dotRow}>
            {Array.from({ length: DOT_COLUMNS }, (_, column) => (
              <View key={column} style={styles.dot} />
            ))}
          </View>
        ))}
      </View>
    )
  }

  return (
    <View {...hidden} style={[styles.hatch, style]}>
      {Array.from({ length: HATCH_LINES }, (_, index) => (
        <View key={index} style={[styles.hatchLine, { left: index * 14 - 30 }]} />
      ))}
    </View>
  )
}

function createStyles(colors: Palette) {
  return StyleSheet.create({
    blob: {
      width: 220,
      height: 200,
      backgroundColor: colors.accentSoft,
      opacity: 0.8,
      borderTopLeftRadius: 120,
      borderTopRightRadius: 80,
      borderBottomRightRadius: 130,
      borderBottomLeftRadius: 70,
      transform: [{ rotate: "-12deg" }],
    },
    dots: {
      opacity: 0.6,
    },
    dotRow: {
      flexDirection: "row",
    },
    dot: {
      width: 3,
      height: 3,
      borderRadius: 1.5,
      margin: 4.5,
      backgroundColor: colors.hairlineStrong,
    },
    hatch: {
      width: 160,
      height: 64,
      overflow: "hidden",
      opacity: 0.7,
    },
    hatchLine: {
      position: "absolute",
      top: -20,
      width: 1,
      height: 110,
      backgroundColor: colors.hairline,
      transform: [{ rotate: "45deg" }],
    },
  })
}
