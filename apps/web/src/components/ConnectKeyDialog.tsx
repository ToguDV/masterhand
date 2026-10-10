import { useState, type FormEvent } from "react"
import { providerConnectErrorMessage } from "@masterhand/client-core"
import { client } from "../client"
import { useModalFocus } from "./useModalFocus"

/**
 * Write-only API key dialog shared by Settings > Providers and Settings > Web
 * search: the value lives in this component's state and is never pre-filled or
 * read back; it goes straight to opencode through the BFF, and MasterHand never
 * stores a copy.
 */
export function ConnectKeyDialog({
  integrationID,
  name,
  onClose,
  onConnected,
}: {
  integrationID: string
  name: string
  onClose: () => void
  onConnected: () => Promise<void>
}) {
  const dialogRef = useModalFocus<HTMLDivElement>(onClose)
  const [key, setKey] = useState("")
  const [label, setLabel] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (!key.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      // Write-only: the value lives in this component's state and is never
      // pre-filled or read back; connecting twice is not auto-retried.
      await client.api.connectIntegrationKey(integrationID, {
        key: key.trim(),
        ...(label.trim() ? { label: label.trim() } : {}),
      })
      setKey("")
      setLabel("")
      await onConnected()
    } catch (err) {
      setError(providerConnectErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center mh-overlay md:items-center md:p-4">
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="pb-safe mh-dialog w-full rounded-b-none outline-none md:rounded-xl"
        role="dialog"
        aria-modal="true"
        aria-label={`Connect ${name}`}
      >
        <h3 className="mh-dialog__title mh-heading-4">Connect {name}</h3>
        <p className="mh-body-sm text-ink-muted">
          The key goes straight to opencode and stays in its data volume. MasterHand never stores a copy.
        </p>
        <form onSubmit={(event) => void submit(event)} className="mt-3 flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs text-ink-muted">
            API key
            <input
              type="password"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder="sk-…"
              aria-label="API key"
              className="mh-input"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-muted">
            Label (optional)
            <input
              type="text"
              autoComplete="off"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="Personal"
              aria-label="Key label"
              className="mh-input"
            />
          </label>
          {error && <p className="text-xs text-danger">{error}</p>}
          <div className="mh-dialog__actions">
            <button type="button" onClick={onClose} disabled={busy} className="mh-btn mh-btn--secondary">
              Cancel
            </button>
            <button type="submit" disabled={!key.trim() || busy} className="mh-btn mh-btn--primary">
              {busy ? "Connecting…" : "Connect"}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
