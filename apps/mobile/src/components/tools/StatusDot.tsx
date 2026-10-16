import { StyleSheet, View } from "react-native"
import { Ionicons } from "@expo/vector-icons"
import type { ChatToolStatus } from "@masterhand/client-core"
import { useTheme } from "../../theme"
import { statusColor } from "./theme"

/**
 * Phase-mapped status indicator mirroring the web `StatusDot`: running and
 * completed stay as colored dots, errors are a red X in the shared icon
 * format, anything else is the muted idle dot.
 */
export function StatusDot({ status, size = 14 }: { status: ChatToolStatus; size?: number }) {
  const { colors } = useTheme()
  if (status === "error") {
    return <Ionicons name="close" size={size} color={colors.danger} />
  }
  return <View style={[styles.dot, { backgroundColor: statusColor(status, colors) }]} />
}

const styles = StyleSheet.create({
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
})
