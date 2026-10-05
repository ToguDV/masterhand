import { useModalFocus } from "./useModalFocus"

export function RemoveSessionDialog({
  name,
  busy,
  onConfirm,
  onClose,
}: {
  name: string
  busy: boolean
  onConfirm: () => Promise<void>
  onClose: () => void
}) {
  const dialogRef = useModalFocus<HTMLDivElement>(onClose)

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center mh-overlay md:items-center md:p-4">
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="pb-safe mh-dialog w-full rounded-b-none outline-none md:rounded-xl"
      >
        <h3 className="mh-dialog__title mh-heading-4">Delete session</h3>
        <p className="mh-body-sm text-ink-muted">
          Delete <span className="font-medium text-ink">{name}</span> and all its data? This cannot be undone.
        </p>

        <div className="mh-dialog__actions">
          <button type="button" onClick={onClose} disabled={busy} className="mh-btn mh-btn--secondary">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void onConfirm()}
            disabled={busy}
            className="mh-btn mh-btn--danger"
          >
            {busy ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>
    </div>
  )
}
