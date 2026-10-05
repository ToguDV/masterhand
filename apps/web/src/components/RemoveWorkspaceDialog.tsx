import { useState } from "react"
import { useModalFocus } from "./useModalFocus"

export function RemoveWorkspaceDialog({
  name,
  busy,
  onConfirm,
  onClose,
}: {
  name: string
  busy: boolean
  onConfirm: (deleteFiles: boolean) => Promise<void>
  onClose: () => void
}) {
  const [deleteFiles, setDeleteFiles] = useState(false)
  const dialogRef = useModalFocus<HTMLDivElement>(onClose)

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center mh-overlay md:items-center md:p-4">
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="pb-safe mh-dialog w-full rounded-b-none outline-none md:rounded-xl"
      >
        <h3 className="mh-dialog__title mh-heading-4">Remove workspace</h3>
        <p className="mh-body-sm text-ink-muted">
          Remove <span className="font-medium text-ink">{name}</span> from MasterHand. Sessions are kept.
        </p>

        <label className="mt-4 flex items-start gap-2 rounded-md border border-hairline-strong p-3">
          <input
            type="checkbox"
            checked={deleteFiles}
            onChange={(event) => setDeleteFiles(event.target.checked)}
            className="mt-0.5 h-4 w-4 accent-[var(--mh-danger)]"
          />
          <span className="text-xs text-ink-soft">
            Also delete its folder and all files from disk. This cannot be undone.
          </span>
        </label>

        <div className="mh-dialog__actions">
          <button type="button" onClick={onClose} disabled={busy} className="mh-btn mh-btn--secondary">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void onConfirm(deleteFiles)}
            disabled={busy}
            className="mh-btn mh-btn--danger"
          >
            {busy ? "Removing…" : "Remove"}
          </button>
        </div>
      </div>
    </div>
  )
}
