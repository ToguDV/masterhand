import { useEffect, useState } from "react"
import {
  directoryName,
  formatRelative,
  rootSessions,
  type Session,
  type SessionStatus,
} from "@masterhand/client-core"
import { Deco } from "./Deco"
import { XIcon } from "./icons"
import { NewSessionMenu } from "./NewSessionMenu"
import { loadLastSeen } from "../sessionSeen"

/** Sessions rendered at once; more load on demand (no virtualization). */
const SESSION_PAGE_SIZE = 100

export function SessionList({
  sessions,
  statuses,
  selectedID,
  onSelect,
  onDelete,
  hasWorkspace,
  onCreateSession,
  creating,
  serverID,
}: {
  sessions: Session[]
  statuses: Record<string, SessionStatus>
  selectedID: string | null
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  /** False before any workspace exists; disables creation and changes the copy. */
  hasWorkspace: boolean
  onCreateSession: () => void
  creating: boolean
  /** Active server profile id: scopes the seen/unseen markers. */
  serverID: string
}) {
  const [visibleCount, setVisibleCount] = useState(SESSION_PAGE_SIZE)
  const [lastSeen, setLastSeen] = useState<Record<string, number>>(() => loadLastSeen(serverID))
  // App owns persistence (the mobile list unmounts while a chat is open);
  // this keeps the mounted list's dots in sync with the selected session.
  useEffect(() => {
    if (!selectedID) return
    setLastSeen((previous) => ({ ...previous, [selectedID]: Date.now() }))
  }, [selectedID])
  // Subagent children are reachable from their parent's card, not the list.
  const visible = rootSessions(sessions)
  const shown = visible.slice(0, visibleCount)
  const remaining = visible.length - shown.length

  const emptyText = hasWorkspace
    ? "No sessions yet."
    : "Add a workspace to start working on a project."

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-end gap-1.5 border-b border-hairline px-3 py-3">
        <NewSessionMenu onCreate={onCreateSession} creating={creating} disabled={!hasWorkspace} />
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 py-3">
        {visible.length === 0 && (
          <div className="mh-empty border-0 bg-transparent">
            <Deco variant="blob" style={{ top: -60, right: -70, width: 240, height: 220 }} />
            <Deco variant="dots" style={{ bottom: -14, left: -18 }} />
            <h3 className="mh-heading-2">{emptyText}</h3>
            {hasWorkspace && (
              <p className="mh-empty__body mh-body-sm">Create a session to start working on a project.</p>
            )}
          </div>
        )}

        <div className="mh-session">
          {shown.map((session) => {
            const status = statuses[session.id]
            const active = session.id === selectedID
            const busy = status?.type === "busy"
            const seenAt = lastSeen[session.id]
            // Unknown means seen (no badge spam on first run); a busy session
            // shows the spinner instead of the unseen marker.
            const unseen = !active && !busy && seenAt !== undefined && session.time.updated > seenAt
            return (
              <div key={session.id} className="relative">
                <button
                  type="button"
                  onClick={() => onSelect(session.id)}
                  className={`mh-session-item pr-9 ${active ? "is-active" : ""}`}
                >
                  <span className="mh-session-item__top">
                    {busy ? (
                      <span className="mh-spin shrink-0" aria-hidden="true" />
                    ) : unseen ? (
                      <span
                        className="mh-dot mh-dot--unseen shrink-0"
                        role="img"
                        aria-label="New activity since you last opened this session"
                        title="New activity"
                        data-testid="session-unseen"
                      />
                    ) : null}
                    <span className="mh-session-item__title">{session.title || "Untitled"}</span>
                  </span>
                  <span className="mh-session-item__meta">
                    {directoryName(session.location.directory)} · {formatRelative(session.time.updated)}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(session.id)}
                  aria-label={`Delete ${session.title || "session"}`}
                  title="Delete session"
                  className="mh-btn mh-btn--quiet absolute right-1.5 top-1/2 -translate-y-1/2 text-ink-faint hover:text-danger"
                >
                  <XIcon size={14} />
                </button>
              </div>
            )
          })}
        </div>

        {remaining > 0 && (
          <button
            type="button"
            onClick={() => setVisibleCount((count) => count + SESSION_PAGE_SIZE)}
            className="mh-pill mt-2 w-full"
          >
            Show {Math.min(SESSION_PAGE_SIZE, remaining)} more ({remaining} hidden)
          </button>
        )}
      </div>
    </div>
  )
}
