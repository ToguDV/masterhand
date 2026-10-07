import { StyleSheet, Text, View } from "react-native"
import { formatCount, formatSpeed, messageStats, type ChatMessageInfo } from "@masterhand/client-core"
import { ArrowDownIcon, ArrowUpIcon, BoltIcon, SparkleIcon } from "./icons"
import { useTheme, useThemedStyles, type Fonts, type Palette } from "../theme"

/**
 * Per-message usage as icons + numbers only (labels live in the accessibility
 * names), mirroring the web MessageStats and the session usage row (#126).
 * Cache read/write are deliberately not shown; the caller renders it only once
 * the message completed.
 */
export function MessageStats({ info }: { info: ChatMessageInfo }) {
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()
  const stats = messageStats(info)
  const tokens = stats.input > 0 || stats.output > 0 || stats.reasoning > 0
  if (stats.modelID === null && stats.cost === null && !tokens && stats.speed === null) return null

  return (
    <View style={styles.row} accessibilityLabel="Message usage">
      {stats.modelID !== null ? (
        <Text style={styles.model} numberOfLines={1}>
          {stats.modelID}
        </Text>
      ) : null}
      {stats.cost !== null ? (
        <View style={styles.item} accessibilityLabel={`Cost: $${stats.cost.toFixed(4)}`}>
          <Text style={styles.text}>$</Text>
          <Text style={styles.text}>{stats.cost.toFixed(4)}</Text>
        </View>
      ) : null}
      {stats.input > 0 ? (
        <View style={styles.item} accessibilityLabel={`Input tokens: ${stats.input}`}>
          <ArrowUpIcon size={12} color={colors.textMuted} />
          <Text style={styles.text}>{formatCount(stats.input)}</Text>
        </View>
      ) : null}
      {stats.output > 0 ? (
        <View style={styles.item} accessibilityLabel={`Output tokens: ${stats.output}`}>
          <ArrowDownIcon size={12} color={colors.textMuted} />
          <Text style={styles.text}>{formatCount(stats.output)}</Text>
        </View>
      ) : null}
      {stats.reasoning > 0 ? (
        <View style={styles.item} accessibilityLabel={`Reasoning tokens: ${stats.reasoning}`}>
          <SparkleIcon size={12} color={colors.textMuted} />
          <Text style={styles.text}>{formatCount(stats.reasoning)}</Text>
        </View>
      ) : null}
      {stats.speed !== null ? (
        <View style={styles.item} accessibilityLabel={`Speed: ${formatSpeed(stats.speed)}`}>
          <BoltIcon size={12} color={colors.textMuted} />
          <Text style={styles.text}>{formatSpeed(stats.speed)}</Text>
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
      gap: 10,
      marginTop: 4,
    },
    model: {
      flexShrink: 1,
      color: colors.textFaint,
      fontFamily: fonts.mono,
      fontSize: 11,
    },
    item: {
      flexDirection: "row",
      alignItems: "center",
      gap: 3,
    },
    text: {
      color: colors.textFaint,
      fontFamily: fonts.mono,
      fontSize: 11,
    },
  })
}
