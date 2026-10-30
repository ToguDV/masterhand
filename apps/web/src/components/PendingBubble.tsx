import type { PendingSend } from "@masterhand/client-core"

/**
 * Ghost user bubble for a plain prompt awaiting delivery confirmation (#125).
 * Same geometry as the real bubble, dimmed, with a "Sending…" caption; on a
 * hard failure it becomes a retryable error state. The real bubble replaces it
 * in the same render the marker appears in the history (the container's
 * `usePendingSend` clears the ghost then).
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
  const failed = pending.status === "failed"
  const attachments = pending.attachments ?? []
  const body =
    pending.text.trim() ||
    (attachments.length === 1 ? attachments[0]?.name : `${attachments.length} attachments`)

  return (
    <div
      className="mh-pending"
      aria-label={failed ? "Message failed to send" : "Sending message"}
    >
      <div className={`mh-msg--user mh-msg--pending${failed ? " is-failed" : ""}`} aria-hidden="true">
        {body}
        {attachments.length > 0 && pending.text.trim() ? (
          <span className="mh-pending__files">
            {attachments.length} attachment{attachments.length === 1 ? "" : "s"}
          </span>
        ) : null}
      </div>
      <p className="mh-pending__caption" role="status" aria-live="polite">
        {failed ? (
          <>
            <span className="text-danger">Failed to send</span>
            <button type="button" className="mh-btn mh-btn--sm mh-btn--secondary" onClick={onRetry}>
              Retry
            </button>
            <button type="button" className="mh-btn mh-btn--sm mh-btn--ghost" onClick={onDismiss}>
              Dismiss
            </button>
          </>
        ) : (
          <>
            <span className="mh-ellipsis" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            Sending…
          </>
        )}
      </p>
    </div>
  )
}
