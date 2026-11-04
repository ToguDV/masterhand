import { useMessages } from "@masterhand/client-core"
import { client } from "../client"
import { AssistantBlock } from "./MessageContent"
import { Skeleton, SkeletonStatus } from "./Skeleton"

/**
 * Temporary `/btw` side question: shows the answer streaming from a forked
 * session. The fork is discarded when the panel closes, so the main chat is
 * never touched.
 */
export function SideQuestionPanel({
  sessionID,
  question,
  connected,
  onClose,
}: {
  sessionID: string
  question: string
  connected: boolean
  onClose: () => void
}) {
  const messagesQuery = useMessages(client, sessionID, { connected, busy: true })
  const messages = messagesQuery.data ?? []
  const reply = [...messages].reverse().find((entry) => entry.info.role === "assistant")

  return (
    <div className="rounded-lg border border-hairline bg-surface p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="mh-micro shrink-0 text-ink-muted">Side question</span>
        <span className="min-w-0 flex-1 truncate text-xs text-ink-muted" title={question}>
          {question}
        </span>
        <button type="button" onClick={onClose} className="mh-btn mh-btn--secondary mh-btn--sm shrink-0">
          Close
        </button>
      </div>
      <div className="scroll-thin max-h-64 overflow-y-auto">
        {reply ? (
          <AssistantBlock entry={reply} />
        ) : (
          <>
            <SkeletonStatus label="Waiting for the side answer…" />
            <div
              className="flex min-h-[72px] flex-col gap-2 py-1"
              data-testid="side-question-skeleton"
              aria-hidden="true"
            >
              <Skeleton className="h-3.5 w-11/12" />
              <Skeleton className="h-3.5 w-4/5" />
              <Skeleton className="h-3.5 w-2/3" />
            </div>
          </>
        )}
      </div>
    </div>
  )
}
