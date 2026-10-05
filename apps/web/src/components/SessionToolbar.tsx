import type { ReactNode } from "react"
import type { WorkspaceRecord } from "@masterhand/client-core"
import { WorkspacePicker } from "./WorkspacePicker"

/**
 * The composer's top bar: the workspace menu and an optional trailing slot
 * (the session stats). Session creation lives in the Sessions header.
 */
export function SessionToolbar({
  workspaces,
  workspaceID,
  onSelectWorkspace,
  onAddWorkspace,
  onRemoveWorkspace,
  trailing,
}: {
  workspaces: WorkspaceRecord[]
  workspaceID: string | null
  onSelectWorkspace: (id: string | null) => void
  onAddWorkspace: () => void
  onRemoveWorkspace: (id: string) => void
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
      {trailing ? <div className="ml-auto flex min-w-0 items-center">{trailing}</div> : null}
    </div>
  )
}
