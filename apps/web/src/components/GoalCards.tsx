import { useState, type ReactNode } from "react"
import {
  goalActivityLabel,
  goalReviewRounds,
  goalStateLabel,
  isGoalActive,
  useGoalRun,
  type GoalCritique,
  type GoalIssue,
  type GoalReport,
  type GoalReviewRound,
  type GoalRun,
  type GoalState,
  type GoalVerdict,
} from "@masterhand/client-core"
import { client } from "../client"
import { CheckIcon, ChevronDownIcon, SparkleIcon, StopIcon } from "./icons"

/**
 * The agents' custom marker protocol (`<masterhand:goal|critique|verdict>`)
 * rendered as cards — both inline where the marker appeared in a message and
 * as the per-round "Goal review" section integrated in the main thread. The
 * internal critic/judge sessions never list in the sidebar, so this is where
 * their work is surfaced.
 */

function Chevron({ open }: { open: boolean }) {
  return <ChevronDownIcon size={14} className={`mh-goal__chevron shrink-0 ${open ? "is-open" : ""}`} />
}

function SeverityChip({ severity }: { severity: GoalIssue["severity"] }) {
  return <span className={`mh-chip ${severity === "low" ? "" : "mh-chip--warning"}`}>{severity}</span>
}

function StateChip({ state }: { state: GoalState }) {
  const tone =
    state === "approved" ? "mh-chip--accent" : state === "error" ? "mh-chip--warning" : ""
  return <span className={`mh-chip ${tone}`}>{goalStateLabel(state)}</span>
}

/** The critic's argument and its material issues. */
export function CritiqueBody({ critique }: { critique: GoalCritique }) {
  return (
    <div className="mh-goal__block">
      <p className="mh-goal__block-title">Critic's argument</p>
      <p className="mh-goal__argument">{critique.argument}</p>
      {critique.issues.length > 0 && (
        <ul className="mh-goal__issues">
          {critique.issues.map((issue, index) => (
            <li key={`${issue.claim}-${index}`} className="mh-goal__issue">
              <SeverityChip severity={issue.severity} />
              <span className="min-w-0 flex-1">
                <span className="block text-ink">{issue.claim}</span>
                {issue.evidence && <span className="mh-goal__evidence">{issue.evidence}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** The judge's decision and the concrete changes it requires. */
export function VerdictBody({ verdict }: { verdict: GoalVerdict }) {
  return (
    <div className="mh-goal__block">
      <p className="mh-goal__block-title">Judge's decision</p>
      <p className="mh-goal__argument">
        <span className={`mh-chip ${verdict.approved ? "mh-chip--accent" : "mh-chip--warning"}`}>
          {verdict.approved ? "Approved" : "Changes requested"}
        </span>{" "}
        {verdict.reasoning}
      </p>
      {verdict.requiredChanges.length > 0 && (
        <ul className="mh-goal__changes">
          {verdict.requiredChanges.map((change) => (
            <li key={change}>{change}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Completion/blocked report emitted by the main agent's goal marker. */
export function GoalReportCard({ report }: { report: GoalReport }) {
  const blocked = report.status === "blocked"
  return (
    <div className={`mh-goal__report ${blocked ? "is-blocked" : ""}`} data-testid="goal-report">
      <p className="mh-goal__report-head">
        {blocked ? (
          <StopIcon size={14} className="shrink-0 text-warning" />
        ) : (
          <CheckIcon size={14} className="shrink-0 text-accent" />
        )}
        <span className="mh-goal__title">{blocked ? "Goal blocked" : "Goal completed"}</span>
        <span className="mh-goal__report-summary">{report.summary}</span>
      </p>
      {blocked && report.reason && <p className="mh-goal__evidence">{report.reason}</p>}
      {report.evidence.length > 0 && (
        <ul className="mh-goal__evidence-list">
          {report.evidence.map((item, index) => (
            <li key={`${item}-${index}`}>
              <CheckIcon size={12} className="shrink-0 text-accent" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function MarkerCard({
  label,
  summary,
  testId,
  children,
}: {
  label: string
  summary: string
  testId: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`mh-tool ${open ? "is-open" : ""}`} data-testid={testId}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="mh-tool__header hover:bg-surface-muted"
      >
        <span className="mh-chip mh-chip--outline">{label}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-ink-muted">{summary}</span>
        <Chevron open={open} />
      </button>
      {open && <div className="mh-reveal mh-tool__body border-t border-hairline pt-2">{children}</div>}
    </div>
  )
}

/** A critic marker found inline in an assistant message. */
export function CritiqueCard({ critique }: { critique: GoalCritique }) {
  const summary =
    critique.issues.length === 0
      ? "No material issues found"
      : `${critique.issues.length} issue${critique.issues.length === 1 ? "" : "s"} raised`
  return (
    <MarkerCard label="Critic" summary={summary} testId="goal-critique">
      <CritiqueBody critique={critique} />
    </MarkerCard>
  )
}

/** A judge marker found inline in an assistant message. */
export function VerdictCard({ verdict }: { verdict: GoalVerdict }) {
  return (
    <MarkerCard
      label="Judge"
      summary={verdict.reasoning || (verdict.approved ? "Approved" : "Changes requested")}
      testId="goal-verdict"
    >
      <VerdictBody verdict={verdict} />
    </MarkerCard>
  )
}

function RoundCard({
  round,
  activity,
  active,
  open,
  onToggle,
}: {
  round: GoalReviewRound
  activity: string
  /** Whether the loop is live (the pulsing dot would lie on a paused run). */
  active: boolean
  open: boolean
  onToggle: () => void
}) {
  const state = round.verdict ? (round.verdict.approved ? "Approved" : "Changes requested") : "In review"
  const tone = round.verdict ? (round.verdict.approved ? "mh-chip--accent" : "mh-chip--warning") : ""
  const summary = round.verdict?.reasoning || round.critique?.argument || ""
  return (
    <article className={`mh-goal__round ${open ? "is-open" : ""}`}>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="mh-goal__round-header"
      >
        <span className="mh-goal__round-label">Round {round.round}</span>
        <span className={`mh-chip ${tone}`}>{state}</span>
        {round.current && !round.verdict && <span className="mh-dot mh-dot--busy shrink-0" />}
        <span className="mh-goal__round-summary">{summary}</span>
        <Chevron open={open} />
      </button>
      {open && (
        <div className="mh-goal__body">
          {round.critique && <CritiqueBody critique={round.critique} />}
          {round.verdict && <VerdictBody verdict={round.verdict} />}
          {round.current && !round.verdict && (
            <p className="mh-goal__live">
              <span className={`mh-dot shrink-0 ${active ? "mh-dot--busy" : ""}`} />
              {activity}
            </p>
          )}
        </div>
      )}
    </article>
  )
}

/**
 * Per-round review history integrated in the main session thread. The latest
 * round is expanded by default; older rounds collapse to one line.
 */
export function GoalReview({ sessionID }: { sessionID: string }) {
  const run: GoalRun | null = useGoalRun(client, sessionID).data ?? null
  const [manual, setManual] = useState<Record<number, boolean>>({})
  if (!run) return null

  const rounds = goalReviewRounds(run)
  const latest = rounds.at(-1)?.round
  const active = isGoalActive(run.state)
  const activity = goalActivityLabel(run)

  return (
    <section className="mh-goal" aria-label="Goal review" data-testid="goal-review">
      <header className="mh-goal__header">
        <SparkleIcon size={14} className={active ? "shrink-0 text-accent" : "shrink-0 text-ink-faint"} />
        <h3 className="mh-goal__title">Goal review</h3>
        <StateChip state={run.state} />
        <span className="text-xs text-ink-faint">
          Round {run.round}/{run.maxRounds}
        </span>
        <span className="min-w-0 flex-1" />
        {active && (
          <span className="mh-goal__live min-w-0">
            <span className="mh-dot mh-dot--busy shrink-0" />
            <span className="truncate">{activity}</span>
          </span>
        )}
      </header>
      {rounds.map((round) => {
        const open = manual[round.round] ?? round.round === latest
        return (
          <RoundCard
            key={round.round}
            round={round}
            activity={activity}
            active={active}
            open={open}
            onToggle={() => setManual((current) => ({ ...current, [round.round]: !open }))}
          />
        )
      })}
    </section>
  )
}
