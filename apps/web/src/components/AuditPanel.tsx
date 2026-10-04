import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { formatRelative, queryKeys, useAudit } from "@masterhand/client-core"
import { client } from "../client"

/**
 * Visible log of blocked actions: commands denied by the session permission
 * guard (broad kills) with the reason opencode returned. Kept for diagnosing
 * incidents where a model tried to stop a server and hit the guard.
 */
export function AuditPanel() {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
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
    <>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1.5 rounded-lg border border-zinc-700 px-2.5 py-1 text-xs font-medium text-zinc-300 hover:bg-zinc-800"
      >
        Activity
        {events.length > 0 && (
          <span className="rounded-full bg-amber-500/20 px-1.5 text-[10px] font-semibold text-amber-300">
            {events.length}
          </span>
        )}
      </button>

      {open && (
        <div className="fixed inset-0 z-30 flex flex-col bg-zinc-950 md:inset-auto md:right-0 md:top-0 md:h-full md:w-[min(520px,55vw)] md:border-l md:border-zinc-800">
          <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
            <h2 className="text-sm font-medium text-zinc-200">Denied commands</h2>
            <span className="flex-1" />
            {events.length > 0 && (
              <button
                type="button"
                onClick={() => void clear()}
                disabled={busy}
                className="rounded-lg border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
              >
                Clear
              </button>
            )}
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close activity log"
              className="rounded-lg px-2 py-1 text-zinc-400 hover:bg-zinc-800"
            >
              ✕
            </button>
          </div>

          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-3">
            {events.length === 0 ? (
              <p className="py-10 text-center text-sm text-zinc-500">
                Nothing blocked yet. Dangerous process commands an agent tries to run show up here.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {events.map((event) => (
                  <li key={event.id} className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2">
                    <div className="flex items-center gap-2 text-[11px] text-zinc-500">
                      <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-medium text-amber-300">
                        {event.kind === "permission_denied" ? "permission denied" : "run rejected"}
                      </span>
                      <span>{formatRelative(event.at)}</span>
                      {event.sessionID && <span className="truncate">session {event.sessionID}</span>}
                    </div>
                    {event.command && (
                      <p className="mt-1 break-all font-mono text-xs text-zinc-200">{event.command}</p>
                    )}
                    {event.reason && <p className="mt-1 text-xs text-zinc-500">{event.reason}</p>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </>
  )
}
