import type { WorkspaceRecord } from "@masterhand/client-core"

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
  const selected = workspaces.find((workspace) => workspace.id === selectedID) ?? null

  return (
    <div className="space-y-1.5 border-b border-hairline px-3 py-2.5">
      <div className="flex items-center gap-2">
        <select
          aria-label="Workspace"
          value={selectedID ?? ""}
          onChange={(event) => onSelect(event.target.value || null)}
          className="mh-select min-w-0 flex-1"
        >
          {workspaces.length === 0 && <option value="">No workspaces</option>}
          {workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={onAdd}
          aria-label="Add workspace"
          title="Add workspace"
          className="mh-btn mh-btn--quiet shrink-0"
        >
          +
        </button>
        <button
          type="button"
          onClick={() => selectedID && onDelete(selectedID)}
          disabled={!selectedID}
          aria-label="Remove workspace"
          title="Remove workspace"
          className="mh-btn mh-btn--quiet shrink-0 hover:text-danger disabled:text-ink-faint"
        >
          −
        </button>
      </div>
      {selected && (
        <p className="truncate font-mono text-[10px] text-ink-faint" title={selected.path}>
          {selected.path}
        </p>
      )}
    </div>
  )
}
