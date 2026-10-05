import { useRef, useState, type ReactNode } from "react"
import type { WorkspaceRecord } from "@masterhand/client-core"
import { WorkspacePicker } from "./WorkspacePicker"
import { useDismissable } from "./useDismissable"
import { ChevronDownIcon, PlusIcon } from "./icons"

/**
 * The composer's top bar: workspace switching plus the new-session action
 * (with the isolated worktree option in its popover), and an optional trailing
 * slot (the session stats). The sidebar no longer hosts any of this.
 */
export function SessionToolbar({
  workspaces,
  workspaceID,
  onSelectWorkspace,
  onAddWorkspace,
  onRemoveWorkspace,
  onCreateSession,
  creating,
  trailing,
}: {
  workspaces: WorkspaceRecord[]
  workspaceID: string | null
  onSelectWorkspace: (id: string | null) => void
  onAddWorkspace: () => void
  onRemoveWorkspace: (id: string) => void
  onCreateSession: (isolated: boolean) => void
  creating: boolean
  trailing?: ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <WorkspacePicker
        workspaces={workspaces}
        selectedID={workspaceID}
        onSelect={onSelectWorkspace}
        onAdd={onAddWorkspace}
        onDelete={onRemoveWorkspace}
      />
      <NewSessionMenu
        onCreate={onCreateSession}
        creating={creating}
        disabled={workspaces.length === 0}
      />
      {trailing ? <div className="ml-auto flex min-w-0 items-center">{trailing}</div> : null}
    </div>
  )
}

function NewSessionMenu({
  onCreate,
  creating,
  disabled,
}: {
  onCreate: (isolated: boolean) => void
  creating: boolean
  disabled: boolean
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
        className="mh-btn mh-btn--primary mh-btn--sm"
      >
        <PlusIcon size={14} />
        {creating ? "Creating…" : "New session"}
        <ChevronDownIcon size={14} className="opacity-80" />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="New session"
          className="absolute bottom-full left-0 z-30 mb-2 w-72 max-w-[85vw] rounded-md border border-hairline bg-surface p-2.5 shadow-elev3"
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
