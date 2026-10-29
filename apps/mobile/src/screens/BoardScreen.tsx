import { useCallback, useMemo, useRef, useState } from "react"
import { Alert, Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native"
import { Gesture, GestureDetector, ScrollView } from "react-native-gesture-handler"
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated"
import { useQueryClient } from "@tanstack/react-query"
import {
  queryKeys,
  useBoard,
  type BoardCard,
  type BoardColumn,
  type BoardSnapshot,
  type Client,
  type CreateWorkspaceInput,
  type WorkspaceRecord,
} from "@masterhand/client-core"
import { ChoiceModal } from "../components/ChoiceModal"
import { WorkspaceModal } from "../components/WorkspaceModal"
import { CheckIcon, CloseIcon, PlusIcon, TrashIcon } from "../components/icons"
import { useTheme, useThemedStyles, type Fonts, type Palette } from "../theme"

/**
 * Workspace kanban board (issue #164): one board per workspace over the
 * frozen `client-core` board contract. Cards drag within their column
 * (long-press + pan, committed as an absolute `(columnID, position)`); across
 * columns they travel through a "Move to…" picker, and reordering stays
 * reachable through Move up/down buttons. Every mutation is
 * idempotent-positional: the client commits optimistically then PATCHes the
 * absolute position, and a failure refetches with readable copy — never a
 * blind retry (`docs/past-mistakes.md`). `board.updated` frames write the
 * snapshot through the shared hooks, so this screen never polls.
 */

const CARD_GAP = 8

/**
 * Resets a card's drag state when its gesture is cancelled: `onFinalize` is
 * the only callback on cancel, so without this a scroll-stolen gesture leaves
 * the card visually offset at its last `onUpdate` value.
 *
 * Must stay a worklet: `onFinalize` runs on the UI runtime, and calling a
 * plain JS helper there throws "Tried to synchronously call a Remote
 * Function" and crashes the app (device-only).
 */
export function resetCancelledDrag(dragging: { value: boolean }, translateY: { value: number }): void {
  "worklet"
  dragging.value = false
  translateY.value = withSpring(0)
}
/** Fallback row height when a card has not reported its layout yet. */
const ESTIMATED_ROW_HEIGHT = 64

function newID(prefix: string): string {
  const uuid = `${Date.now()}-${Math.random().toString(36).slice(2)}`
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

/**
 * Drop index for a dragged card: the slot whose span contains the dragged
 * center, walked from measured row heights (card height + gap). Falls back
 * to an estimate for rows that never reported a layout (tests, first paint).
 * Exported for unit tests; the drag itself is device-only chrome.
 */
export function indexForDrop(cards: BoardCard[], from: number, dy: number, heights: Map<string, number>): number {
  if (cards.length === 0) return 0
  const tops: number[] = []
  let y = 0
  for (const card of cards) {
    tops.push(y)
    y += heights.get(card.id) ?? ESTIMATED_ROW_HEIGHT
  }
  const dragged = cards[from]
  if (!dragged) return from
  const center = tops[from]! + dy + ((heights.get(dragged.id) ?? ESTIMATED_ROW_HEIGHT) / 2)
  let target = 0
  for (let i = 0; i < cards.length; i++) {
    if (center >= tops[i]!) target = i
  }
  return Math.max(0, Math.min(cards.length - 1, target))
}

/**
 * One card: a long-press pan drags it within its column (the drop commits an
 * absolute position through `onDrop`), a tap opens the edit sheet. The drag
 * is device-only chrome — render suites drive the same commit through the
 * Move up/down buttons and the "Move to…" picker.
 */
function DraggableCard({
  card,
  onLayoutHeight,
  onDrop,
  onOpen,
}: {
  card: BoardCard
  onLayoutHeight: (id: string, height: number) => void
  onDrop: (cardID: string, dy: number) => void
  onOpen: (card: BoardCard) => void
}) {
  const styles = useThemedStyles(createStyles)
  const translateY = useSharedValue(0)
  const dragging = useSharedValue(false)
  const onDropRef = useRef(onDrop)
  onDropRef.current = onDrop
  // The worklet must only capture a function defined on the JS runtime (a
  // RemoteFunction). Capturing `onDropRef` itself serializes the ref into the
  // UI runtime — it is then frozen and every `current` write warns "already
  // passed to a worklet"; passing a locally created arrow to `runOnJS` throws.
  const dispatchDrop = useCallback((id: string, dy: number) => {
    onDropRef.current(id, dy)
  }, [])

  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .activateAfterLongPress(250)
        .onStart(() => {
          dragging.value = true
        })
        .onUpdate((event) => {
          translateY.value = event.translationY
        })
        .onEnd((event) => {
          dragging.value = false
          translateY.value = withSpring(0)
          runOnJS(dispatchDrop)(card.id, event.translationY)
        })
        .onFinalize(() => {
          resetCancelledDrag(dragging, translateY)
        }),
    [card.id, dispatchDrop, dragging, translateY],
  )
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }, { scale: dragging.value ? 1.03 : 1 }],
    zIndex: dragging.value ? 10 : 0,
  }))

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        onLayout={(event) => onLayoutHeight(card.id, event.nativeEvent.layout.height + CARD_GAP)}
        style={[styles.card, animatedStyle]}
      >
        <Pressable
          onPress={() => onOpen(card)}
          accessibilityRole="button"
          accessibilityLabel={`Edit card ${card.title}`}
        >
          <Text style={styles.cardTitle} numberOfLines={1}>
            {card.title}
          </Text>
          {card.description ? (
            <Text style={styles.cardDescription} numberOfLines={2}>
              {card.description}
            </Text>
          ) : null}
        </Pressable>
      </Animated.View>
    </GestureDetector>
  )
}

/** Edit-card sheet: title/description, within-column moves, cross-column picker, delete. */
function EditCardSheet({
  card,
  columns,
  error,
  onMove,
  onMoveStep,
  onSave,
  onDelete,
  onClose,
}: {
  card: BoardCard
  columns: BoardColumn[]
  error: string | null
  onMove: (cardID: string, columnID: string, position: number) => void
  onMoveStep: (cardID: string, direction: -1 | 1) => void
  onSave: (cardID: string, draft: { title: string; description: string }) => void
  onDelete: (card: BoardCard) => void
  onClose: () => void
}) {
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()
  const [draft, setDraft] = useState({ title: card.title, description: card.description })
  const [movePickerOpen, setMovePickerOpen] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  const others = columns.filter((entry) => entry.id !== card.columnID)

  function save() {
    const title = draft.title.trim()
    if (!title) {
      setLocalError("Give it a title (1–200 characters)")
      return
    }
    setLocalError(null)
    onSave(card.id, { title, description: draft.description })
  }

  // The Move-to picker is a sibling modal, never nested inside the sheet
  // modal: nested modals dismiss and stack unpredictably on device.
  return (
    <>
      <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <Text style={styles.sheetTitle}>Edit card</Text>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          {localError ? <Text style={styles.error}>{localError}</Text> : null}

          <Text style={styles.label}>Title</Text>
          <TextInput
            value={draft.title}
            onChangeText={(value) => setDraft({ ...draft, title: value })}
            accessibilityLabel="Card title"
            maxLength={200}
            style={styles.input}
          />
          <Text style={styles.label}>Description</Text>
          <TextInput
            value={draft.description}
            onChangeText={(value) => setDraft({ ...draft, description: value })}
            accessibilityLabel="Card description"
            multiline
            numberOfLines={4}
            maxLength={10000}
            style={[styles.input, styles.multiline]}
          />

          <View style={styles.moveRow}>
            <Pressable
              onPress={() => onMoveStep(card.id, -1)}
              accessibilityRole="button"
              accessibilityLabel="Move card up"
              style={styles.secondary}
            >
              <Text style={styles.secondaryText}>Move up</Text>
            </Pressable>
            <Pressable
              onPress={() => onMoveStep(card.id, 1)}
              accessibilityRole="button"
              accessibilityLabel="Move card down"
              style={styles.secondary}
            >
              <Text style={styles.secondaryText}>Move down</Text>
            </Pressable>
            {others.length > 0 ? (
              <Pressable
                onPress={() => setMovePickerOpen(true)}
                accessibilityRole="button"
                accessibilityLabel="Move card to…"
                style={styles.secondary}
              >
                <Text style={styles.secondaryText}>Move to…</Text>
              </Pressable>
            ) : null}
          </View>

          <View style={styles.sheetActions}>
            <Pressable
              onPress={() => onDelete(card)}
              accessibilityRole="button"
              accessibilityLabel="Delete card"
              style={styles.danger}
            >
              <TrashIcon size={14} color={colors.danger} />
              <Text style={styles.dangerText}>Delete</Text>
            </Pressable>
            <View style={styles.spacer} />
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Cancel"
              style={styles.secondary}
            >
              <Text style={styles.secondaryText}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={save}
              accessibilityRole="button"
              accessibilityLabel="Save card"
              style={styles.primary}
            >
              <Text style={styles.primaryText}>Save</Text>
            </Pressable>
          </View>
        </View>
      </View>
      </Modal>

      <ChoiceModal
        visible={movePickerOpen}
        title="Move card to…"
        options={others.map((entry) => ({ value: entry.id, label: entry.title }))}
        selected=""
        onSelect={(columnID) => {
          const destination = columns.find((entry) => entry.id === columnID)
          if (destination) onMove(card.id, columnID, destination.cards.length)
        }}
        onClose={() => setMovePickerOpen(false)}
      />
    </>
  )
}

export function BoardScreen({
  client,
  workspaceID,
  workspaces,
  onSelectWorkspace,
  onAddWorkspace,
  onRemoveWorkspace,
}: {
  client: Client
  workspaceID: string | null
  workspaces: WorkspaceRecord[]
  onSelectWorkspace: (id: string) => void
  onAddWorkspace: (input: CreateWorkspaceInput) => Promise<void>
  onRemoveWorkspace: (id: string, options: { deleteFiles: boolean }) => void
}) {
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()
  const queryClient = useQueryClient()
  const boardQuery = useBoard(client, workspaceID)
  const board = boardQuery.data ?? null
  const columns = useMemo(() => board?.columns ?? [], [board])

  const [workspaceOpen, setWorkspaceOpen] = useState(false)
  const [newColumnTitle, setNewColumnTitle] = useState("")
  const [creatingColumn, setCreatingColumn] = useState(false)
  const [newCardTitles, setNewCardTitles] = useState<Record<string, string>>({})
  const [creatingCardColumn, setCreatingCardColumn] = useState<string | null>(null)
  const [editingColumnID, setEditingColumnID] = useState<string | null>(null)
  const [editingColumnTitle, setEditingColumnTitle] = useState("")
  const [editingCard, setEditingCard] = useState<BoardCard | null>(null)
  const [error, setError] = useState<string | null>(null)
  const lastDragEndRef = useRef(0)
  const rowHeights = useRef(new Map<string, number>())

  const workspace = workspaces.find((item) => item.id === workspaceID) ?? null

  function failBoard(failure: unknown) {
    void queryClient.invalidateQueries({ queryKey: queryKeys.board(workspaceID) })
    setError(boardErrorMessage(failure))
  }

  function liveSnapshot(): BoardSnapshot | null {
    return queryClient.getQueryData<BoardSnapshot>(queryKeys.board(workspaceID)) ?? board ?? null
  }

  /** Within-column step from the edit sheet, resolved against the live snapshot. */
  function moveCardStep(cardID: string, direction: -1 | 1) {
    const base = liveSnapshot()
    if (!base) return
    for (const column of base.columns) {
      const index = column.cards.findIndex((card) => card.id === cardID)
      if (index < 0) continue
      const target = Math.max(0, Math.min(column.cards.length - 1, index + direction))
      if (target === index) return
      void commitCardMove(cardID, column.id, target)
      return
    }
  }

  /** Commits an absolute `(columnID, position)` with an optimistic reorder. */
  async function commitCardMove(cardID: string, targetColumnID: string, position: number) {
    const previous = liveSnapshot()
    if (!previous) return
    const source = previous.columns.find((column) => column.cards.some((card) => card.id === cardID))
    const destination = previous.columns.find((column) => column.id === targetColumnID)
    if (!source || !destination) return
    const fromIndex = source.cards.findIndex((card) => card.id === cardID)
    if (fromIndex < 0) return
    const clamped = Math.max(0, Math.min(position, destination.cards.length - (source.id === destination.id ? 1 : 0)))
    if (source.id === destination.id && clamped === fromIndex) return
    // Optimistic reorder, then the absolute position. Snapshots are rebuilt
    // (never mutated) so concurrent readers keep a stable reference.
    const next: BoardSnapshot = {
      ...previous,
      columns: previous.columns.map((column) => ({ ...column, cards: [...column.cards] })),
    }
    const nextSource = next.columns.find((column) => column.id === source.id)!
    const nextDestination = next.columns.find((column) => column.id === destination.id)!
    const [moved] = nextSource.cards.splice(fromIndex, 1)
    if (!moved) return
    nextDestination.cards.splice(Math.min(clamped, nextDestination.cards.length), 0, {
      ...moved,
      columnID: nextDestination.id,
    })
    const reindexed = next.columns.map((column) =>
      column.id === nextSource.id || column.id === nextDestination.id
        ? { ...column, cards: column.cards.map((card, cardIndex) => ({ ...card, position: cardIndex })) }
        : column,
    )
    queryClient.setQueryData<BoardSnapshot>(queryKeys.board(workspaceID), { ...next, columns: reindexed })
    try {
      await client.api.board.updateCard(cardID, { columnID: targetColumnID, position: clamped })
      await queryClient.invalidateQueries({ queryKey: queryKeys.board(workspaceID) })
    } catch (moveError) {
      failBoard(moveError)
    }
  }

  const commitCardMoveRef = useRef(commitCardMove)
  commitCardMoveRef.current = commitCardMove

  /** Drop handler for the within-column drag: resolves the index from the dy. */
  const dropCard = useCallback(
    (cardID: string, dy: number) => {
      lastDragEndRef.current = Date.now()
      const base = queryClient.getQueryData<BoardSnapshot>(queryKeys.board(workspaceID)) ?? boardQuery.data ?? null
      if (!base) return
      for (const column of base.columns) {
        const index = column.cards.findIndex((card) => card.id === cardID)
        if (index < 0) continue
        const target = indexForDrop(column.cards, index, dy, rowHeights.current)
        if (target === index) return
        void commitCardMoveRef.current(cardID, column.id, target)
        return
      }
    },
    [boardQuery.data, queryClient, workspaceID],
  )

  function openCard(card: BoardCard) {
    // A drag ends with a tap on the card; ignore the tap that immediately
    // follows a drop so the sheet does not pop open on every drag.
    if (Date.now() - lastDragEndRef.current < 250) return
    setError(null)
    // Resolve the live card so the sheet never edits a stale snapshot.
    const live = liveSnapshot()
    let current = card
    if (live) {
      for (const column of live.columns) {
        const found = column.cards.find((entry) => entry.id === card.id)
        if (found) current = found
      }
    }
    setEditingCard(current)
  }

  async function saveCard(cardID: string, draft: { title: string; description: string }) {
    setError(null)
    try {
      await client.api.board.updateCard(cardID, { title: draft.title, description: draft.description })
      setEditingCard(null)
      await queryClient.invalidateQueries({ queryKey: queryKeys.board(workspaceID) })
    } catch (saveError) {
      failBoard(saveError)
    }
  }

  function confirmDeleteCard(card: BoardCard) {
    Alert.alert(`Delete card?`, `Delete "${card.title}"? This cannot be undone.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          void (async () => {
            setError(null)
            try {
              await client.api.board.deleteCard(card.id)
              setEditingCard(null)
              await queryClient.invalidateQueries({ queryKey: queryKeys.board(workspaceID) })
            } catch (deleteError) {
              failBoard(deleteError)
            }
          })()
        },
      },
    ])
  }

  async function createColumn() {
    if (!workspaceID) {
      setError("Select a workspace first")
      return
    }
    const title = newColumnTitle.trim()
    if (!title) {
      setError("Give it a title (1–200 characters)")
      return
    }
    setCreatingColumn(true)
    setError(null)
    try {
      await client.api.board.createColumn(workspaceID, { id: newID("col"), title })
      setNewColumnTitle("")
      await queryClient.invalidateQueries({ queryKey: queryKeys.board(workspaceID) })
    } catch (createError) {
      failBoard(createError)
    } finally {
      setCreatingColumn(false)
    }
  }

  async function renameColumn(columnID: string) {
    const title = editingColumnTitle.trim()
    if (!title) {
      setError("Give it a title (1–200 characters)")
      return
    }
    setError(null)
    try {
      await client.api.board.updateColumn(columnID, { title })
      setEditingColumnID(null)
      await queryClient.invalidateQueries({ queryKey: queryKeys.board(workspaceID) })
    } catch (renameError) {
      failBoard(renameError)
    }
  }

  async function moveColumn(columnID: string, direction: -1 | 1) {
    const base = liveSnapshot()
    if (!base) return
    const index = base.columns.findIndex((column) => column.id === columnID)
    if (index < 0) return
    const next = index + direction
    if (next < 0 || next >= base.columns.length) return
    const reordered = [...base.columns]
    const [moved] = reordered.splice(index, 1)
    reordered.splice(next, 0, moved!)
    queryClient.setQueryData<BoardSnapshot>(queryKeys.board(workspaceID), {
      ...base,
      columns: reordered.map((column, position) => ({ ...column, position })),
    })
    setError(null)
    try {
      await client.api.board.updateColumn(columnID, { position: next })
      await queryClient.invalidateQueries({ queryKey: queryKeys.board(workspaceID) })
    } catch (moveError) {
      failBoard(moveError)
    }
  }

  function columnOptions(column: BoardColumn, index: number, total: number) {
    const buttons: Array<{ text: string; onPress?: () => void; style?: "cancel" | "destructive" }> = []
    if (index > 0) buttons.push({ text: "Move left", onPress: () => void moveColumn(column.id, -1) })
    if (index < total - 1) buttons.push({ text: "Move right", onPress: () => void moveColumn(column.id, 1) })
    buttons.push({ text: "Delete column…", onPress: () => confirmDeleteColumn(column) })
    buttons.push({ text: "Cancel", style: "cancel" })
    Alert.alert("Column options", column.title, buttons)
  }

  function confirmDeleteColumn(column: BoardColumn) {
    const count = column.cards.length
    Alert.alert(
      "Delete column?",
      `"${column.title}" and its ${count} ${count === 1 ? "card" : "cards"} will be deleted. This cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: `Delete column and ${count} ${count === 1 ? "card" : "cards"}`,
          style: "destructive",
          onPress: () => {
            void (async () => {
              setError(null)
              try {
                await client.api.board.deleteColumn(column.id)
                await queryClient.invalidateQueries({ queryKey: queryKeys.board(workspaceID) })
              } catch (deleteError) {
                failBoard(deleteError)
              }
            })()
          },
        },
      ],
    )
  }

  async function createCard(columnID: string) {
    const title = (newCardTitles[columnID] ?? "").trim()
    if (!title) {
      setError("Give it a title (1–200 characters)")
      return
    }
    setCreatingCardColumn(columnID)
    setError(null)
    try {
      await client.api.board.createCard({ id: newID("card"), columnID, title })
      setNewCardTitles((prev) => ({ ...prev, [columnID]: "" }))
      await queryClient.invalidateQueries({ queryKey: queryKeys.board(workspaceID) })
    } catch (createError) {
      failBoard(createError)
    } finally {
      setCreatingCardColumn(null)
    }
  }

  const workspaceBar = (
    <Pressable
      onPress={() => setWorkspaceOpen(true)}
      accessibilityRole="button"
      accessibilityLabel="Workspace"
      style={styles.workspaceBar}
    >
      <Text style={styles.workspaceLabel}>Workspace</Text>
      <Text style={styles.workspaceName} numberOfLines={1}>
        {workspace ? workspace.name : "Add a workspace"}
      </Text>
      <Text style={styles.chevron}>▾</Text>
    </Pressable>
  )

  const workspaceModal = (
    <WorkspaceModal
      visible={workspaceOpen}
      workspaces={workspaces}
      selectedID={workspaceID}
      onSelect={onSelectWorkspace}
      onAdd={onAddWorkspace}
      onRemove={(id, options) => {
        setWorkspaceOpen(false)
        confirmRemoveWorkspace(id, options)
      }}
      onClose={() => setWorkspaceOpen(false)}
    />
  )

  function confirmRemoveWorkspace(id: string, options: { deleteFiles: boolean }) {
    Alert.alert(
      "Remove workspace",
      options.deleteFiles
        ? "The folder and all its files will be deleted. Sessions are kept."
        : "Files and sessions are not deleted.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Remove", style: "destructive", onPress: () => onRemoveWorkspace(id, options) },
      ],
    )
  }

  if (!workspaceID) {
    return (
      <View style={styles.section}>
        {workspaceBar}
        <View style={styles.centerBox}>
          <Text style={styles.title}>Board</Text>
          <Text style={styles.muted}>Add a workspace first — each workspace has its own board.</Text>
        </View>
        {workspaceModal}
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>
    )
  }

  if (boardQuery.isPending) {
    return (
      <View style={styles.section}>
        {workspaceBar}
        <Text style={styles.muted}>Loading board…</Text>
        {workspaceModal}
      </View>
    )
  }

  if (boardQuery.isError) {
    return (
      <View style={styles.section}>
        {workspaceBar}
        <View style={styles.centerBox}>
          <Text style={styles.title}>Board</Text>
          <Text style={styles.muted}>Could not load the board.</Text>
          <Pressable
            onPress={() => void boardQuery.refetch()}
            accessibilityRole="button"
            accessibilityLabel="Retry"
            style={styles.secondary}
          >
            <Text style={styles.secondaryText}>Retry</Text>
          </Pressable>
        </View>
        {workspaceModal}
      </View>
    )
  }

  return (
    <View style={styles.section}>
      {workspaceBar}
      <Text style={styles.count} accessibilityLiveRegion="polite">
        {columns.length === 0 ? "Empty board" : `${columns.length} ${columns.length === 1 ? "column" : "columns"}`}
      </Text>

      {columns.length === 0 ? (
        <View style={styles.centerBox}>
          <Text style={styles.title}>Board</Text>
          <Text style={styles.muted}>This workspace has no columns yet. Add the first one to start tracking work.</Text>
          <View style={styles.newColumnRow}>
            <TextInput
              value={newColumnTitle}
              onChangeText={setNewColumnTitle}
              placeholder="New column (e.g. To do)"
              placeholderTextColor={colors.textFaint}
              accessibilityLabel="New column title"
              maxLength={200}
              style={styles.input}
            />
            <Pressable
              onPress={() => void createColumn()}
              disabled={creatingColumn}
              accessibilityRole="button"
              accessibilityLabel="Add column"
              style={styles.primary}
            >
              <PlusIcon size={16} color={colors.onAccent} />
            </Pressable>
          </View>
        </View>
      ) : (
        <ScrollView horizontal contentContainerStyle={styles.columnsRow} showsHorizontalScrollIndicator={false}>
          {columns.map((column, columnIndex) => (
            <View key={column.id} style={styles.column} accessibilityLabel={`Column ${column.title}`}>
              <View style={styles.columnHeader}>
                {editingColumnID === column.id ? (
                  <>
                    <TextInput
                      value={editingColumnTitle}
                      onChangeText={setEditingColumnTitle}
                      accessibilityLabel="Column title"
                      maxLength={200}
                      autoFocus
                      style={[styles.input, styles.columnRename]}
                    />
                    <Pressable
                      onPress={() => void renameColumn(column.id)}
                      accessibilityRole="button"
                      accessibilityLabel="Save column title"
                      style={styles.iconButton}
                    >
                      <CheckIcon size={16} color={colors.accent} />
                    </Pressable>
                    <Pressable
                      onPress={() => setEditingColumnID(null)}
                      accessibilityRole="button"
                      accessibilityLabel="Cancel rename"
                      style={styles.iconButton}
                    >
                      <CloseIcon size={16} color={colors.textMuted} />
                    </Pressable>
                  </>
                ) : (
                  <>
                    <Pressable
                      onPress={() => {
                        setEditingColumnID(column.id)
                        setEditingColumnTitle(column.title)
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={`Rename column ${column.title}`}
                      style={styles.columnTitleButton}
                    >
                      <Text style={styles.columnTitle} numberOfLines={1}>
                        {column.title}
                      </Text>
                    </Pressable>
                    <Text
                      style={styles.countBadge}
                      accessibilityLabel={`${column.cards.length} ${column.cards.length === 1 ? "card" : "cards"}`}
                    >
                      {column.cards.length}
                    </Text>
                    <Pressable
                      onPress={() => columnOptions(column, columnIndex, columns.length)}
                      accessibilityRole="button"
                      accessibilityLabel="Column options"
                      style={styles.iconButton}
                    >
                      <Text style={styles.ellipsis}>⋯</Text>
                    </Pressable>
                  </>
                )}
              </View>

              <View style={styles.cards}>
                {column.cards.map((card) => (
                  <DraggableCard
                    key={card.id}
                    card={card}
                    onLayoutHeight={(id, height) => rowHeights.current.set(id, height)}
                    onDrop={dropCard}
                    onOpen={openCard}
                  />
                ))}
                {column.cards.length === 0 ? (
                  <Text style={styles.muted}>No cards — add one below.</Text>
                ) : null}
              </View>

              <View style={styles.quickAdd}>
                <TextInput
                  value={newCardTitles[column.id] ?? ""}
                  onChangeText={(value) => setNewCardTitles((prev) => ({ ...prev, [column.id]: value }))}
                  placeholder="New card"
                  placeholderTextColor={colors.textFaint}
                  accessibilityLabel={`New card title in ${column.title}`}
                  maxLength={200}
                  style={[styles.input, styles.quickAddInput]}
                />
                <Pressable
                  onPress={() => void createCard(column.id)}
                  disabled={creatingCardColumn === column.id}
                  accessibilityRole="button"
                  accessibilityLabel={`Add card to ${column.title}`}
                  style={styles.iconButton}
                >
                  <PlusIcon size={16} color={colors.textMuted} />
                </Pressable>
              </View>
            </View>
          ))}

          <View style={styles.column}>
            <Text style={styles.columnTitle}>Add column</Text>
            <View style={styles.quickAdd}>
              <TextInput
                value={newColumnTitle}
                onChangeText={setNewColumnTitle}
                placeholder="Column title"
                placeholderTextColor={colors.textFaint}
                accessibilityLabel="New column title"
                maxLength={200}
                style={[styles.input, styles.quickAddInput]}
              />
              <Pressable
                onPress={() => void createColumn()}
                disabled={creatingColumn}
                accessibilityRole="button"
                accessibilityLabel="Add column"
                style={styles.iconButton}
              >
                <PlusIcon size={16} color={colors.textMuted} />
              </Pressable>
            </View>
          </View>
        </ScrollView>
      )}

      {error && !editingCard ? <Text style={styles.error}>{error}</Text> : null}
      {workspaceModal}

      {editingCard ? (
        <EditCardSheet
          key={editingCard.id}
          card={editingCard}
          columns={columns}
          error={error}
          onMove={(cardID, columnID, position) => void commitCardMove(cardID, columnID, position)}
          onMoveStep={(cardID, direction) => moveCardStep(cardID, direction)}
          onSave={(cardID, draft) => void saveCard(cardID, draft)}
          onDelete={confirmDeleteCard}
          onClose={() => setEditingCard(null)}
        />
      ) : null}
    </View>
  )
}

function createStyles(colors: Palette, fonts: Fonts) {
  return StyleSheet.create({
    section: {
      gap: 8,
      paddingHorizontal: 12,
      paddingTop: 10,
      paddingBottom: 24,
    },
    workspaceBar: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      minHeight: 44,
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.hairline,
    },
    workspaceLabel: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 11,
      letterSpacing: 0.8,
      textTransform: "uppercase",
      fontWeight: "600",
    },
    workspaceName: {
      flex: 1,
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 14,
      fontWeight: "600",
    },
    chevron: {
      color: colors.textMuted,
      fontSize: 12,
    },
    centerBox: {
      alignItems: "center",
      gap: 8,
      paddingVertical: 32,
      paddingHorizontal: 24,
    },
    title: {
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 16,
      fontWeight: "600",
    },
    count: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 12,
    },
    muted: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 13,
      textAlign: "center",
    },
    error: {
      color: colors.danger,
      fontFamily: fonts.ui,
      fontSize: 12,
    },
    newColumnRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      width: "100%",
    },
    columnsRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 12,
      paddingBottom: 8,
    },
    column: {
      width: 280,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      borderRadius: 12,
      backgroundColor: colors.canvas,
      padding: 8,
      gap: 8,
    },
    columnHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
    },
    columnTitleButton: {
      flex: 1,
      minHeight: 44,
      justifyContent: "center",
    },
    columnTitle: {
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 14,
      fontWeight: "600",
    },
    countBadge: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      borderRadius: 999,
      paddingHorizontal: 6,
    },
    ellipsis: {
      color: colors.textMuted,
      fontSize: 18,
      lineHeight: 22,
    },
    iconButton: {
      alignItems: "center",
      justifyContent: "center",
      minHeight: 44,
      minWidth: 44,
    },
    columnRename: {
      flex: 1,
      marginTop: 0,
    },
    cards: {
      gap: CARD_GAP,
    },
    card: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      borderRadius: 12,
      backgroundColor: colors.surface,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    cardTitle: {
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 14,
      fontWeight: "600",
    },
    cardDescription: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 12,
      marginTop: 2,
    },
    quickAdd: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
    },
    quickAddInput: {
      flex: 1,
      marginTop: 0,
    },
    label: {
      marginTop: 12,
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 12,
    },
    input: {
      minHeight: 44,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairlineStrong,
      backgroundColor: colors.surface,
      borderRadius: 12,
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 14,
      paddingHorizontal: 12,
      paddingVertical: 10,
      marginTop: 6,
    },
    multiline: {
      minHeight: 88,
      textAlignVertical: "top",
    },
    backdrop: {
      flex: 1,
      justifyContent: "flex-end",
      backgroundColor: colors.overlay,
    },
    sheet: {
      maxHeight: "85%",
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      backgroundColor: colors.surface,
      padding: 16,
      paddingBottom: 24,
      gap: 2,
    },
    sheetTitle: {
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 16,
      fontWeight: "600",
    },
    moveRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
      marginTop: 12,
    },
    sheetActions: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      marginTop: 16,
    },
    spacer: {
      flex: 1,
    },
    primary: {
      minHeight: 44,
      minWidth: 44,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.accent,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    primaryText: {
      color: colors.onAccent,
      fontFamily: fonts.ui,
      fontSize: 14,
      fontWeight: "500",
    },
    secondary: {
      minHeight: 44,
      justifyContent: "center",
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairlineStrong,
      backgroundColor: colors.surface,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    secondaryText: {
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 14,
      fontWeight: "500",
    },
    danger: {
      minHeight: 44,
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      justifyContent: "center",
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.dangerLine,
      backgroundColor: colors.dangerSoft,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    dangerText: {
      color: colors.danger,
      fontFamily: fonts.ui,
      fontSize: 14,
      fontWeight: "500",
    },
  })
}
