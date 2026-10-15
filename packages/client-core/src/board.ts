/**
 * Kanban board (one per workspace, issue #164) shared client contract: the
 * snapshot rendered by every platform plus tolerant parsing of the
 * `board.updated` SSE frames the BFF broadcasts. Positions are absolute and
 * idempotent, so a lost mutation response is reconciled by a plain refetch.
 */

export interface BoardCard {
  id: string
  columnID: string
  title: string
  description: string
  position: number
  createdAt: number
  updatedAt: number
}

export interface BoardColumn {
  id: string
  workspaceID: string
  title: string
  position: number
  createdAt: number
  updatedAt: number
  cards: BoardCard[]
}

export interface BoardSnapshot {
  workspaceID: string
  columns: BoardColumn[]
}

export const BOARD_EVENT_TYPE = "board.updated"

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function normalizeCard(value: unknown): BoardCard | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const id = asString(raw.id)
  const columnID = asString(raw.columnID)
  const title = asString(raw.title)
  if (!id || !columnID || !title) return null
  const description = typeof raw.description === "string" ? raw.description : ""
  return {
    id,
    columnID,
    title,
    description,
    position: asNumber(raw.position),
    createdAt: asNumber(raw.createdAt),
    updatedAt: asNumber(raw.updatedAt),
  }
}

function normalizeColumn(value: unknown): BoardColumn | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const id = asString(raw.id)
  const workspaceID = asString(raw.workspaceID)
  const title = asString(raw.title)
  if (!id || !workspaceID || !title) return null
  const cards = Array.isArray(raw.cards)
    ? raw.cards
        .map(normalizeCard)
        .filter((card): card is BoardCard => card !== null)
        .sort((a, b) => a.position - b.position)
    : []
  return {
    id,
    workspaceID,
    title,
    position: asNumber(raw.position),
    createdAt: asNumber(raw.createdAt),
    updatedAt: asNumber(raw.updatedAt),
    cards,
  }
}

/** Tolerant single column: null when the payload is malformed. */
export function normalizeBoardColumn(value: unknown): BoardColumn | null {
  return normalizeColumn(value)
}

/** Tolerant single card: null when the payload is malformed. */
export function normalizeBoardCard(value: unknown): BoardCard | null {
  return normalizeCard(value)
}

/** Tolerant board snapshot: an unexpected payload degrades to null, never throws. */
export function normalizeBoardSnapshot(value: unknown): BoardSnapshot | null {  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const workspaceID = asString(raw.workspaceID)
  if (!workspaceID) return null
  const columns = Array.isArray(raw.columns)
    ? raw.columns
        .map(normalizeColumn)
        .filter((column): column is BoardColumn => column !== null)
        .sort((a, b) => a.position - b.position)
    : []
  return { workspaceID, columns }
}

/** Parses a `board.updated` SSE frame; null for any other or malformed event. */
export function boardPayloadOf(event: unknown): { workspaceID: string; board: BoardSnapshot } | null {
  if (!event || typeof event !== "object") return null
  if ((event as { type?: unknown }).type !== BOARD_EVENT_TYPE) return null
  const data = (event as { data?: unknown }).data
  if (!data || typeof data !== "object" || Array.isArray(data)) return null
  const workspaceID = (data as { workspaceID?: unknown }).workspaceID
  if (typeof workspaceID !== "string" || !workspaceID) return null
  const board = normalizeBoardSnapshot((data as { board?: unknown }).board)
  if (!board) return null
  return { workspaceID, board }
}

/**
 * Pure reorder helper shared by web and mobile: moves the item with `activeID`
 * to the position of `overID` within one ordered id list. Returns the new order,
 * or null when either id is unknown (the caller keeps the cache untouched).
 */
export function reorderIDs(ids: string[], activeID: string, overID: string): string[] | null {
  const from = ids.indexOf(activeID)
  const to = ids.indexOf(overID)
  if (from < 0 || to < 0 || from === to) return null
  const next = [...ids]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved!)
  return next
}

/**
 * Computes the drop index for a card moved within/between columns: the index of
 * `overCardID` in the target column's card list, or the end when dropped on the
 * empty column area (`overCardID` null).
 */
export function dropIndexFor(cards: BoardCard[], overCardID: string | null): number {
  if (!overCardID) return cards.length
  const index = cards.findIndex((card) => card.id === overCardID)
  return index < 0 ? cards.length : index
}
