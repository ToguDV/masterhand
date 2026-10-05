import { useRef, useState } from "react"
import type { WorkspaceRecord } from "@masterhand/client-core"
import { useDismissable } from "./useDismissable"
import { CheckIcon, ChevronDownIcon, FolderIcon, PlusIcon, TrashIcon } from "./icons"

/**
 * Condensed workspace switcher (composer bar): one trigger showing the current
 * workspace and a popover with the list plus the add/remove management actions.
 */
export function WorkspacePicker({
  workspaces,
  selectedID,
  onSelect,
  onAdd,
  onDelete,
}: {
  workspaces: WorkspaceRecord[]
  selectedID: string | null
  onSelect: (id: string | null) => void
  onAdd: () => void
  onDelete: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  useDismissable(open, rootRef, () => setOpen(false))
  const selected = workspaces.find((workspace) => workspace.id === selectedID) ?? null

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Workspace"
        title={selected?.path ?? "Choose a workspace"}
        className="flex min-w-0 max-w-[16rem] cursor-pointer items-center gap-1.5 rounded-sm border border-hairline-strong bg-surface px-2.5 py-1.5 text-sm outline-none transition-colors hover:bg-surface-muted focus-visible:border-accent"
      >
        <FolderIcon className="h-4 w-4 shrink-0 text-ink-muted" />
        <span className={`truncate ${selected ? "text-ink" : "text-ink-muted"}`}>
          {selected?.name ?? "No workspace"}
        </span>
        <ChevronDownIcon size={14} className="shrink-0 text-ink-muted" />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Workspace"
          className="absolute bottom-full left-0 z-30 mb-2 max-h-[70vh] w-72 max-w-[85vw] overflow-y-auto rounded-md border border-hairline bg-surface p-1.5 shadow-elev3 scroll-thin"
        >
          <p className="px-2 py-1 text-[10px] uppercase tracking-wide text-ink-faint">Workspaces</p>
          {workspaces.length === 0 && (
            <p className="px-2 py-2 text-xs text-ink-muted">No workspaces yet.</p>
          )}
          {workspaces.map((workspace) => (
            <button
              key={workspace.id}
              type="button"
              role="menuitemradio"
              aria-checked={workspace.id === selectedID}
              title={workspace.path}
              onClick={() => {
                onSelect(workspace.id)
                setOpen(false)
              }}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-ink-soft hover:bg-surface-muted"
            >
              <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
              {workspace.id === selectedID && <CheckIcon size={14} className="shrink-0 text-accent" />}
            </button>
          ))}

          <div className="my-1 h-px bg-hairline" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              onAdd()
            }}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-ink-soft hover:bg-surface-muted"
          >
            <PlusIcon size={14} className="shrink-0 text-ink-muted" />
            Add workspace
          </button>
          {selectedID && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                onDelete(selectedID)
              }}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-danger hover:bg-surface-muted"
            >
              <TrashIcon size={14} className="shrink-0" />
              Remove workspace
            </button>
          )}
        </div>
      )}
    </div>
  )
}
