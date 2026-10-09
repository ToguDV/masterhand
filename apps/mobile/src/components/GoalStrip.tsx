import { useRef, useState, type ReactNode } from "react"
import { Pressable, StyleSheet, Text, View } from "react-native"
import { useQueryClient } from "@tanstack/react-query"
import {
  goalErrorMessage,
  goalResultLine,
  goalStateLabel,
  isGoalActive,
  queryKeys,
  useGoalRun,
  type Client,
} from "@masterhand/client-core"
import { PauseIcon, PlayIcon, SparkleIcon, StopIcon } from "./icons"
import { useTheme, useThemedStyles, type Fonts, type Palette } from "../theme"

/**
 * Goal Mode control strip: one subtle block above the composer with the loop
 * phase, round and last review result, plus actions styled like the rest of
 * the interface. The run state is SSE-driven (`goal.updated` frames); mutations
 * reconcile it by refetching and a timeout is reported as "may have changed".
 * The review history itself lives in the thread (GoalReview).
 */
export function GoalStrip({ client, sessionID }: { client: Client; sessionID: string }) {
  const queryClient = useQueryClient()
  const { data } = useGoalRun(client, sessionID)
  const [busy, setBusy] = useState(false)
  // Synchronous in-flight guard: a state flag is not a lock (rule 7).
  const busyRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()

  if (!data) return null

  const active = isGoalActive(data.state)
  const resumable = data.state === "paused" || data.state === "error"
  const result = goalResultLine(data)

  async function act(action: () => Promise<unknown>): Promise<void> {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      await action()
      await queryClient.invalidateQueries({ queryKey: queryKeys.goal(sessionID) })
    } catch (actionError) {
      setError(goalErrorMessage(actionError))
      // A timeout may still have applied; refresh instead of retrying blindly.
      await queryClient.invalidateQueries({ queryKey: queryKeys.goal(sessionID) })
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const tone =
    data.state === "error" ? styles.dangerText : data.state === "approved" ? styles.accentText : null

  return (
    <View style={styles.container} accessibilityLabel="Goal run">
      <View style={styles.infoRow}>
        <SparkleIcon size={13} color={active ? colors.accent : colors.textMuted} />
        <Text style={[styles.state, tone]}>{goalStateLabel(data.state)}</Text>
        <View style={styles.roundChip}>
          <Text style={styles.round}>{`${data.round}/${data.maxRounds}`}</Text>
        </View>
        {data.lastError && active ? (
          <Text style={styles.warning} numberOfLines={1}>
            {data.lastError}
          </Text>
        ) : result ? (
          <Text style={styles.result} numberOfLines={1}>
            {result}
          </Text>
        ) : null}
      </View>

      <View style={styles.actions}>
        {active ? (
          <>
            <Action
              label="Pause"
              icon={<PauseIcon size={14} color={colors.text} />}
              disabled={busy}
              onPress={() => void act(() => client.api.goal.pause(sessionID))}
            />
            <Action
              label="Cancel"
              icon={<StopIcon size={14} color={colors.danger} />}
              variant="danger"
              disabled={busy}
              onPress={() => void act(() => client.api.goal.cancel(sessionID))}
            />
          </>
        ) : null}
        {resumable ? (
          <>
            <Action
              label={data.state === "paused" ? "Resume" : "Retry"}
              icon={<PlayIcon size={14} color={colors.onAccent} />}
              variant="primary"
              disabled={busy}
              onPress={() => void act(() => client.api.goal.resume(sessionID))}
            />
            <Action
              label="Cancel"
              icon={<StopIcon size={14} color={colors.danger} />}
              variant="danger"
              disabled={busy}
              onPress={() => void act(() => client.api.goal.cancel(sessionID))}
            />
          </>
        ) : null}
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}
      {data.error ? <Text style={styles.error}>{data.error}</Text> : null}
    </View>
  )
}

function Action({
  label,
  icon,
  onPress,
  variant = "secondary",
  disabled = false,
}: {
  label: string
  icon: ReactNode
  onPress: () => void
  variant?: "primary" | "secondary" | "danger"
  disabled?: boolean
}) {
  const styles = useThemedStyles(createStyles)
  return (
    <Pressable
      style={[
        styles.action,
        variant === "primary" && styles.actionPrimary,
        variant === "danger" && styles.actionDanger,
        disabled && styles.disabled,
      ]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      {icon}
      <Text
        style={[
          styles.actionText,
          variant === "primary" && styles.actionPrimaryText,
          variant === "danger" && styles.dangerText,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  )
}

function createStyles(colors: Palette, fonts: Fonts) {
  return StyleSheet.create({
    container: {
      gap: 6,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.hairline,
      backgroundColor: colors.surface,
      paddingHorizontal: 14,
      paddingVertical: 8,
    },
    infoRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    state: {
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 12,
      fontWeight: "600",
    },
    accentText: {
      color: colors.accent,
    },
    dangerText: {
      color: colors.danger,
    },
    roundChip: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      borderRadius: 8,
      paddingHorizontal: 6,
      paddingVertical: 1,
    },
    round: {
      color: colors.textMuted,
      fontFamily: fonts.mono,
      fontSize: 10,
    },
    result: {
      flexShrink: 1,
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 11,
    },
    warning: {
      flexShrink: 1,
      color: colors.warning,
      fontFamily: fonts.ui,
      fontSize: 11,
    },
    actions: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      gap: 8,
    },
    action: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      minHeight: 44,
      justifyContent: "center",
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairlineStrong,
      backgroundColor: colors.surface,
      borderRadius: 10,
      paddingHorizontal: 14,
    },
    actionPrimary: {
      borderColor: colors.accent,
      backgroundColor: colors.accent,
    },
    actionDanger: {
      borderColor: colors.dangerLine,
      backgroundColor: colors.dangerSoft,
    },
    disabled: {
      opacity: 0.5,
    },
    actionText: {
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 12,
      fontWeight: "500",
    },
    actionPrimaryText: {
      color: colors.onAccent,
    },
    error: {
      color: colors.danger,
      fontFamily: fonts.ui,
      fontSize: 11,
    },
  })
}
