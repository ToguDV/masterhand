import { useState } from "react"
import { ApiError, type CreateWorkspaceInput } from "@masterhand/client-core"
import { useModalFocus } from "./useModalFocus"

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409) return "That workspace already exists"
    if (error.status === 400) return "Enter a valid folder name (no slashes or leading dots)"
  }
  return "Could not add the workspace"
}

export function AddWorkspaceDialog({
  onSubmit,
  onClose,
}: {
  onSubmit: (input: CreateWorkspaceInput) => Promise<void>
  onClose: () => void
}) {
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useModalFocus<HTMLFormElement>(onClose)

  async function submit(): Promise<void> {
    const trimmed = name.trim()
    if (!trimmed || busy) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit({ name: trimmed })
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center mh-overlay md:items-center md:p-4">
      <form
        ref={dialogRef}
        tabIndex={-1}
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
        className="pb-safe mh-dialog w-full rounded-b-none outline-none md:rounded-xl"
      >
        <h3 className="mh-dialog__title mh-heading-4">Add workspace</h3>
        <p className="mh-body-sm text-ink-muted">
          A new folder with this name is created inside the workspaces root, isolated from the others.
        </p>

        <div className="mt-4">
          <label className="mh-label" htmlFor="workspace-name">
            Name
          </label>
          <input
            id="workspace-name"
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="my-project"
            className="mh-input"
          />
        </div>

        {error && <p className="mt-2 text-xs text-danger">{error}</p>}

        <div className="mh-dialog__actions">
          <button type="button" onClick={onClose} disabled={busy} className="mh-btn mh-btn--secondary">
            Cancel
          </button>
          <button type="submit" disabled={!name.trim() || busy} className="mh-btn mh-btn--primary">
            {busy ? "Adding…" : "Add"}
          </button>
        </div>
      </form>
    </div>
  )
}
