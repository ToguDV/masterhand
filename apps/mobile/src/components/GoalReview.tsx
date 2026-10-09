import { useState } from "react"
import { Pressable, StyleSheet, Text, View } from "react-native"
import {
  goalActivityLabel,
  goalReviewRounds,
  goalStateLabel,
  isGoalActive,
  useGoalRun,
  type Client,
  type GoalCritique,
  type GoalReport,
  type GoalReviewRound,
  type GoalVerdict,
} from "@masterhand/client-core"
import { CheckIcon, SparkleIcon, StopIcon } from "./icons"
import { useTheme, useThemedStyles, type Fonts, type Palette } from "../theme"

/**
 * The agents' custom marker protocol (`<masterhand:goal|critique|verdict>`)
 * rendered as cards — inline where the marker appeared in a message and as the
 * per-round "Goal review" section in the thread. The internal critic/judge
 * sessions never list in the sidebar, so this is where their work is surfaced.
 */

/** Completion/blocked report emitted by the main agent's goal marker. */
export function GoalReportCard({ report }: { report: GoalReport }) {
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()
  const blocked = report.status === "blocked"
  return (
    <View style={[styles.report, blocked && styles.reportBlocked]} testID="goal-report">
      <View style={styles.reportHead}>
        {blocked ? (
          <StopIcon size={14} color={colors.warning} />
        ) : (
          <CheckIcon size={14} color={colors.accent} />
        )}
        <Text style={styles.title}>{blocked ? "Goal blocked" : "Goal completed"}</Text>
        <Text style={styles.reportSummary} numberOfLines={1}>
          {report.summary}
        </Text>
      </View>
      {blocked && report.reason ? <Text style={styles.evidence}>{report.reason}</Text> : null}
      {report.evidence.map((item, index) => (
        <View key={`${item}-${index}`} style={styles.evidenceRow}>
          <CheckIcon size={12} color={colors.accent} />
          <Text style={styles.evidence}>{item}</Text>
        </View>
      ))}
    </View>
  )
}

/** The critic's argument and its material issues. */
export function CritiqueCard({ critique }: { critique: GoalCritique }) {
  const [open, setOpen] = useState(false)
  const styles = useThemedStyles(createStyles)
  const summary =
    critique.issues.length === 0
      ? "No material issues found"
      : `${critique.issues.length} issue${critique.issues.length === 1 ? "" : "s"} raised`
  return (
    <View style={styles.markerCard} testID="goal-critique">
      <Pressable
        style={styles.markerHeader}
        onPress={() => setOpen((value) => !value)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
      >
        <Text style={styles.markerBadge}>CRITIC</Text>
        <Text style={styles.markerSummary} numberOfLines={1}>
          {summary}
        </Text>
        <Text style={styles.caption}>{open ? "▾" : "▸"}</Text>
      </Pressable>
      {open ? (
        <View style={styles.markerBody}>
          <CritiqueBody critique={critique} />
        </View>
      ) : null}
    </View>
  )
}

/** A judge marker found inline in an assistant message. */
export function VerdictCard({ verdict }: { verdict: GoalVerdict }) {
  const [open, setOpen] = useState(false)
  const styles = useThemedStyles(createStyles)
  return (
    <View style={styles.markerCard} testID="goal-verdict">
      <Pressable
        style={styles.markerHeader}
        onPress={() => setOpen((value) => !value)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
      >
        <Text style={styles.markerBadge}>JUDGE</Text>
        <Text style={styles.markerSummary} numberOfLines={1}>
          {verdict.reasoning || (verdict.approved ? "Approved" : "Changes requested")}
        </Text>
        <Text style={styles.caption}>{open ? "▾" : "▸"}</Text>
      </Pressable>
      {open ? (
        <View style={styles.markerBody}>
          <VerdictBody verdict={verdict} />
        </View>
      ) : null}
    </View>
  )
}

export function CritiqueBody({ critique }: { critique: GoalCritique }) {
  const styles = useThemedStyles(createStyles)
  return (
    <View style={styles.block}>
      <Text style={styles.blockTitle}>Critic's argument</Text>
      <Text style={styles.argument}>{critique.argument}</Text>
      {critique.issues.map((issue, index) => (
        <View key={`${issue.claim}-${index}`} style={styles.issue}>
          <Text style={[styles.severity, issue.severity === "low" && styles.severityLow]}>
            {issue.severity.toUpperCase()}
          </Text>
          <View style={styles.issueText}>
            <Text style={styles.issueClaim}>{issue.claim}</Text>
            {issue.evidence ? <Text style={styles.evidence}>{issue.evidence}</Text> : null}
          </View>
        </View>
      ))}
    </View>
  )
}

export function VerdictBody({ verdict }: { verdict: GoalVerdict }) {
  const styles = useThemedStyles(createStyles)
  return (
    <View style={styles.block}>
      <Text style={styles.blockTitle}>Judge's decision</Text>
      <Text style={[styles.verdictChip, verdict.approved ? styles.verdictApproved : styles.verdictRejected]}>
        {verdict.approved ? "Approved" : "Changes requested"}
      </Text>
      <Text style={styles.argument}>{verdict.reasoning}</Text>
      {verdict.requiredChanges.map((change) => (
        <Text key={change} style={styles.bullet}>
          • {change}
        </Text>
      ))}
    </View>
  )
}

function RoundCard({
  round,
  activity,
  open,
  onToggle,
}: {
  round: GoalReviewRound
  activity: string
  open: boolean
  onToggle: () => void
}) {
  const styles = useThemedStyles(createStyles)
  const label = round.verdict ? (round.verdict.approved ? "Approved" : "Changes requested") : "In review"
  const summary = round.verdict?.reasoning || round.critique?.argument || ""
  return (
    <View style={styles.round}>
      <Pressable
        style={styles.roundHeader}
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`Round ${round.round}`}
      >
        <Text style={styles.roundLabel}>Round {round.round}</Text>
        <Text
          style={[
            styles.roundChip,
            round.verdict?.approved && styles.roundChipApproved,
            round.verdict && !round.verdict.approved && styles.roundChipRejected,
          ]}
        >
          {label}
        </Text>
        <Text style={styles.roundSummary} numberOfLines={1}>
          {summary}
        </Text>
        <Text style={styles.caption}>{open ? "▾" : "▸"}</Text>
      </Pressable>
      {open ? (
        <View style={styles.roundBody}>
          {round.critique ? <CritiqueBody critique={round.critique} /> : null}
          {round.verdict ? <VerdictBody verdict={round.verdict} /> : null}
          {round.current && !round.verdict ? <Text style={styles.live}>{activity}…</Text> : null}
        </View>
      ) : null}
    </View>
  )
}

/** Per-round review history integrated in the chat thread. */
export function GoalReview({
  client,
  sessionID,
  onOpenSession,
}: {
  client: Client
  sessionID: string
  onOpenSession?: (id: string) => void
}) {
  const { data } = useGoalRun(client, sessionID)
  const [manual, setManual] = useState<Record<number, boolean>>({})
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()

  if (!data) return null

  const rounds = goalReviewRounds(data)
  const latest = rounds.at(-1)?.round
  const activity = goalActivityLabel(data)
  // Cancelling a run deletes its internal sessions, so their ids are stale.
  const internalGone = data.state === "cancelled"
  const criticSessionID = internalGone ? null : data.criticSessionID
  const judgeSessionID = internalGone ? null : data.judgeSessionID

  return (
    <View style={styles.container} accessibilityLabel="Goal review" testID="goal-review">
      <View style={styles.header}>
        <SparkleIcon size={14} color={isGoalActive(data.state) ? colors.accent : colors.textFaint} />
        <Text style={styles.title}>Goal review</Text>
        <Text
          style={[
            styles.stateChip,
            data.state === "approved" && styles.stateApproved,
            data.state === "error" && styles.stateError,
          ]}
        >
          {goalStateLabel(data.state)}
        </Text>
        <Text style={styles.caption}>
          Round {data.round}/{data.maxRounds}
        </Text>
      </View>
      {rounds.map((round) => {
        const open = manual[round.round] ?? round.round === latest
        return (
          <RoundCard
            key={round.round}
            round={round}
            activity={activity}
            open={open}
            onToggle={() =>
              setManual((current) => ({ ...current, [round.round]: !open }))
            }
          />
        )
      })}
      {onOpenSession && (criticSessionID || judgeSessionID) ? (
        <View style={styles.sessions}>
          {criticSessionID ? (
            <Pressable onPress={() => onOpenSession(criticSessionID)} hitSlop={4}>
              <Text style={styles.sessionLink}>Open critic session →</Text>
            </Pressable>
          ) : null}
          {judgeSessionID ? (
            <Pressable onPress={() => onOpenSession(judgeSessionID)} hitSlop={4}>
              <Text style={styles.sessionLink}>Open judge session →</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  )
}

function createStyles(colors: Palette, fonts: Fonts) {
  return StyleSheet.create({
    container: {
      gap: 10,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      backgroundColor: colors.surface,
      borderRadius: 14,
      padding: 12,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      flexWrap: "wrap",
    },
    title: {
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 13,
      fontWeight: "600",
    },
    stateChip: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 10,
      fontWeight: "700",
      letterSpacing: 0.4,
      textTransform: "uppercase",
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairlineStrong,
      borderRadius: 8,
      paddingHorizontal: 6,
      paddingVertical: 2,
      overflow: "hidden",
    },
    stateApproved: {
      color: colors.accent,
      borderColor: colors.accentLine,
    },
    stateError: {
      color: colors.danger,
      borderColor: colors.dangerLine,
    },
    caption: {
      color: colors.textFaint,
      fontFamily: fonts.ui,
      fontSize: 11,
    },
    sessions: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      gap: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.hairline,
      paddingTop: 10,
    },
    sessionLink: {
      color: colors.accent,
      fontFamily: fonts.ui,
      fontSize: 12,
      fontWeight: "600",
    },
    round: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.hairline,
      paddingTop: 8,
    },
    roundHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    roundLabel: {
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 12,
      fontWeight: "600",
    },
    roundChip: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 10,
      fontWeight: "700",
      textTransform: "uppercase",
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairlineStrong,
      borderRadius: 8,
      paddingHorizontal: 6,
      paddingVertical: 2,
      overflow: "hidden",
    },
    roundChipApproved: {
      color: colors.accent,
      borderColor: colors.accentLine,
    },
    roundChipRejected: {
      color: colors.warning,
      borderColor: colors.warningLine,
    },
    roundSummary: {
      flex: 1,
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 12,
    },
    roundBody: {
      gap: 12,
      paddingTop: 10,
    },
    block: {
      gap: 6,
    },
    blockTitle: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 10,
      fontWeight: "700",
      letterSpacing: 0.5,
      textTransform: "uppercase",
    },
    argument: {
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 13,
      lineHeight: 19,
    },
    issue: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      backgroundColor: colors.surfaceMuted,
      borderRadius: 10,
      paddingHorizontal: 8,
      paddingVertical: 6,
    },
    issueText: {
      flex: 1,
      gap: 2,
    },
    issueClaim: {
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 13,
    },
    severity: {
      color: colors.warning,
      fontFamily: fonts.ui,
      fontSize: 10,
      fontWeight: "700",
    },
    severityLow: {
      color: colors.textMuted,
    },
    evidence: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 12,
      lineHeight: 17,
    },
    verdictChip: {
      alignSelf: "flex-start",
      fontFamily: fonts.ui,
      fontSize: 10,
      fontWeight: "700",
      textTransform: "uppercase",
      borderRadius: 8,
      paddingHorizontal: 6,
      paddingVertical: 2,
      overflow: "hidden",
    },
    verdictApproved: {
      color: colors.accent,
      backgroundColor: colors.accentSoft,
    },
    verdictRejected: {
      color: colors.warning,
      backgroundColor: colors.warningSoft,
    },
    bullet: {
      marginLeft: 10,
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 12,
      lineHeight: 17,
    },
    live: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 12,
      fontStyle: "italic",
    },
    report: {
      gap: 6,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      borderLeftWidth: 3,
      borderLeftColor: colors.accent,
      backgroundColor: colors.surface,
      borderRadius: 12,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    reportBlocked: {
      borderLeftColor: colors.warning,
    },
    reportHead: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    reportSummary: {
      flex: 1,
      color: colors.textSoft,
      fontFamily: fonts.ui,
      fontSize: 13,
    },
    evidenceRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 6,
    },
    markerCard: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      borderRadius: 14,
      backgroundColor: colors.surface,
      overflow: "hidden",
    },
    markerHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 10,
      paddingVertical: 8,
    },
    markerBadge: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 10,
      fontWeight: "700",
      letterSpacing: 0.5,
    },
    markerSummary: {
      flex: 1,
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 12,
    },
    markerBody: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.hairline,
      padding: 10,
    },
  })
}
