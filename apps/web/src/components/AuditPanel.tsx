import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { formatRelative, queryKeys, useAudit } from "@masterhand/client-core"
import { client } from "../client"
import { SidePanel } from "./SidePanel"
import { Skeleton, SkeletonStatus } from "./Skeleton"

/**
 * Visible log of blocked actions: commands denied by the session permission
 * guard (broad kills) with the reason opencode returned. Kept for diagnosing
 * incidents where a model tried to stop a server and hit the guard.
 */
export function AuditTrigger({ onOpen, className = "" }: { onOpen: () => void; className?: string }) {
  const auditQuery = useAudit(client)
  const count = auditQuery.data?.length ?? 0

  return (
    <button type="button" onClick={onOpen} className={`mh-btn mh-btn--ghost ${className}`}>
      Activity
      {count > 0 && <span className="mh-chip mh-chip--warning">{count}</span>}
    </button>
  )
}

export function AuditSheet({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient()
  const auditQuery = useAudit(client)
  const [busy, setBusy] = useState(false)
  const events = auditQuery.data ?? []

  async function clear() {
    setBusy(true)
    try {
      await client.api.clearAudit()
      queryClient.setQueryData(queryKeys.audit, [])
    } finally {
      setBusy(false)
    }
  }

  return (
    <SidePanel
      title="Denied commands"
      closeLabel="Close activity log"
      onClose={onClose}
      actions={
        events.length > 0 ? (
          <button
            type="button"
            onClick={() => void clear()}
            disabled={busy}
            className="mh-btn mh-btn--secondary mh-btn--sm"
          >
            Clear
          </button>
        ) : undefined
      }
    >
      {auditQuery.isPending ? (
        <div className="flex flex-col gap-2 p-3" data-testid="audit-skeleton">
          <SkeletonStatus label="Loading activity…" />
          <div aria-hidden="true" className="flex flex-col gap-2">
            {[0, 1, 2].map((row) => (
              <div key={row} className="rounded-md border border-hairline bg-surface px-3 py-2">
                <div className="flex items-center gap-2">
                  <Skeleton className="h-5 w-28 rounded-full" />
                  <Skeleton className="h-3 w-16" />
                </div>
                <Skeleton className="mt-2 h-3 w-4/5" />
                <Skeleton className="mt-1.5 h-3 w-3/5" />
              </div>
            ))}
          </div>
        </div>
      ) : events.length === 0 ? (
        <p className="px-3 py-10 text-center text-sm text-ink-muted">
          Nothing blocked yet. Dangerous process commands an agent tries to run show up here.
        </p>
      ) : (
        <ul className="flex flex-col gap-2 p-3">
          {events.map((event) => (
            <li key={event.id} className="rounded-md border border-hairline bg-surface px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="mh-chip mh-chip--warning">
                  {event.kind === "permission_denied" ? "permission denied" : "run rejected"}
                </span>
                <span className="text-xs text-ink-muted">{formatRelative(event.at)}</span>
                {event.sessionID && <span className="min-w-0 truncate text-xs text-ink-faint">{event.sessionID}</span>}
              </div>
              {event.command && <p className="mt-1 break-all font-mono text-xs text-ink">{event.command}</p>}
              {event.reason && <p className="mt-1 text-xs text-ink-muted">{event.reason}</p>}
            </li>
          ))}
        </ul>
      )}
    </SidePanel>
  )
}
