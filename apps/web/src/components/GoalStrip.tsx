import { useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  goalErrorMessage,
  goalResultLine,
  goalStateLabel,
  isGoalActive,
  queryKeys,
  useGoalRun,
  type GoalRun,
} from "@masterhand/client-core"
import { client } from "../client"
import { SparkleIcon } from "./icons"

/**
 * Goal Mode status strip: one subtle line above the composer with the loop
 * phase, round and last review result, plus pause/resume/cancel/retry actions.
 * The run state is SSE-driven (`goal.updated` frames); mutations reconcile it
 * by refetching, and a timeout is reported as "may have changed".
 */
export function GoalStrip({ sessionID }: { sessionID: string }) {
  const queryClient = useQueryClient()
  const { data } = useGoalRun(client, sessionID)
  const [busy, setBusy] = useState(false)
  // Synchronous in-flight guard: a state flag is not a lock (rule 7).
  const busyRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

  if (!data) return null

  const active = isGoalActive(data.state)
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
      await queryClient.invalidateQueries({ queryKey: queryKeys.goal(sessionID) })
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const tone = data.state === "error" ? "text-danger" : data.state === "approved" ? "text-accent" : "text-ink"

  return (
    <div className="border-t border-hairline px-3 py-1.5 md:px-6">
      <div className="mh-chat-col flex items-center gap-2 text-xs">
        <SparkleIcon size={13} className={active ? "shrink-0 text-accent" : "shrink-0 text-ink-muted"} />
        <span className={`font-medium ${tone}`}>{goalStateLabel(data.state)}</span>
        <span className="text-ink-muted">
          round {data.round}/{data.maxRounds}
        </span>
        {data.lastError && active ? (
          <span className="truncate text-warning" title={data.lastError}>
            {data.lastError}
          </span>
        ) : result ? (
          <span className="truncate text-ink-muted" title={result}>
            {result}
          </span>
        ) : null}
        <span className="min-w-0 flex-1" />
        {!busy && active && (
          <>
            <button
              type="button"
              className="mh-btn mh-btn--quiet mh-btn--sm"
              onClick={() => void act(() => client.api.goal.pause(sessionID))}
            >
              Pause
            </button>
            <button
              type="button"
              className="mh-btn mh-btn--quiet mh-btn--sm text-danger"
              onClick={() => void act(() => client.api.goal.cancel(sessionID))}
            >
              Cancel
            </button>
          </>
        )}
        {!busy && (data.state === "paused" || data.state === "error") && (
          <>
            <button
              type="button"
              className="mh-btn mh-btn--secondary mh-btn--sm"
              onClick={() => void act(() => client.api.goal.resume(sessionID))}
            >
              {data.state === "paused" ? "Resume" : "Retry"}
            </button>
            <button
              type="button"
              className="mh-btn mh-btn--quiet mh-btn--sm text-danger"
              onClick={() => void act(() => client.api.goal.cancel(sessionID))}
            >
              Cancel
            </button>
          </>
        )}
        <button
          type="button"
          className="mh-btn mh-btn--quiet mh-btn--sm"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "Hide" : "Details"}
        </button>
      </div>
      {error && <p className="mh-chat-col mt-1 text-[11px] text-danger">{error}</p>}
      {data.error && <p className="mh-chat-col mt-1 text-[11px] text-danger">{data.error}</p>}
      {expanded && <GoalDetails run={data} />}
    </div>
  )
}

function GoalDetails({ run }: { run: GoalRun }) {
  return (
    <div className="mh-chat-col mt-2 space-y-2 rounded-lg border border-hairline bg-surface p-2 text-[11px]">
      <p className="text-ink">
        <span className="font-medium">Goal: </span>
        {run.goal}
      </p>
      {run.lastReport && (
        <p className="text-ink-muted">
          <span className="font-medium text-ink">Report ({run.lastReport.status}): </span>
          {run.lastReport.summary}
        </p>
      )}
      {run.history.length === 0 ? (
        <p className="text-ink-muted">No rounds reviewed yet.</p>
      ) : (
        <ol className="space-y-1.5">
          {run.history.map((entry, index) => (
            <li key={`${entry.round}-${index}`} className="border-t border-hairline pt-1.5 first:border-0 first:pt-0">
              <span className="font-medium text-ink">Round {entry.round}: </span>
              {entry.verdict?.approved ? (
                <span className="text-accent">approved — {entry.verdict.reasoning}</span>
              ) : (
                <span className="text-ink-muted">
                  rejected{entry.verdict?.reasoning ? ` — ${entry.verdict.reasoning}` : ""}
                </span>
              )}
              {entry.verdict && !entry.verdict.approved && entry.verdict.requiredChanges.length > 0 && (
                <ul className="ml-4 list-disc text-ink-muted">
                  {entry.verdict.requiredChanges.map((change) => (
                    <li key={change}>{change}</li>
                  ))}
                </ul>
              )}
              {entry.critique && entry.critique.issues.length > 0 && (
                <ul className="ml-4 list-disc text-ink-muted">
                  {entry.critique.issues.map((issue, issueIndex) => (
                    <li key={`${issue.claim}-${issueIndex}`}>
                      <span className="uppercase">{issue.severity}</span>: {issue.claim}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
