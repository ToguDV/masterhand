import { useBranches } from "@masterhand/client-core"
import { client } from "../client"
import { BranchIcon } from "./icons"

/**
 * Read-only branch view: shows the workspace's current branch and refreshes
 * every few seconds so a branch the agent switches externally is reflected.
 * It is not interactive and never opens a picker.
 */
export function BranchViewer({ workspaceID }: { workspaceID: string }) {
  const info = useBranches(client, true, workspaceID, 5_000).data
  if (!info?.current) return null
  return (
    <span
      title={`Current branch: ${info.current} (refreshes automatically)`}
      className="flex min-w-0 max-w-[14rem] items-center gap-1.5 rounded-sm border border-hairline-strong bg-surface px-2.5 py-1.5"
    >
      <BranchIcon size={14} className="shrink-0 text-ink-muted" />
      <span className="truncate font-mono text-xs text-ink-soft">{info.current}</span>
    </span>
  )
}
