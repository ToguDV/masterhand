import { useEffect, useRef, useState } from "react"
import { AccessibilityInfo, Animated, Easing, StyleSheet, Text, View } from "react-native"
import { useTheme, useThemedStyles, type Fonts, type Palette } from "../theme"

export type ServerConnectionStatus = "connected" | "saved" | "expired" | "connecting"

const LABELS: Record<ServerConnectionStatus, string> = {
  connected: "Connected",
  saved: "Saved",
  expired: "Expired",
  connecting: "Connecting",
}

/** Tracks the OS reduce-motion setting for the (only) animated status glyph. */
function useReduceMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    let active = true
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (active) setReduced(value)
      })
      .catch(() => {})
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduced)
    return () => {
      active = false
      subscription.remove()
    }
  }, [])
  return reduced
}

/**
 * Status vocabulary from design/DESIGN.html: connected = static check, saved =
 * idle ring, expired = warning ring, connecting = 1s monochrome arc. Only the
 * busy arc animates; reduce-motion leaves it static. Text always accompanies
 * the glyph.
 */
export function ServerStatus({
  status,
  showLabel = true,
  size = 14,
}: {
  status: ServerConnectionStatus
  showLabel?: boolean
  size?: number
}) {
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()
  const reduced = useReduceMotion()
  const rotation = useRef(new Animated.Value(0)).current
  const busy = status === "connecting"

  useEffect(() => {
    if (!busy || reduced) {
      rotation.stopAnimation()
      rotation.setValue(0)
      return
    }
    const loop = Animated.loop(
      Animated.timing(rotation, {
        toValue: 1,
        duration: 1000,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    )
    loop.start()
    return () => loop.stop()
  }, [busy, reduced, rotation])

  const label = LABELS[status]
  return (
    <View style={styles.row} accessible accessibilityLabel={label}>
      {status === "connected" ? (
        <Text style={[styles.check, { color: colors.success, fontSize: size }]} accessibilityElementsHidden importantForAccessibility="no">
          ✓
        </Text>
      ) : status === "connecting" ? (
        <Animated.View
          style={[
            styles.arc,
            {
              width: size,
              height: size,
              borderRadius: size / 2,
              borderWidth: 2,
              borderColor: colors.hairlineStrong,
              borderTopColor: colors.textSoft,
              transform: [
                {
                  rotate: rotation.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] }),
                },
              ],
            },
          ]}
          accessibilityElementsHidden
          importantForAccessibility="no"
        />
      ) : (
        <View
          style={[
            styles.ring,
            {
              width: size - 2,
              height: size - 2,
              borderRadius: (size - 2) / 2,
              borderColor: status === "expired" ? colors.warning : colors.hairlineStrong,
            },
          ]}
          accessibilityElementsHidden
          importantForAccessibility="no"
        />
      )}
      {showLabel ? <Text style={styles.label}>{label}</Text> : null}
    </View>
  )
}

export function ServerMonogram({
  label,
  active = false,
  size = 36,
}: {
  label: string
  active?: boolean
  size?: number
}) {
  const styles = useThemedStyles(createStyles)
  const initials = monogram(label)
  return (
    <View
      style={[
        styles.monogram,
        {
          width: size,
          height: size,
          borderRadius: size >= 40 ? 12 : 10,
        },
        active && styles.monogramActive,
      ]}
      accessibilityElementsHidden
      importantForAccessibility="no"
    >
      <Text style={[styles.monogramText, active && styles.monogramTextActive, size < 34 && { fontSize: 10 }]}>
        {initials}
      </Text>
    </View>
  )
}

function monogram(label: string): string {
  const words = label.trim().split(/[\s._\-/]+/).filter(Boolean)
  if (words.length >= 2) {
    const pair = `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}`
    if (/^[a-z]{2}$/i.test(pair)) return pair.toUpperCase()
  }
  const letters = words.join("").replace(/[^\p{L}\p{N}]/gu, "").slice(0, 2)
  return (letters || "MH").toUpperCase()
}

function createStyles(colors: Palette, fonts: Fonts) {
  return StyleSheet.create({
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    label: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 11,
    },
    check: {
      fontFamily: fonts.ui,
      fontWeight: "700",
      lineHeight: 16,
    },
    ring: {
      borderWidth: 2,
      backgroundColor: "transparent",
    },
    arc: {
      backgroundColor: "transparent",
    },
    monogram: {
      alignItems: "center",
      justifyContent: "center",
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairlineStrong,
      backgroundColor: colors.surface,
    },
    monogramActive: {
      borderColor: colors.accentLine,
      backgroundColor: colors.accentSoft,
    },
    monogramText: {
      color: colors.textSoft,
      fontFamily: fonts.ui,
      fontSize: 12,
      fontWeight: "600",
      letterSpacing: 0.72,
    },
    monogramTextActive: {
      color: colors.accent,
    },
  })
}
