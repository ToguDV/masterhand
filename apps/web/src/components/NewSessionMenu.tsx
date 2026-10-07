import { useRef, useState } from "react"
import { useDismissable } from "./useDismissable"
import { PlusIcon } from "./icons"

/**
 * The Sessions header's new-session action: a `+` icon that opens a popover
 * with the isolated-worktree option and the create action.
 */
export function NewSessionMenu({
  onCreate,
  creating,
  disabled,
  popoverClassName = "",
}: {
  onCreate: (isolated: boolean) => void
  creating: boolean
  disabled: boolean
  /** Extra positioning for the popover (the collapsed rail opens it beside the button). */
  popoverClassName?: string
}) {
  const [open, setOpen] = useState(false)
  const [isolated, setIsolated] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const close = () => {
    setOpen(false)
    setIsolated(false)
  }
  useDismissable(open, rootRef, close)

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={disabled || creating}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="New session"
        title={disabled ? "Add a workspace first" : "Create a session"}
        className="mh-btn mh-btn--primary mh-btn--sm px-2.5"
      >
        <PlusIcon size={16} />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="New session"
          className={`absolute z-30 w-64 max-w-[85vw] rounded-md border border-hairline bg-surface p-2.5 shadow-elev3 ${popoverClassName || "right-0 top-full mt-2"}`}
        >
          <label className="flex cursor-pointer items-start gap-2 rounded-sm px-1.5 py-1.5 text-sm hover:bg-surface-muted">
            <input
              type="checkbox"
              checked={isolated}
              onChange={(event) => setIsolated(event.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 accent-[var(--mh-accent)]"
            />
            <span className="min-w-0">
              <span className="block text-ink">Isolated session</span>
              <span className="block text-xs text-ink-muted">
                Runs in its own git worktree and branch
              </span>
            </span>
          </label>
          <button
            type="button"
            onClick={() => {
              onCreate(isolated)
              close()
            }}
            className="mh-btn mh-btn--primary mh-btn--sm mt-2 w-full"
          >
            Create session
          </button>
        </div>
      )}
    </div>
  )
}
