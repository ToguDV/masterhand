import { Pressable, StyleSheet, Text, View } from "react-native"
import type { PendingSend } from "@masterhand/client-core"
import { useThemedStyles, type Fonts, type Palette } from "../theme"

/**
 * Ghost user bubble for a plain prompt awaiting delivery confirmation (#125).
 * Same geometry as the real bubble, dimmed, with a "Sending…" caption; on a
 * hard failure it becomes a retryable error state. The chat screen's
 * `usePendingSend` clears it when the marker appears in the history.
 */
export function PendingBubble({
  pending,
  onRetry,
  onDismiss,
}: {
  pending: PendingSend
  onRetry: () => void
  onDismiss: () => void
}) {
  const styles = useThemedStyles(createStyles)
  const failed = pending.status === "failed"

  return (
    <View
      style={styles.wrap}
      accessibilityLiveRegion="polite"
      accessibilityLabel={failed ? "Message failed to send" : "Sending message"}
    >
      <View style={[styles.bubble, failed && styles.bubbleFailed]}>
        <Text style={styles.bodyText}>{pending.text}</Text>
      </View>
      {failed ? (
        <View style={styles.actions}>
          <Text style={styles.failedText}>Failed to send</Text>
          <Pressable
            onPress={onRetry}
            accessibilityRole="button"
            accessibilityLabel="Retry sending"
            style={styles.retry}
          >
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
          <Pressable onPress={onDismiss} accessibilityRole="button" accessibilityLabel="Dismiss failed message" hitSlop={4}>
            <Text style={styles.dismissText}>Dismiss</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.actions}>
          <View style={styles.dot} />
          <Text style={styles.caption}>Sending…</Text>
        </View>
      )}
    </View>
  )
}

function createStyles(colors: Palette, fonts: Fonts) {
  return StyleSheet.create({
    wrap: {
      alignItems: "flex-end",
      gap: 4,
    },
    bubble: {
      maxWidth: "85%",
      opacity: 0.6,
      backgroundColor: colors.bubbleUser,
      borderRadius: 16,
      borderBottomRightRadius: 4,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    bubbleFailed: {
      opacity: 0.85,
    },
    bodyText: {
      color: colors.bubbleUserText,
      fontFamily: fonts.ui,
      fontSize: 15,
      lineHeight: 22,
    },
    actions: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    dot: {
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: colors.accent,
    },
    caption: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 11,
    },
    failedText: {
      color: colors.danger,
      fontFamily: fonts.ui,
      fontSize: 11,
    },
    retry: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairlineStrong,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 4,
    },
    retryText: {
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 11,
      fontWeight: "600",
    },
    dismissText: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 11,
    },
  })
}
