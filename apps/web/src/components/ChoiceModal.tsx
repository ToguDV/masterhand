import type { FormAnswer, FormInfo } from "@masterhand/client-core"
import { QuestionForm } from "./QuestionCard"
import { useModalFocus } from "./useModalFocus"

/**
 * A question raised by a session that is not the one on screen still needs an
 * answer, or its agent stays blocked invisibly. The choice-modal shows the
 * same content as the inline question card plus an "Open session" action; the
 * request is never a modal for the session currently on screen (DESIGN.md,
 * Overlays).
 */
export function ChoiceModal({
  form,
  busy,
  onRespond,
  onCancel,
  onOpenSession,
  onNotNow,
}: {
  form: FormInfo
  busy: boolean
  onRespond: (form: FormInfo, answer: FormAnswer) => void
  onCancel: (form: FormInfo) => void
  onOpenSession: () => void
  onNotNow: () => void
}) {
  const dialogRef = useModalFocus<HTMLDivElement>(onNotNow)

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center mh-overlay md:items-center md:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Question from another session"
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="mh-dialog max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-b-none p-0 outline-none md:rounded-xl [&>.mh-question]:border-0 [&>.mh-question]:bg-transparent"
      >
        <QuestionForm
          key={form.id}
          form={form}
          busy={busy}
          variant="modal"
          onRespond={onRespond}
          onCancel={onCancel}
        />
        <div className="flex flex-wrap gap-2 px-4 pb-4">
          <button type="button" className="mh-btn mh-btn--primary flex-1" onClick={onOpenSession}>
            Open session
          </button>
          <button type="button" className="mh-btn mh-btn--ghost" onClick={onNotNow}>
            Not now
          </button>
        </div>
      </div>
    </div>
  )
}
