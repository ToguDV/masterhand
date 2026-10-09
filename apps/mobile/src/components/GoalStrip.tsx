import { useState } from "react"
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
  type GoalRun,
} from "@masterhand/client-core"
import { SparkleIcon } from "./icons"
import { useTheme, useThemedStyles, type Fonts, type Palette } from "../theme"

/**
 * Goal Mode status strip (issue #130): one subtle block above the composer with
 * the loop phase, round and last review result, plus pause/resume/cancel/retry
 * actions. The run state is SSE-driven (`goal.updated` frames); mutations
 * reconcile it by refetching and a timeout is reported as "may have changed".
 */
export function GoalStrip({ client, sessionID }: { client: Client; sessionID: string }) {
  const queryClient = useQueryClient()
  const { data } = useGoalRun(client, sessionID)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()

  if (!data) return null

  const active = isGoalActive(data.state)
  const result = goalResultLine(data)

  async function act(action: () => Promise<unknown>): Promise<void> {
    if (busy) return
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
        <Text style={styles.round}>
          round {data.round}/{data.maxRounds}
        </Text>
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
              disabled={busy}
              onPress={() => void act(() => client.api.goal.pause(sessionID))}
            />
            <Action
              label="Cancel"
              danger
              disabled={busy}
              onPress={() => void act(() => client.api.goal.cancel(sessionID))}
            />
          </>
        ) : null}
        {data.state === "paused" || data.state === "error" ? (
          <>
            <Action
              label={data.state === "paused" ? "Resume" : "Retry"}
              disabled={busy}
              onPress={() => void act(() => client.api.goal.resume(sessionID))}
            />
            <Action
              label="Cancel"
              danger
              disabled={busy}
              onPress={() => void act(() => client.api.goal.cancel(sessionID))}
            />
          </>
        ) : null}
        <Action
          label={expanded ? "Hide" : "Details"}
          expanded={expanded}
          onPress={() => setExpanded((current) => !current)}
        />
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}
      {data.error ? <Text style={styles.error}>{data.error}</Text> : null}
      {expanded ? <GoalDetails run={data} /> : null}
    </View>
  )
}

function Action({
  label,
  onPress,
  danger = false,
  disabled = false,
  expanded,
}: {
  label: string
  onPress: () => void
  danger?: boolean
  disabled?: boolean
  /** Set for the Details/Hide toggle so screen readers announce its state. */
  expanded?: boolean
}) {
  const styles = useThemedStyles(createStyles)
  return (
    <Pressable
      style={[styles.action, danger && styles.actionDanger, disabled && styles.disabled]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={expanded === undefined ? undefined : { expanded }}
    >
      <Text style={[styles.actionText, danger && styles.dangerText]}>{label}</Text>
    </Pressable>
  )
}

/** Collapsed-strip detail: goal, last report and the per-round review history. */
function GoalDetails({ run }: { run: GoalRun }) {
  const styles = useThemedStyles(createStyles)
  return (
    <View style={styles.details}>
      <View style={styles.line}>
        <Text style={styles.detailsStrong}>Goal: </Text>
        <Text style={styles.detailsText}>{run.goal}</Text>
      </View>
      {run.lastReport ? (
        <View style={styles.line}>
          <Text style={styles.detailsStrong}>Report ({run.lastReport.status}): </Text>
          <Text style={styles.detailsMuted}>{run.lastReport.summary}</Text>
        </View>
      ) : null}
      {run.history.length === 0 ? (
        <Text style={styles.detailsMuted}>No rounds reviewed yet.</Text>
      ) : (
        run.history.map((entry, index) => (
          <View key={`${entry.round}-${index}`} style={index > 0 ? styles.historyEntry : undefined}>
            <View style={styles.line}>
              <Text style={styles.detailsStrong}>Round {entry.round}: </Text>
              {entry.verdict?.approved ? (
                <Text style={styles.detailsApproved}>approved — {entry.verdict.reasoning}</Text>
              ) : (
                <Text style={styles.detailsMuted}>
                  rejected{entry.verdict?.reasoning ? ` — ${entry.verdict.reasoning}` : ""}
                </Text>
              )}
            </View>
            {entry.verdict && !entry.verdict.approved
              ? entry.verdict.requiredChanges.map((change) => (
                  <Text key={change} style={styles.detailsBullet}>
                    • {change}
                  </Text>
                ))
              : null}
            {entry.critique
              ? entry.critique.issues.map((issue, issueIndex) => (
                  <Text key={`${issue.claim}-${issueIndex}`} style={styles.detailsBullet}>
                    <Text style={styles.severity}>{issue.severity.toUpperCase()}</Text>: {issue.claim}
                  </Text>
                ))
              : null}
          </View>
        ))
      )}
    </View>
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
    round: {
      color: colors.textMuted,
      fontFamily: fonts.mono,
      fontSize: 11,
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
      minHeight: 44,
      justifyContent: "center",
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairlineStrong,
      backgroundColor: colors.surface,
      borderRadius: 8,
      paddingHorizontal: 14,
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
    error: {
      color: colors.danger,
      fontFamily: fonts.ui,
      fontSize: 11,
    },
    details: {
      gap: 6,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      backgroundColor: colors.surfaceMuted,
      borderRadius: 10,
      padding: 8,
    },
    line: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "baseline",
    },
    detailsText: {
      flexShrink: 1,
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 11,
      lineHeight: 15,
    },
    detailsStrong: {
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 11,
      lineHeight: 15,
      fontWeight: "600",
    },
    detailsMuted: {
      flexShrink: 1,
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 11,
      lineHeight: 15,
    },
    detailsApproved: {
      flexShrink: 1,
      color: colors.accent,
      fontFamily: fonts.ui,
      fontSize: 11,
      lineHeight: 15,
      fontWeight: "600",
    },
    detailsBullet: {
      marginLeft: 10,
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 11,
      lineHeight: 15,
    },
    severity: {
      color: colors.warning,
      fontWeight: "600",
    },
    historyEntry: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.hairline,
      paddingTop: 6,
    },
  })
}
