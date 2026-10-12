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
import { ChevronDownIcon, PauseIcon, PlayIcon, SparkleIcon, StopIcon } from "./icons"

/**
 * Goal Mode fold: a single compact bar pinned to the top of the chat,
 * outside the transcript. Collapsed it shows only the live phase and the
 * round; expanding reveals the last result, the actions and any error.
 * Returns null when the session has no run.
 */
export function GoalStrip({ sessionID }: { sessionID: string }) {
  const queryClient = useQueryClient()
  const { data } = useGoalRun(client, sessionID)
  const [open, setOpen] = useState(false)
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
    <div data-testid="goal-strip" className="border-b border-hairline bg-surface">
      <div className="mh-chat-col">
        <button
          type="button"
          data-testid="goal-fold-toggle"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="flex w-full cursor-pointer items-center gap-2 py-1.5 text-xs outline-none"
        >
          <SparkleIcon size={13} className={active ? "shrink-0 text-accent" : "shrink-0 text-ink-muted"} />
          {/* Only the state announces: the activity note changes per event and
              would otherwise re-read the whole fold (buttons included). */}
          <span role="status" className={`font-medium ${tone}`}>
            {goalStateLabel(data.state)}
          </span>
          <span className="mh-chip mh-chip--outline mh-chip--mono">
            round {data.round}/{data.maxRounds}
          </span>
          <span className="min-w-0 flex-1" />
          <ChevronDownIcon size={14} className={`shrink-0 text-ink-muted transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
        {open && (
          <div className="flex flex-wrap items-center gap-2 pb-2 text-xs">
            {data.lastError && active ? (
              <span className="min-w-0 flex-1 truncate text-warning" title={data.lastError}>
                {data.lastError}
              </span>
            ) : result ? (
              <span className="min-w-0 flex-1 truncate text-ink-muted" title={result}>
                {result}
              </span>
            ) : (
              <span className="min-w-0 flex-1" />
            )}
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
        )}
      </div>
      {(open && (error || data.error)) && (
        <p className="mh-chat-col pb-2 text-[11px] text-danger">{error ?? data.error}</p>
      )}
    </div>
  )
}
