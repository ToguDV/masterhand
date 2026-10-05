import type { ReactNode } from "react"
import type { WorkspaceRecord } from "@masterhand/client-core"
import { WorkspacePicker } from "./WorkspacePicker"

/**
 * The composer's top bar: the workspace menu, an optional branch control and
 * an optional trailing slot (the session stats). Session creation lives in the
 * Sessions header.
 */
export function SessionToolbar({
  workspaces,
  workspaceID,
  onSelectWorkspace,
  onAddWorkspace,
  onRemoveWorkspace,
  branch,
  trailing,
}: {
  workspaces: WorkspaceRecord[]
  workspaceID: string | null
  onSelectWorkspace: (id: string | null) => void
  onAddWorkspace: () => void
  onRemoveWorkspace: (id: string) => void
  /** Branch picker (standard sessions) or read-only chip (isolated sessions). */
  branch?: ReactNode
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
      {branch}
      {trailing ? <div className="ml-auto flex min-w-0 items-center">{trailing}</div> : null}
    </div>
  )
}
