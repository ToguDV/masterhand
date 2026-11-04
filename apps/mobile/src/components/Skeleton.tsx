import { StyleSheet, Text, View, type DimensionValue, type StyleProp, type ViewStyle } from "react-native"
import { useTheme } from "../theme"

/**
 * Placeholder that reserves the final geometry of async content. Mirrors the
 * web `.mh-skeleton`: a muted block, static (like the existing tool-card
 * pending bars) and hidden from accessibility.
 */
export function Skeleton({
  width = "100%",
  height,
  radius = 6,
  style,
}: {
  width?: DimensionValue
  height: number
  radius?: number
  style?: StyleProp<ViewStyle>
}) {
  const { colors } = useTheme()
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[{ width, height, borderRadius: radius, backgroundColor: colors.surfaceMuted }, style]}
    />
  )
}

/** Screen-reader status for a region whose visible placeholder is hidden. */
export function SkeletonStatus({ label }: { label: string }) {
  return (
    <Text accessibilityLiveRegion="polite" style={styles.srOnly}>
      {label}
    </Text>
  )
}

const styles = StyleSheet.create({
  srOnly: {
    position: "absolute",
    width: 1,
    height: 1,
    opacity: 0,
  },
})
