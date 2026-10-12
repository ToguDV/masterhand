import { StyleSheet, Text, View } from "react-native"
import { formatCount, formatSpeed, tokenSpeed, type SessionUsage } from "@masterhand/client-core"
import { ArrowDownIcon, ArrowUpIcon, BoltIcon, SparkleIcon } from "./icons"
import { useTheme, useThemedStyles, type Fonts, type Palette } from "../theme"

/**
 * Per-session usage as icons + numbers only (labels live in the accessibility
 * names), mirroring the web `SessionStats`. Cache read/write are deliberately
 * not shown. Rendered as the trailing slot of the composer dock header.
 */
export function SessionStats({ usage }: { usage: SessionUsage }) {
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()
  const speed = tokenSpeed(usage, usage.durationMs)
  const tokens = usage.input > 0 || usage.output > 0 || usage.reasoning > 0
  if (usage.cost <= 0 && !tokens && speed === null) return null

  return (
    <View style={styles.row} accessibilityLabel="Session usage">
      {usage.cost > 0 ? (
        <View style={styles.item} accessibilityLabel={`Cost: $${usage.cost.toFixed(4)}`}>
          <Text style={styles.text}>${usage.cost.toFixed(4)}</Text>
        </View>
      ) : null}
      {usage.input > 0 ? (
        <View style={styles.item} accessibilityLabel={`Input tokens: ${usage.input}`}>
          <ArrowUpIcon size={12} color={colors.textMuted} />
          <Text style={styles.text}>{formatCount(usage.input)}</Text>
        </View>
      ) : null}
      {usage.output > 0 ? (
        <View style={styles.item} accessibilityLabel={`Output tokens: ${usage.output}`}>
          <ArrowDownIcon size={12} color={colors.textMuted} />
          <Text style={styles.text}>{formatCount(usage.output)}</Text>
        </View>
      ) : null}
      {usage.reasoning > 0 ? (
        <View style={styles.item} accessibilityLabel={`Reasoning tokens: ${usage.reasoning}`}>
          <SparkleIcon size={12} color={colors.textMuted} />
          <Text style={styles.text}>{formatCount(usage.reasoning)}</Text>
        </View>
      ) : null}
      {speed !== null ? (
        <View style={styles.item} accessibilityLabel={`Speed: ${formatSpeed(speed)}`}>
          <BoltIcon size={12} color={colors.textMuted} />
          <Text style={styles.text}>{formatSpeed(speed)}</Text>
        </View>
      ) : null}
    </View>
  )
}

function createStyles(colors: Palette, fonts: Fonts) {
  return StyleSheet.create({
    row: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      justifyContent: "flex-start",
      gap: 10,
    },
    item: {
      flexDirection: "row",
      alignItems: "center",
      gap: 3,
    },
    text: {
      color: colors.textMuted,
      fontFamily: fonts.mono,
      fontSize: 11,
    },
  })
}
