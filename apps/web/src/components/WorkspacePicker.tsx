import { useEffect, useMemo, useRef, useState } from "react"
import type { WorkspaceRecord } from "@masterhand/client-core"
import { useDismissable } from "./useDismissable"
import { CheckIcon, ChevronDownIcon, FolderIcon } from "./icons"

/** How many recent workspaces the closed popover previews. */
const PREVIEW_COUNT = 5

/**
 * Condensed workspace switcher: one trigger showing the current workspace and
 * a popover with the five most recent workspaces (plus the selected one), a
 * search field and a "Show all" action — the same interaction as the model
 * `SearchSelect`. Add/remove management stays at the bottom. The popover opens
 * below the trigger by default (top bars like the Board); pass
 * `placement="up"` for bottom-docked bars like the composer.
 */
export function WorkspacePicker({
  workspaces,
  selectedID,
  onSelect,
  onAdd,
  onDelete,
  placement = "down",
}: {
  workspaces: WorkspaceRecord[]
  selectedID: string | null
  onSelect: (id: string | null) => void
  onAdd: () => void
  onDelete: (id: string) => void
  placement?: "up" | "down"
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [expanded, setExpanded] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  useDismissable(open, rootRef, () => setOpen(false))

  const recent = useMemo(
    () => [...workspaces].sort((a, b) => b.createdAt - a.createdAt),
    [workspaces],
  )
  const selected = recent.find((workspace) => workspace.id === selectedID) ?? null
  const searchable = recent.length > PREVIEW_COUNT
  const term = query.trim().toLowerCase()
  const filtered = term
    ? recent.filter(
        (workspace) =>
          workspace.name.toLowerCase().includes(term) || workspace.path.toLowerCase().includes(term),
      )
    : recent
  const pinned =
    !term && selected ? [selected, ...filtered.filter((workspace) => workspace.id !== selected.id)] : filtered
  const truncated = searchable && !expanded && !term
  const visible = truncated ? pinned.slice(0, PREVIEW_COUNT) : filtered

  useEffect(() => {
    if (!open) {
      setQuery("")
      setExpanded(false)
      return
    }
    inputRef.current?.focus()
  }, [open])

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
          className={`mh-popover absolute left-0 z-30 w-72 max-w-[85vw] rounded-md border border-hairline bg-surface p-2 shadow-elev1 ${
            placement === "up" ? "bottom-full mb-2" : "top-full mt-1"
          }`}
        >
          {searchable && (
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && visible[0]) {
                  event.preventDefault()
                  onSelect(visible[0].id)
                  setOpen(false)
                }
              }}
              placeholder="Search…"
              aria-label="Search workspace"
              className="mb-2 w-full rounded-sm border border-hairline-strong bg-surface px-2 py-1.5 text-xs text-ink outline-none placeholder:text-ink-faint focus:border-accent"
            />
          )}

          <ul role="group" aria-label="Workspaces" className="max-h-60 space-y-0.5 overflow-y-auto scroll-thin">
            {visible.length === 0 && (
              <li className="px-2 py-3 text-xs text-ink-muted">
                {workspaces.length === 0 ? "No workspaces yet." : "No matches"}
              </li>
            )}
            {visible.map((workspace) => (
              <li key={workspace.id}>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={workspace.id === selectedID}
                  title={workspace.path}
                  onClick={() => {
                    onSelect(workspace.id)
                    setOpen(false)
                  }}
                  className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-surface-muted ${
                    workspace.id === selectedID ? "text-accent" : "text-ink-soft"
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                  {workspace.id === selectedID && <CheckIcon size={14} className="shrink-0 text-accent" />}
                </button>
              </li>
            ))}
          </ul>

          {truncated && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="mt-1 w-full rounded-sm px-2 py-1.5 text-left text-xs text-accent hover:bg-surface-muted"
            >
              Show all {recent.length}
            </button>
          )}

          <div className="my-1 h-px bg-hairline" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              onAdd()
            }}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs text-ink-soft hover:bg-surface-muted"
          >
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
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs text-danger hover:bg-surface-muted"
            >
              Remove workspace
            </button>
          )}
        </div>
      )}
    </div>
  )
}
