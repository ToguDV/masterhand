/**
 * Workspace list synchronization (shared by every client).
 *
 * The BFF owns the workspace rows and broadcasts two synthetic SSE frames when
 * another device creates or removes one. They carry no state worth writing into
 * the cache — the list is small and authoritative on the server — so clients
 * refetch it. Without these frames a second device kept showing the list it
 * loaded when the app opened.
 */

export const WORKSPACE_EVENT_TYPES = ["workspace.created", "workspace.deleted"] as const
export type WorkspaceEventType = (typeof WORKSPACE_EVENT_TYPES)[number]

export interface WorkspaceEvent {
  type: WorkspaceEventType
  /** Created/deleted workspace id, when the frame carries one. */
  workspaceID: string | null
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

/** Parses a workspace SSE frame; null for any other or malformed event. */
export function workspaceEventOf(event: unknown): WorkspaceEvent | null {
  if (!event || typeof event !== "object") return null
  const type = (event as { type?: unknown }).type
  if (type !== "workspace.created" && type !== "workspace.deleted") return null
  const data = (event as { data?: unknown }).data
  if (!data || typeof data !== "object" || Array.isArray(data)) return { type, workspaceID: null }
  const record = data as Record<string, unknown>
  if (type === "workspace.deleted") {
    return { type, workspaceID: asString(record.workspaceID) }
  }
  const workspace = record.workspace
  if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) {
    return { type, workspaceID: null }
  }
  return { type, workspaceID: asString((workspace as Record<string, unknown>).id) }
}
