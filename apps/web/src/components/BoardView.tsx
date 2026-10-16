import { useMemo, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  dropIndexFor,
  queryKeys,
  reorderIDs,
  useBoard,
  type BoardCard,
  type BoardSnapshot,
  type WorkspaceRecord,
} from "@masterhand/client-core"
import {
  DndContext,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  TouchSensor,
  closestCorners,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core"
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { client } from "../client"
import { Deco } from "./Deco"
import { WorkspacePicker } from "./WorkspacePicker"
import { useToast } from "./Toast"
import { useDismissable } from "./useDismissable"
import { useModalFocus } from "./useModalFocus"
import { CheckIcon, EllipsisIcon, PlusIcon, TrashIcon, XIcon } from "./icons"

function newID(prefix: string): string {
  const uuid = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `${prefix}_${uuid}`.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64)
}

function boardErrorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : ""
  if (/column_not_found/i.test(text)) return "The column no longer exists — the board was refreshed"
  if (/card_not_found/i.test(text)) return "The card no longer exists — the board was refreshed"
  if (/invalid_title/i.test(text)) return "Give it a title (1–200 characters)"
  if (/workspace/i.test(text)) return "Select a workspace first"
  return "Could not save the board change"
}

function SortableCard({
  card,
  onOpen,
}: {
  card: BoardCard
  onOpen: (card: BoardCard) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
    data: { columnID: card.columnID, type: "card" },
  })
  return (
    <button
      ref={setNodeRef}
      type="button"
      onClick={() => onOpen(card)}
      {...attributes}
      {...listeners}
      style={{
        transform: CSS.Translate.toString(transform),
        transition: isDragging ? undefined : transition,
      }}
      className={`relative w-full rounded-md border border-hairline bg-surface px-3 py-2 text-left shadow-sm hover:bg-surface-muted ${
        isDragging ? "z-10 shadow-elev3" : ""
      }`}
      aria-label={`Edit card ${card.title}`}
      data-dragging={isDragging ? "true" : undefined}
    >
      <span className="block truncate text-sm font-medium text-ink">{card.title}</span>
      {card.description && (
        <span className="mt-0.5 block line-clamp-2 whitespace-pre-wrap text-xs text-ink-muted">{card.description}</span>
      )}
    </button>
  )
}

/**
 * Pointer-first collision: `pointerWithin` follows the cursor (stable with
 * nested column/card droppables), falling back to `closestCorners` when the
 * pointer sits in a gap. `closestCenter` flipped `over` between the source
 * card and the column on every frame, which read as flicker.
 */
const boardCollision: CollisionDetection = (args) => {
  const pointerHits = pointerWithin(args)
  return pointerHits.length > 0 ? pointerHits : closestCorners(args)
}

function ColumnMenu({
  columnID,
  isFirst,
  isLast,
  cardCount,
  onMove,
  onDelete,
}: {
  columnID: string
  isFirst: boolean
  isLast: boolean
  cardCount: number
  onMove: (columnID: string, direction: -1 | 1) => void
  onDelete: (columnID: string) => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  useDismissable(open, rootRef, () => setOpen(false))
  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="mh-btn mh-btn--quiet"
        aria-label={`Column options`}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <EllipsisIcon size={16} />
      </button>
      {open && (
        <div role="menu" aria-label="Column options" className="absolute right-0 top-full z-30 mt-1 w-52 rounded-md border border-hairline bg-surface p-1.5 shadow-elev3">
          <button
            type="button"
            role="menuitem"
            disabled={isFirst}
            onClick={() => {
              setOpen(false)
              onMove(columnID, -1)
            }}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-ink-soft hover:bg-surface-muted disabled:opacity-40"
          >
            Move left
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={isLast}
            onClick={() => {
              setOpen(false)
              onMove(columnID, 1)
            }}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-ink-soft hover:bg-surface-muted disabled:opacity-40"
          >
            Move right
          </button>
          <div className="my-1 h-px bg-hairline" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              onDelete(columnID)
            }}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-danger hover:bg-surface-muted"
            aria-label={`Delete column with ${cardCount} ${cardCount === 1 ? "card" : "cards"}`}
          >
            <TrashIcon size={14} />
            Delete column
          </button>
        </div>
      )}
    </div>
  )
}

function BoardColumnView({
  column,
  columnIndex,
  total,
  isActive,
  editingColumnID,
  editingColumnTitle,
  onEditTitle,
  onStartRename,
  onCancelEdit,
  onSubmitRename,
  newCardTitle,
  onNewCardTitle,
  creating,
  onCreateCard,
  onOpenCard,
  onMove,
  onDelete,
}: {
  column: import("@masterhand/client-core").BoardColumn
  columnIndex: number
  total: number
  isActive: boolean
  editingColumnID: string | null
  editingColumnTitle: string
  onEditTitle: (value: string) => void
  onStartRename: (columnID: string) => void
  onCancelEdit: () => void
  onSubmitRename: (columnID: string) => void
  newCardTitle: string
  onNewCardTitle: (value: string) => void
  creating: boolean
  onCreateCard: (columnID: string) => void
  onOpenCard: (card: import("@masterhand/client-core").BoardCard) => void
  onMove: (columnID: string, direction: -1 | 1) => void
  onDelete: (columnID: string) => void
}) {
  const { setNodeRef } = useDroppable({ id: column.id, data: { type: "column", columnID: column.id } })
  // The source column (not just the card) rises above its siblings while its
  // card drags: a z-index on the card alone only orders within its own column,
  // so an earlier column's card would still paint underneath later columns.
  return (
    <section
      ref={setNodeRef}
      aria-label={`Column ${column.title}`}
      className={`relative flex w-72 max-w-[85vw] shrink-0 flex-col rounded-lg border border-hairline bg-canvas p-2 ${
        isActive ? "z-10" : ""
      }`}
    >
      <header className="flex items-center gap-1 px-1 py-1">
        {editingColumnID === column.id ? (
          <form
            className="flex min-w-0 flex-1 items-center gap-1"
            onSubmit={(event) => {
              event.preventDefault()
              onSubmitRename(column.id)
            }}
          >
            <input
              value={editingColumnTitle}
              onChange={(event) => onEditTitle(event.target.value)}
              aria-label="Column title"
              className="mh-input min-w-0 flex-1"
              maxLength={200}
              autoFocus
            />
            <button type="submit" className="mh-btn mh-btn--quiet" aria-label="Save column title">
              <CheckIcon size={16} />
            </button>
            <button type="button" onClick={onCancelEdit} className="mh-btn mh-btn--quiet" aria-label="Cancel rename">
              <XIcon size={16} />
            </button>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => onStartRename(column.id)}
            className="min-w-0 flex-1 truncate text-left text-sm font-medium text-ink hover:underline"
            aria-label={`Rename column ${column.title}`}
            title="Rename column"
            data-rename-column={column.id}
          >
            {column.title}
          </button>
        )}
        <span className="shrink-0 rounded-full border border-hairline px-1.5 text-xs text-ink-muted" aria-label={`${column.cards.length} ${column.cards.length === 1 ? "card" : "cards"}`}>
          {column.cards.length}
        </span>
        <ColumnMenu
          columnID={column.id}
          isFirst={columnIndex === 0}
          isLast={columnIndex === total - 1}
          cardCount={column.cards.length}
          onMove={onMove}
          onDelete={onDelete}
        />
      </header>

      <SortableContext items={column.cards.map((card) => card.id)} strategy={verticalListSortingStrategy}>
        <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-1" aria-label={`Cards in ${column.title}`}>
          {column.cards.map((card) => (
            <SortableCard key={card.id} card={card} onOpen={onOpenCard} />
          ))}
          {column.cards.length === 0 && (
            <p className="rounded-md border border-dashed border-hairline px-3 py-4 text-center text-xs text-ink-faint">
              No cards — drag one here or add below.
            </p>
          )}
        </div>
      </SortableContext>

      <form
        className="mt-2 flex items-center gap-1 px-1 pb-1"
        onSubmit={(event) => {
          event.preventDefault()
          onCreateCard(column.id)
        }}
      >
        <input
          value={newCardTitle}
          onChange={(event) => onNewCardTitle(event.target.value)}
          placeholder="New card"
          aria-label={`New card title in ${column.title}`}
          className="mh-input min-w-0 flex-1"
          maxLength={200}
        />
        <button
          type="submit"
          disabled={creating}
          className="mh-btn mh-btn--quiet"
          aria-label={`Add card to ${column.title}`}
        >
          <PlusIcon size={16} />
        </button>
      </form>
    </section>
  )
}
/**
 * Delete-column confirmation: focus-trapped like every other app dialog
 * (Escape closes, focus restores on unmount).
 */
function DeleteColumnDialog({
  title,
  cardCount,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string
  cardCount: number
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const dialogRef = useModalFocus<HTMLDivElement>(onCancel)
  return (
    <div className="mh-overlay fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onCancel}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-column-title"
        aria-describedby="delete-column-description"
        className="mh-dialog outline-none"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="delete-column-title" className="mh-dialog__title mh-heading-2">
          Delete column?
        </h3>
        <p id="delete-column-description" className="mh-body-sm text-ink-muted">
          “{title}” and its {cardCount} {cardCount === 1 ? "card" : "cards"} will be deleted. This cannot be undone.
        </p>
        <div className="mh-dialog__actions mt-4">
          <button type="button" onClick={onCancel} className="mh-btn mh-btn--ghost" disabled={busy}>
            Cancel
          </button>
          <button type="button" onClick={onConfirm} disabled={busy} className="mh-btn mh-btn--danger">
            {busy ? "Deleting…" : `Delete column and ${cardCount} ${cardCount === 1 ? "card" : "cards"}`}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Edit-card dialog with the same focus contract as the other app dialogs. */
function EditCardDialog({
  draft,
  onDraft,
  busy,
  onCancel,
  onSave,
  onDelete,
}: {
  draft: { title: string; description: string }
  onDraft: (draft: { title: string; description: string }) => void
  busy: boolean
  onCancel: () => void
  onSave: () => void
  onDelete: () => void
}) {
  const dialogRef = useModalFocus<HTMLDivElement>(onCancel)
  return (
    <div className="mh-overlay fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onCancel}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-card-title"
        className="mh-dialog outline-none"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="edit-card-title" className="mh-dialog__title mh-heading-2">
          Edit card
        </h3>
        <label className="mt-2 block text-xs font-medium text-ink-muted" htmlFor="board-card-title">
          Title
        </label>
        <input
          id="board-card-title"
          value={draft.title}
          onChange={(event) => onDraft({ ...draft, title: event.target.value })}
          className="mh-input mt-1 w-full"
          maxLength={200}
        />
        <label className="mt-3 block text-xs font-medium text-ink-muted" htmlFor="board-card-description">
          Description
        </label>
        <textarea
          id="board-card-description"
          value={draft.description}
          onChange={(event) => onDraft({ ...draft, description: event.target.value })}
          className="mh-input mt-1 min-h-24 w-full"
          maxLength={10000}
          rows={4}
        />
        <div className="mh-dialog__actions mt-4">
          <button type="button" onClick={onDelete} disabled={busy} className="mh-btn mh-btn--danger">
            <TrashIcon size={14} />
            Delete
          </button>
          <span className="flex-1" />
          <button type="button" onClick={onCancel} className="mh-btn mh-btn--ghost" disabled={busy}>
            Cancel
          </button>
          <button type="button" onClick={onSave} disabled={busy} className="mh-btn mh-btn--primary">
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Workspace board: one kanban per workspace (issue #164). Cards drag within a
 * column and across columns (@dnd-kit); a drop commits an absolute
 * `(columnID, position)` and a failure refetches with an error toast — never a
 * blind retry. Column reorder stays in menus (no column drag in v1).
 */
export function BoardView({
  workspaceID,
  workspaces,
  onSelectWorkspace,
  onAddWorkspace,
  onRemoveWorkspace,
}: {
  workspaceID: string | null
  workspaces: WorkspaceRecord[]
  onSelectWorkspace: (id: string | null) => void
  onAddWorkspace: () => void
  onRemoveWorkspace: (id: string) => void
}) {
  const queryClient = useQueryClient()
  const toast = useToast()
  const boardQuery = useBoard(client, workspaceID)
  const board = boardQuery.data ?? null
  const [newColumnTitle, setNewColumnTitle] = useState("")
  const [creatingColumn, setCreatingColumn] = useState(false)
  const [newCardTitles, setNewCardTitles] = useState<Record<string, string>>({})
  const [creatingCardColumn, setCreatingCardColumn] = useState<string | null>(null)
  const [editingColumnID, setEditingColumnID] = useState<string | null>(null)
  const [editingColumnTitle, setEditingColumnTitle] = useState("")
  const [confirmDeleteColumnID, setConfirmDeleteColumnID] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [editingCard, setEditingCard] = useState<BoardCard | null>(null)
  const [cardDraft, setCardDraft] = useState({ title: "", description: "" })
  const [savingCard, setSavingCard] = useState(false)
  const [activeCard, setActiveCard] = useState<BoardCard | null>(null)
  const lastDragEndRef = useRef(0)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const columns = useMemo(() => board?.columns ?? [], [board])

  function findCard(cardID: string): BoardCard | null {
    for (const column of columns) {
      const card = column.cards.find((entry) => entry.id === cardID)
      if (card) return card
    }
    return null
  }

  function failBoard(error: unknown) {
    void queryClient.invalidateQueries({ queryKey: queryKeys.board(workspaceID) })
    toast(boardErrorMessage(error))
  }

  async function createColumn() {
    if (!workspaceID) {
      toast("Select a workspace first")
      return
    }
    const title = newColumnTitle.trim()
    if (!title) {
      toast("Give it a title (1–200 characters)")
      return
    }
    setCreatingColumn(true)
    try {
      await client.api.board.createColumn(workspaceID, { id: newID("col"), title })
      setNewColumnTitle("")
      await queryClient.invalidateQueries({ queryKey: queryKeys.board(workspaceID) })
    } catch (error) {
      failBoard(error)
    } finally {
      setCreatingColumn(false)
    }
  }

  async function renameColumn(columnID: string) {
    const title = editingColumnTitle.trim()
    if (!title) {
      toast("Give it a title (1–200 characters)")
      return
    }
    try {
      await client.api.board.updateColumn(columnID, { title })
      setEditingColumnID(null)
      await queryClient.invalidateQueries({ queryKey: queryKeys.board(workspaceID) })
    } catch (error) {
      failBoard(error)
    }
  }

  async function moveColumn(columnID: string, direction: -1 | 1) {
    const index = columns.findIndex((column) => column.id === columnID)
    if (index < 0) return
    const next = index + direction
    if (next < 0 || next >= columns.length) return
    const previous = queryClient.getQueryData<BoardSnapshot>(queryKeys.board(workspaceID))
    const reordered = [...columns]
    const [moved] = reordered.splice(index, 1)
    reordered.splice(next, 0, moved!)
    if (previous) {
      queryClient.setQueryData<BoardSnapshot>(queryKeys.board(workspaceID), {
        ...previous,
        columns: reordered.map((column, position) => ({ ...column, position })),
      })
    }
    try {
      await client.api.board.updateColumn(columnID, { position: next })
      await queryClient.invalidateQueries({ queryKey: queryKeys.board(workspaceID) })
    } catch (error) {
      failBoard(error)
    }
  }

  async function confirmDeleteColumn() {
    if (!confirmDeleteColumnID) return
    setDeleting(true)
    try {
      await client.api.board.deleteColumn(confirmDeleteColumnID)
      setConfirmDeleteColumnID(null)
      await queryClient.invalidateQueries({ queryKey: queryKeys.board(workspaceID) })
      toast("✓ Column deleted")
    } catch (error) {
      failBoard(error)
    } finally {
      setDeleting(false)
    }
  }

  async function createCard(columnID: string) {
    const title = (newCardTitles[columnID] ?? "").trim()
    if (!title) {
      toast("Give it a title (1–200 characters)")
      return
    }
    setCreatingCardColumn(columnID)
    try {
      await client.api.board.createCard({ id: newID("card"), columnID, title })
      setNewCardTitles((prev) => ({ ...prev, [columnID]: "" }))
      await queryClient.invalidateQueries({ queryKey: queryKeys.board(workspaceID) })
    } catch (error) {
      failBoard(error)
    } finally {
      setCreatingCardColumn(null)
    }
  }

  function openCard(card: BoardCard) {
    // A pointer drag ends with a click on the source button; ignore the
    // click that immediately follows a drop so the edit dialog does not pop
    // open on every drag (it read as "drag fights with return").
    if (Date.now() - lastDragEndRef.current < 250) return
    setEditingCard(card)
    setCardDraft({ title: card.title, description: card.description })
  }

  async function saveCard() {
    if (!editingCard) return
    const title = cardDraft.title.trim()
    if (!title) {
      toast("Give it a title (1–200 characters)")
      return
    }
    setSavingCard(true)
    try {
      await client.api.board.updateCard(editingCard.id, { title, description: cardDraft.description })
      setEditingCard(null)
      await queryClient.invalidateQueries({ queryKey: queryKeys.board(workspaceID) })
    } catch (error) {
      failBoard(error)
    } finally {
      setSavingCard(false)
    }
  }

  async function deleteCard() {
    if (!editingCard) return
    setSavingCard(true)
    try {
      await client.api.board.deleteCard(editingCard.id)
      setEditingCard(null)
      await queryClient.invalidateQueries({ queryKey: queryKeys.board(workspaceID) })
      toast("✓ Card deleted")
    } catch (error) {
      failBoard(error)
    } finally {
      setSavingCard(false)
    }
  }

  function columnOfCard(
    cols: BoardSnapshot["columns"],
    cardID: string,
  ): { columnID: string; index: number } | null {
    for (const column of cols) {
      if (!column.cards.some((card) => card.id === cardID)) continue
      return { columnID: column.id, index: dropIndexFor(column.cards, cardID) }
    }
    return null
  }

  function targetOfOver(
    cols: BoardSnapshot["columns"],
    overID: string | null,
  ): { columnID: string; index: number } | null {
    if (!overID) return null
    const cardLocation = columnOfCard(cols, overID)
    if (cardLocation) return cardLocation
    const column = cols.find((item) => item.id === overID)
    if (column) return { columnID: column.id, index: dropIndexFor(column.cards, null) }
    return null
  }

  async function commitCardMove(activeID: string, overID: string | null) {
    // Resolve against the live cache snapshot, not the render closure: a
    // second drop can land while the refetch of the first is still in flight,
    // and the position must match the base the optimistic update applies to.
    const base = queryClient.getQueryData<BoardSnapshot>(queryKeys.board(workspaceID)) ?? board ?? null
    const cols = base?.columns ?? columns
    const from = columnOfCard(cols, activeID)
    const target = targetOfOver(cols, overID)
    if (!from || !target) return
    if (from.columnID === target.columnID && from.index === target.index) return
    // One absolute position drives both the optimistic cache and the PATCH,
    // so the card never jumps on refetch. Same-column card-over-card uses the
    // shared arrayMove helper (matching the server); every other drop inserts
    // at the over index (end when dropped on the empty column area).
    const sameColumn = from.columnID === target.columnID
    const overIsSameColumnCard =
      sameColumn && overID !== null && cols.find((column) => column.id === from.columnID)?.cards.some((card) => card.id === overID)
    let position: number
    let reorderedIDs: string[] | null = null
    if (overIsSameColumnCard) {
      const ids = cols.find((column) => column.id === from.columnID)?.cards.map((card) => card.id) ?? []
      reorderedIDs = reorderIDs(ids, activeID, overID!)
      if (!reorderedIDs) return
      position = reorderedIDs.indexOf(activeID)
    } else if (sameColumn) {
      const length = cols.find((column) => column.id === from.columnID)?.cards.length ?? target.index
      position = Math.min(target.index, Math.max(length - 1, 0))
    } else {
      position = target.index
    }
    // Optimistic reorder, then commit the absolute position. Snapshots are
    // rebuilt (never mutated) so concurrent readers keep a stable reference.
    const previous = queryClient.getQueryData<BoardSnapshot>(queryKeys.board(workspaceID))
    if (previous) {
      if (reorderedIDs) {
        const byID = new Map<string, BoardCard>()
        for (const column of previous.columns) {
          if (column.id !== from.columnID) continue
          for (const card of column.cards) byID.set(card.id, card)
        }
        const reordered = reorderedIDs.map((id, index) => ({ ...byID.get(id)!, position: index }))
        queryClient.setQueryData<BoardSnapshot>(queryKeys.board(workspaceID), {
          ...previous,
          columns: previous.columns.map((column) =>
            column.id === from.columnID
              ? { ...column, cards: reordered }
              : column,
          ),
        })
      } else {
        const next: BoardSnapshot = {
          ...previous,
          columns: previous.columns.map((column) => ({ ...column, cards: [...column.cards] })),
        }
        const source = next.columns.find((column) => column.id === from.columnID)!
        const destination = next.columns.find((column) => column.id === target.columnID)!
        const fromIndex = source.cards.findIndex((card) => card.id === activeID)
        if (fromIndex < 0) return
        const [moved] = source.cards.splice(fromIndex, 1)
        if (!moved) return
        destination.cards.splice(Math.min(position, destination.cards.length), 0, { ...moved, columnID: destination.id })
        const reindexed = next.columns.map((column) =>
          column.id === source.id || column.id === destination.id
            ? { ...column, cards: column.cards.map((card, index) => ({ ...card, position: index })) }
            : column,
        )
        queryClient.setQueryData<BoardSnapshot>(queryKeys.board(workspaceID), { ...next, columns: reindexed })
      }
    }
    try {
      await client.api.board.updateCard(activeID, { columnID: target.columnID, position })
      await queryClient.invalidateQueries({ queryKey: queryKeys.board(workspaceID) })
    } catch (error) {
      failBoard(error)
    }
  }

  function onDragStart(event: DragStartEvent) {
    setActiveCard(findCard(String(event.active.id)))
  }

  function onDragCancel() {
    setActiveCard(null)
  }

  function onDragEnd(event: DragEndEvent) {
    lastDragEndRef.current = Date.now()
    const activeID = String(event.active.id)
    const overID = event.over ? String(event.over.id) : null
    setActiveCard(null)
    void commitCardMove(activeID, overID)
  }

  if (!workspaceID) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <WorkspacePicker workspaces={workspaces} selectedID={workspaceID} onSelect={onSelectWorkspace} onAdd={onAddWorkspace} onDelete={onRemoveWorkspace} />
        </div>
        <div className="mh-empty relative flex-1">
          <Deco variant="blob" style={{ top: -80, right: -80, width: 280, height: 260 }} />
          <Deco variant="dots" style={{ bottom: -12, left: -20 }} />
          <h3 className="mh-heading-2">Board</h3>
          <p className="mh-empty__body mh-body-sm">Add a workspace first — each workspace has its own board.</p>
        </div>
      </div>
    )
  }

  if (boardQuery.isPending) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <WorkspacePicker workspaces={workspaces} selectedID={workspaceID} onSelect={onSelectWorkspace} onAdd={onAddWorkspace} onDelete={onRemoveWorkspace} />
        </div>
        <p className="animate-pulse text-sm text-ink-muted">Loading board…</p>
      </div>
    )
  }

  if (boardQuery.isError) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <WorkspacePicker workspaces={workspaces} selectedID={workspaceID} onSelect={onSelectWorkspace} onAdd={onAddWorkspace} onDelete={onRemoveWorkspace} />
        </div>
        <div className="mh-empty relative flex-1">
          <h3 className="mh-heading-2">Board</h3>
          <p className="mh-empty__body mh-body-sm">Could not load the board.</p>
          <button type="button" onClick={() => void boardQuery.refetch()} className="mh-btn mh-btn--secondary mh-btn--sm">
            Retry
          </button>
        </div>
      </div>
    )
  }

  const confirmColumn = columns.find((column) => column.id === confirmDeleteColumnID) ?? null

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <WorkspacePicker workspaces={workspaces} selectedID={workspaceID} onSelect={onSelectWorkspace} onAdd={onAddWorkspace} onDelete={onRemoveWorkspace} />
        <span className="text-xs text-ink-muted" aria-live="polite">
          {columns.length === 0 ? "Empty board" : `${columns.length} ${columns.length === 1 ? "column" : "columns"}`}
        </span>
      </div>

      {columns.length === 0 ? (
        <div className="mh-empty relative flex-1">
          <Deco variant="blob" style={{ top: -80, right: -80, width: 280, height: 260 }} />
          <Deco variant="dots" style={{ bottom: -12, left: -20 }} />
          <h3 className="mh-heading-2">Board</h3>
          <p className="mh-empty__body mh-body-sm">This workspace has no columns yet. Add the first one to start tracking work.</p>
          <div className="flex w-full max-w-sm items-center gap-2">
            <input
              value={newColumnTitle}
              onChange={(event) => setNewColumnTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void createColumn()
              }}
              placeholder="New column (e.g. To do)"
              aria-label="New column title"
              className="mh-input min-w-0 flex-1"
              maxLength={200}
            />
            <button type="button" onClick={() => void createColumn()} disabled={creatingColumn} className="mh-btn mh-btn--primary mh-btn--sm">
              {creatingColumn ? "Adding…" : "Add column"}
            </button>
          </div>
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={boardCollision}
          measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
          onDragStart={onDragStart}
          onDragCancel={onDragCancel}
          onDragEnd={onDragEnd}
        >
          <div className="scroll-thin flex min-h-0 flex-1 gap-3 overflow-x-auto pb-2" aria-label="Board columns">
            {columns.map((column, columnIndex) => (
              <BoardColumnView
                key={column.id}
                column={column}
                columnIndex={columnIndex}
                total={columns.length}
                isActive={activeCard?.columnID === column.id}
                editingColumnID={editingColumnID}
                editingColumnTitle={editingColumnTitle}
                onEditTitle={setEditingColumnTitle}
                onStartRename={(id) => {
                  const target = columns.find((entry) => entry.id === id)
                  if (!target) return
                  setEditingColumnID(id)
                  setEditingColumnTitle(target.title)
                }}
                onCancelEdit={() => setEditingColumnID(null)}
                onSubmitRename={(id) => void renameColumn(id)}
                newCardTitle={newCardTitles[column.id] ?? ""}
                onNewCardTitle={(value) => setNewCardTitles((prev) => ({ ...prev, [column.id]: value }))}
                creating={creatingCardColumn === column.id}
                onCreateCard={(id) => void createCard(id)}
                onOpenCard={openCard}
                onMove={(id, direction) => void moveColumn(id, direction)}
                onDelete={(id) => setConfirmDeleteColumnID(id)}
              />
            ))}

            <div className="flex w-72 max-w-[85vw] shrink-0 flex-col gap-2 rounded-lg border border-dashed border-hairline p-3">
              <p className="text-sm font-medium text-ink">Add column</p>
              <input
                value={newColumnTitle}
                onChange={(event) => setNewColumnTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void createColumn()
                }}
                placeholder="Column title"
                aria-label="New column title"
                className="mh-input w-full"
                maxLength={200}
              />
              <button type="button" onClick={() => void createColumn()} disabled={creatingColumn} className="mh-btn mh-btn--secondary mh-btn--sm w-fit">
                {creatingColumn ? "Adding…" : "Add column"}
              </button>
            </div>
          </div>
        </DndContext>
      )}

      {confirmColumn && (
        <DeleteColumnDialog
          title={confirmColumn.title}
          cardCount={confirmColumn.cards.length}
          busy={deleting}
          onCancel={() => setConfirmDeleteColumnID(null)}
          onConfirm={() => void confirmDeleteColumn()}
        />
      )}

      {editingCard && (
        <EditCardDialog
          draft={cardDraft}
          onDraft={setCardDraft}
          busy={savingCard}
          onCancel={() => setEditingCard(null)}
          onSave={() => void saveCard()}
          onDelete={() => void deleteCard()}
        />
      )}
    </div>
  )
}

/** Compact sidebar panel for the Board section (replaces the "coming soon" text). */
export function BoardPanel({ workspaceID }: { workspaceID: string | null }) {
  const boardQuery = useBoard(client, workspaceID)
  const columns = boardQuery.data?.columns ?? []
  if (!workspaceID) {
    return (
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <p className="mh-body-sm text-ink-muted">Select a workspace to see its board.</p>
      </div>
    )
  }
  if (boardQuery.isPending) {
    return (
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <p className="mh-body-sm animate-pulse text-ink-muted">Loading board…</p>
      </div>
    )
  }
  if (boardQuery.isError || !boardQuery.data) {
    return (
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <p className="mh-body-sm text-ink-muted">Could not load the board.</p>
        <button type="button" onClick={() => void boardQuery.refetch()} className="mh-btn mh-btn--ghost mh-btn--sm mt-2">
          Retry
        </button>
      </div>
    )
  }
  if (columns.length === 0) {
    return (
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <p className="mh-body-sm text-ink-muted">Empty board — add the first column in the main view.</p>
      </div>
    )
  }
  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 py-3">
      {columns.map((column) => (
        <div key={column.id} className="mh-session-item">
          <span className="mh-session-item__top">
            <span className="mh-session-item__title">{column.title}</span>
            <span className="text-xs text-ink-muted" aria-label={`${column.cards.length} cards`}>
              {column.cards.length}
            </span>
          </span>
        </div>
      ))}
    </div>
  )
}
