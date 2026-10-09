import { useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  goalErrorMessage,
  goalResultLine,
  goalStateLabel,
  isGoalActive,
  queryKeys,
  useGoalRun,
} from "@masterhand/client-core"
import { client } from "../client"
import { PauseIcon, PlayIcon, SparkleIcon, StopIcon } from "./icons"

/**
 * Goal Mode control strip: one subtle line above the composer with the loop
 * phase, round and last review result, plus pause/resume/cancel actions styled
 * like the rest of the interface. The run state is SSE-driven (`goal.updated`
 * frames); mutations reconcile it by refetching, and a timeout is reported as
 * "may have changed". The review history itself lives in the thread (GoalReview).
 */
export function GoalStrip({ sessionID }: { sessionID: string }) {
  const queryClient = useQueryClient()
  const { data } = useGoalRun(client, sessionID)
  const [busy, setBusy] = useState(false)
  // Synchronous in-flight guard: a state flag is not a lock (rule 7).
  const busyRef = useRef(false)
  const [error, setError] = useState<string | null>(null)

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
      await queryClient.invalidateQueries({ queryKey: queryKeys.goal(sessionID) })
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const tone = data.state === "error" ? "text-danger" : data.state === "approved" ? "text-accent" : "text-ink"

  return (
    <div className="border-t border-hairline px-3 py-1.5 md:px-6" data-testid="goal-strip">
      <div className="mh-chat-col flex flex-wrap items-center gap-2 text-xs">
        <SparkleIcon size={13} className={active ? "shrink-0 text-accent" : "shrink-0 text-ink-muted"} />
        {/* Only the state announces: the activity note changes per event and
            would otherwise re-read the whole strip (buttons included). */}
        <span role="status" className={`font-medium ${tone}`}>
          {goalStateLabel(data.state)}
        </span>
        <span className="mh-chip mh-chip--outline mh-chip--mono">
          round {data.round}/{data.maxRounds}
        </span>
        {data.lastError && active ? (
          <span className="min-w-0 truncate text-warning" title={data.lastError}>
            {data.lastError}
          </span>
        ) : result ? (
          <span className="min-w-0 truncate text-ink-muted" title={result}>
            {result}
          </span>
        ) : null}
        <span className="min-w-0 flex-1" />
        {active && (
          <>
            <button
              type="button"
              className="mh-btn mh-btn--secondary mh-btn--sm"
              disabled={busy}
              onClick={() => void act(() => client.api.goal.pause(sessionID))}
            >
              <PauseIcon size={14} />
              Pause
            </button>
            <button
              type="button"
              className="mh-btn mh-btn--danger mh-btn--sm"
              disabled={busy}
              onClick={() => void act(() => client.api.goal.cancel(sessionID))}
            >
              <StopIcon size={14} />
              Cancel
            </button>
          </>
        )}
        {resumable && (
          <>
            <button
              type="button"
              className="mh-btn mh-btn--primary mh-btn--sm"
              disabled={busy}
              onClick={() => void act(() => client.api.goal.resume(sessionID))}
            >
              <PlayIcon size={14} />
              {data.state === "paused" ? "Resume" : "Retry"}
            </button>
            <button
              type="button"
              className="mh-btn mh-btn--danger mh-btn--sm"
              disabled={busy}
              onClick={() => void act(() => client.api.goal.cancel(sessionID))}
            >
              <StopIcon size={14} />
              Cancel
            </button>
          </>
        )}
      </div>
      {(error || data.error) && (
        <p className="mh-chat-col mt-1 text-[11px] text-danger">{error ?? data.error}</p>
      )}
    </div>
  )
}
