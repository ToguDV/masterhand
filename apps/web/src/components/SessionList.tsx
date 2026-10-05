import { useState } from "react"
import {
  directoryName,
  filterSessions,
  formatRelative,
  rootSessions,
  type Session,
  type SessionFilter,
  type SessionStatus,
} from "@masterhand/client-core"
import { Deco } from "./Deco"
import { XIcon } from "./icons"

const FILTERS: Array<{ value: SessionFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "isolated", label: "Isolated" },
  { value: "standard", label: "Standard" },
]

/** Sessions rendered at once; more load on demand (no virtualization). */
const SESSION_PAGE_SIZE = 100

export function SessionList({
  sessions,
  statuses,
  selectedID,
  onSelect,
  onDelete,
  hasWorkspace,
}: {
  sessions: Session[]
  statuses: Record<string, SessionStatus>
  selectedID: string | null
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  /** False before any workspace exists; only changes the empty-state copy. */
  hasWorkspace: boolean
}) {
  const [filter, setFilter] = useState<SessionFilter>("all")
  const [visibleCount, setVisibleCount] = useState(SESSION_PAGE_SIZE)
  // Subagent children are reachable from their parent's card, not the list.
  const visible = filterSessions(rootSessions(sessions), filter)
  const shown = visible.slice(0, visibleCount)
  const remaining = visible.length - shown.length

  const emptyText = hasWorkspace
    ? filter === "all"
      ? "No sessions yet."
      : "No sessions match this filter."
    : "Add a workspace to start working on a project."

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-hairline px-3 py-2">
        <h2 className="mh-heading-4">Sessions</h2>
      </div>

      <div className="flex items-center gap-1.5 border-b border-hairline px-3 py-3">
        {FILTERS.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => setFilter(option.value)}
            className={`mh-pill ${filter === option.value ? "is-active" : ""}`}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 py-3">
        {visible.length === 0 && (
          <div className="mh-empty border-0 bg-transparent">
            <Deco variant="blob" style={{ top: -60, right: -70, width: 240, height: 220 }} />
            <Deco variant="dots" style={{ bottom: -14, left: -18 }} />
            <h3 className="mh-heading-2">{emptyText}</h3>
            {hasWorkspace && filter === "all" && (
              <p className="mh-empty__body mh-body-sm">Create a session to start working on a project.</p>
            )}
          </div>
        )}

        <div className="mh-session">
          {shown.map((session) => {
            const status = statuses[session.id]
            const active = session.id === selectedID
            return (
              <div key={session.id} className="relative">
                <button
                  type="button"
                  onClick={() => onSelect(session.id)}
                  className={`mh-session-item pr-9 ${active ? "is-active" : ""}`}
                >
                  <span className="mh-session-item__top">
                    <span className={`mh-dot ${status?.type === "busy" ? "mh-dot--busy" : ""}`} />
                    <span className="mh-session-item__title">{session.title || "Untitled"}</span>
                    {session.isolation && (
                      <span
                        className="mh-chip mh-chip--accent mh-chip--mono max-w-[9rem] truncate"
                        title={session.isolation.branch}
                      >
                        {session.isolation.branch}
                      </span>
                    )}
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
