/** Last-opened timestamps per session, persisted across reloads and per server. */
const LAST_SEEN_KEY = "masterhand.lastSeenSessions"

function storageKey(serverID?: string | null): string {
  return serverID ? `${LAST_SEEN_KEY}.${serverID}` : LAST_SEEN_KEY
}

export function loadLastSeen(serverID?: string | null): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(storageKey(serverID))
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

function storeLastSeen(record: Record<string, number>, serverID?: string | null): void {
  try {
    window.localStorage.setItem(storageKey(serverID), JSON.stringify(record))
  } catch {
    // Private mode or quota: tracking degrades to in-memory only.
  }
}

/**
 * Marks a session as seen. App owns this on open: the mobile shell unmounts
 * the session list while a chat is open, so the list cannot be the writer.
 * Session ids are scoped to the active server so switching cannot mark another
 * server's sessions as read.
 */
export function markSessionSeen(sessionID: string, serverID?: string | null): void {
  const record = loadLastSeen(serverID)
  record[sessionID] = Date.now()
  storeLastSeen(record, serverID)
}
