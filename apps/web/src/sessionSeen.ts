/** Last-opened timestamps per session, persisted across reloads. */
const LAST_SEEN_KEY = "masterhand.lastSeenSessions"

export function loadLastSeen(): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(LAST_SEEN_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, number>
    }
  } catch {
    // Corrupt or unavailable storage reads as nothing seen.
  }
  return {}
}

function storeLastSeen(record: Record<string, number>): void {
  try {
    window.localStorage.setItem(LAST_SEEN_KEY, JSON.stringify(record))
  } catch {
    // Private mode or quota: tracking degrades to in-memory only.
  }
}

/**
 * Marks a session as seen. App owns this on open: the mobile shell unmounts
 * the session list while a chat is open, so the list cannot be the writer.
 */
export function markSessionSeen(sessionID: string): void {
  const record = loadLastSeen()
  record[sessionID] = Date.now()
  storeLastSeen(record)
}
