import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native"
import {
  sessionUsage,
  useBffStatus,
  useMessages,
  usePendingSend,
  usePreview,
  useSessionRun,
  type ChatMessage,
  type Client,
  type CreateWorkspaceInput,
  type FormAnswer,
  type FormInfo,
  type WorkspaceRecord,
} from "@masterhand/client-core"
import { Composer, type ComposerHandle } from "../components/Composer"
import { BranchViewer } from "../components/BranchViewer"
import { SessionToolbar } from "../components/SessionToolbar"
import { SessionStats } from "../components/SessionStats"
import { GoalReview } from "../components/GoalReview"
import { GoalStrip } from "../components/GoalStrip"
import { MessageBubble } from "../components/MessageBubble"
import { PendingBubble } from "../components/PendingBubble"
import { AuditModal } from "../components/AuditModal"
import { RunPreviewModal } from "../components/RunPreviewModal"
import { Screen } from "../components/Screen"
import { Deco } from "../components/Deco"
import { ArrowDownIcon, ArrowUpIcon, PlayIcon } from "../components/icons"
import { useTheme, useThemedStyles, type Fonts, type Palette } from "../theme"

/** Newest messages rendered when a session opens. */
const INITIAL_VISIBLE = 10
/** How many older messages each tap of the history pill reveals. */
const OLDER_PAGE = 20
/** Distance from the bottom (inverted offset 0) that still counts as "following". */
const FOLLOW_THRESHOLD = 12
/** Distance from the bottom that reveals the jump-to-latest shortcut. */
const JUMP_THRESHOLD = 120

export function ChatScreen({
  client,
  sessionID,
  title,
  busy,
  connected,
  workspaceID,
  workspacePath = null,
  autoAccept,
  onToggleAutoAccept,
  onOpenSession,
  parentSessionID,
  onBack,
  forms = [],
  answeredForms = [],
  busyFormID = null,
  onRespondForm,
  onCancelForm,
  waitingQuestion = false,
  onOpenWaiting,
  workspaces = [],
  onSelectWorkspace,
  onAddWorkspace,
  onRemoveWorkspace,
}: {
  client: Client
  sessionID: string
  title: string
  busy: boolean
  connected: boolean
  workspaceID: string | null
  workspacePath?: string | null
  autoAccept: boolean
  onToggleAutoAccept: (on: boolean) => void
  onOpenSession?: (id: string) => void
  parentSessionID?: string | null
  onBack: () => void
  forms?: FormInfo[]
  answeredForms?: Array<{ form: FormInfo; answer: FormAnswer }>
  busyFormID?: string | null
  onRespondForm?: (form: FormInfo, answer: FormAnswer) => void
  onCancelForm?: (form: FormInfo) => void
  /** A question from another session is blocking its agent. */
  waitingQuestion?: boolean
  onOpenWaiting?: () => void
  /** Workspace management for the composer top bar (#92). */
  workspaces?: WorkspaceRecord[]
  onSelectWorkspace?: (id: string) => void
  onAddWorkspace?: (input: CreateWorkspaceInput) => Promise<void>
  onRemoveWorkspace?: (id: string, options: { deleteFiles: boolean }) => void
}) {
  const messagesQuery = useMessages(client, sessionID, { busy, connected })
  const pendingSend = usePendingSend(sessionID)
  const composerRef = useRef<ComposerHandle>(null)
  const statusQuery = useBffStatus(client)
  const previewEnabled = statusQuery.data?.preview?.enabled === true
  // Aggregated dev-server state for the single Run & preview control (#99).
  const runStateQuery = useSessionRun(client, sessionID, workspaceID)
  const previewStateQuery = usePreview(client, sessionID, previewEnabled)
  const [runPreviewOpen, setRunPreviewOpen] = useState(false)
  const [auditOpen, setAuditOpen] = useState(false)
  const listRef = useRef<FlatList<ChatMessage>>(null)
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()
  const messages = messagesQuery.data ?? []
  const usage = useMemo(() => sessionUsage(messages), [messages])
  // Follow-output scroll: only stay pinned when the user is already near the
  // bottom AND not actively scrolling. `onContentSizeChange` covers both new
  // messages and the growing goal-review footer; expanding a round is local
  // state and must NOT yank the user when they scrolled up.
  //
  // The list is inverted (newest first, rendered bottom-up), so offset 0 IS
  // the bottom: entering a session starts at the newest message with no
  // scroll of any kind — no mount-at-top flash, no entry pin, no animation.
  const followRef = useRef(true)
  const userScrollingRef = useRef(false)
  // Viewport/content heights, used only to decide whether hidden history is
  // reachable when the visible rows do not fill the screen.
  const viewportHeightRef = useRef(0)
  const contentHeightRef = useRef(0)
  // A reveal grows the content below the (inverted) viewport: the matching
  // size-change event must not trigger the follow-output snap.
  const pendingRevealsRef = useRef(0)

  // Reversed so the newest message is index 0, which the inverted list anchors
  // at the visual bottom.
  const orderedMessages = useMemo(() => [...messages].reverse(), [messages])

  // Reader state for the visible window. It is keyed by session so switching
  // sessions (Back to main agent, subagent links) never paints the previous
  // session's frozen window or jump button on the first frame.
  //
  // `hidden` is how many of the oldest (chronological) messages are hidden.
  // `null` means "pinned to the bottom": the window follows the newest 10.
  // Once the reader scrolls up we freeze the count so new messages never
  // unload the row they are reading; revealing history decrements it. The
  // full cache is never touched — only the list data is sliced.
  const [view, setView] = useState<{
    sessionID: string
    hidden: number | null
    showJump: boolean
    overflows: boolean | null
  }>(() => ({ sessionID, hidden: null, showJump: false, overflows: null }))
  if (view.sessionID !== sessionID) {
    // Render-phase reset (documented "adjust state on prop change" pattern):
    // the derived values below already fall back to the new session's defaults,
    // and React re-renders before committing children.
    setView({ sessionID, hidden: null, showJump: false, overflows: null })
  }
  const hidden = view.sessionID === sessionID ? view.hidden : null
  const showJump = view.sessionID === sessionID ? view.showJump : false
  const contentOverflows = view.sessionID === sessionID ? view.overflows : null

  const totalRef = useRef(0)
  useEffect(() => {
    totalRef.current = orderedMessages.length
  }, [orderedMessages.length])

  const pinnedHidden = Math.max(0, orderedMessages.length - INITIAL_VISIBLE)
  // Never hide every row, even if the cached projection shrinks under us.
  const olderCount = Math.min(
    hidden ?? pinnedHidden,
    Math.max(0, orderedMessages.length - 1),
  )
  const visibleMessages = useMemo(
    () => orderedMessages.slice(0, Math.max(0, orderedMessages.length - olderCount)),
    [orderedMessages, olderCount],
  )
  const nextBatch = Math.min(OLDER_PAGE, olderCount)
  const hasOlder = nextBatch > 0
  // Only while the reader is scrolled up — plus the case where the visible
  // rows do not fill the viewport (nothing to scroll, so history would
  // otherwise be unreachable).
  const showOlder = hasOlder && (showJump || contentOverflows === false)

  useEffect(() => {
    followRef.current = true
    userScrollingRef.current = false
    pendingRevealsRef.current = 0
    viewportHeightRef.current = 0
    contentHeightRef.current = 0
  }, [sessionID])

  /** Recompute whether the content exceeds the viewport (both layout events). */
  const applyOverflow = useCallback(
    (height: number) => {
      const viewport = viewportHeightRef.current
      if (viewport <= 0 || height <= 0) return
      const overflows = height > viewport + 1
      setView((prev) =>
        prev.sessionID === sessionID && prev.overflows !== overflows
          ? { ...prev, overflows }
          : prev,
      )
    },
    [sessionID],
  )

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      // Inverted list: distance from the newest message is the offset itself.
      // Follow only when the reader is truly at the bottom (a few px of
      // tolerance). The jump shortcut keeps its own, wider threshold so a
      // reader parked 100 px away is never snapped back by streaming output.
      const atBottom = event.nativeEvent.contentOffset.y < FOLLOW_THRESHOLD
      followRef.current = atBottom
      setView((prev) => {
        if (prev.sessionID !== sessionID) return prev
        const nextShowJump = prev.showJump
          ? !atBottom
          : event.nativeEvent.contentOffset.y > JUMP_THRESHOLD
        // Freeze the window the first time the reader leaves the bottom;
        // compact back as soon as they return (the dropped rows are above the
        // viewport).
        const nextHidden = atBottom
          ? null
          : (prev.hidden ?? Math.max(0, totalRef.current - INITIAL_VISIBLE))
        if (prev.showJump === nextShowJump && prev.hidden === nextHidden) return prev
        return { ...prev, showJump: nextShowJump, hidden: nextHidden }
      })
    },
    [sessionID],
  )

  const handleScrollBegin = useCallback(() => {
    userScrollingRef.current = true
    // A reveal queued before the gesture is stale now; do not swallow the
    // next real content-size event (e.g. the streaming re-anchor).
    pendingRevealsRef.current = 0
  }, [])

  const handleScrollEnd = useCallback(() => {
    userScrollingRef.current = false
  }, [])

  const handleListLayout = useCallback(
    (event: LayoutChangeEvent) => {
      viewportHeightRef.current = event.nativeEvent.layout.height
      applyOverflow(contentHeightRef.current)
    },
    [applyOverflow],
  )

  const handleContentSizeChange = useCallback(
    (_width: number, height: number) => {
      if (typeof height === "number" && height > 0) {
        contentHeightRef.current = height
        applyOverflow(height)
      }
      if (pendingRevealsRef.current > 0) {
        pendingRevealsRef.current -= 1
        return
      }
      if (userScrollingRef.current || !followRef.current) return
      listRef.current?.scrollToOffset({ offset: 0, animated: false })
    },
    [applyOverflow],
  )

  const scrollToBottom = useCallback(() => {
    followRef.current = true
    setView((prev) =>
      prev.sessionID === sessionID ? { ...prev, hidden: null, showJump: false } : prev,
    )
    // Instant by design: the shortcut is "get me there now", not a ride.
    listRef.current?.scrollToOffset({ offset: 0, animated: false })
  }, [sessionID])

  /**
   * Reveal the next page of older messages. On an inverted list this only
   * appends rows after the existing data, so every visible row keeps its key,
   * index and position: the viewport must not move (no scroll call here).
   */
  const revealOlder = useCallback(() => {
    pendingRevealsRef.current += 1
    setView((prev) => {
      if (prev.sessionID !== sessionID) return prev
      const base = prev.hidden ?? Math.max(0, totalRef.current - INITIAL_VISIBLE)
      return { ...prev, hidden: Math.max(0, base - OLDER_PAGE) }
    })
  }, [sessionID])

  const keyExtractor = useCallback((entry: ChatMessage) => entry.info.id, [])

  const listFooter = useMemo(
    () => (
      <>
        <GoalReview client={client} sessionID={sessionID} onOpenSession={onOpenSession} />
        {pendingSend.pending ? (
          <PendingBubble
            pending={pendingSend.pending}
            onRetry={() => composerRef.current?.retry()}
            onDismiss={pendingSend.dismiss}
          />
        ) : null}
      </>
    ),
    [client, sessionID, onOpenSession, pendingSend.pending, pendingSend.dismiss],
  )

  const renderItem = useCallback(
    ({ item }: { item: ChatMessage }) => (
      <MessageBubble
        entry={item}
        onOpenSession={onOpenSession}
        forms={forms}
        answeredForms={answeredForms}
        busyFormID={busyFormID}
        onRespondForm={onRespondForm}
        onCancelForm={onCancelForm}
      />
    ),
    [onOpenSession, forms, answeredForms, busyFormID, onRespondForm, onCancelForm],
  )

  const header = (
    <SessionToolbar
      workspaces={workspaces}
      workspaceID={workspaceID}
      onSelectWorkspace={(id) => onSelectWorkspace?.(id)}
      onAddWorkspace={async (input) => {
        await onAddWorkspace?.(input)
      }}
      onRemoveWorkspace={(id, options) => onRemoveWorkspace?.(id, options)}
      branch={workspaceID ? <BranchViewer client={client} workspaceID={workspaceID} /> : undefined}
      trailing={<SessionStats usage={usage} />}
    />
  )

  return (
    <Screen>
      <View style={styles.header}>
        <Pressable
          onPress={onBack}
          style={styles.back}
          hitSlop={4}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>
          {title || "Session"}
        </Text>
        <Pressable style={styles.actionButton} onPress={() => setAuditOpen(true)}>
          <Text style={styles.actionText}>Log</Text>
        </Pressable>
        {workspaceID ? (
          <Pressable
            style={styles.actionButton}
            accessibilityRole="button"
            accessibilityLabel="Run and preview"
            onPress={() => setRunPreviewOpen(true)}
          >
            <PlayIcon size={18} color={colors.accent} />
            <View
              style={[
                styles.dot,
                {
                  backgroundColor:
                    runStateQuery.data?.status === "running" ||
                    (previewEnabled && previewStateQuery.data?.status === "running")
                      ? colors.success
                      : runStateQuery.data?.status === "error" ||
                          (previewEnabled && previewStateQuery.data?.status === "error")
                        ? colors.danger
                        : colors.hairlineStrong,
                },
              ]}
            />
          </Pressable>
        ) : null}
        <View style={[styles.dot, { backgroundColor: connected ? colors.success : colors.warning }]} />
      </View>

      {waitingQuestion ? (
        <Pressable style={styles.waitingBar} onPress={onOpenWaiting}>
          <View style={styles.waitingDot} />
          <Text style={styles.waitingText} numberOfLines={1}>
            The agent is waiting for your answer · Open session
          </Text>
        </Pressable>
      ) : null}

      <View style={styles.listWrap}>
        {messages.length === 0 ? (
          <View style={styles.listWrap}>
            {messagesQuery.isLoading ? (
              <Text style={styles.empty}>Loading conversation…</Text>
            ) : (
              <View style={styles.emptyWrap}>
                <Deco variant="dots" style={styles.emptyDeco} />
                <Text style={styles.emptyTitle}>Write a message to start working with the agent.</Text>
              </View>
            )}
            {/* Goals and the pending ghost stay reachable without history. */}
            {listFooter}
          </View>
        ) : (
          <FlatList
            ref={listRef}
            testID="chat-list"
            inverted
            data={visibleMessages}
            keyExtractor={keyExtractor}
            renderItem={renderItem}
            contentContainerStyle={styles.list}
            style={styles.listContainer}
            windowSize={7}
            maxToRenderPerBatch={10}
            initialNumToRender={INITIAL_VISIBLE}
            updateCellsBatchingPeriod={50}
            // Rows are memoized by content: keep their native views mounted once
            // rendered so revisiting them never re-decodes the inline images.
            // Clipping (true) unmounted rows just outside the window and every
            // return trip paid a full remount + base64 decode — the repeated
            // scroll-to-bottom flicker.
            removeClippedSubviews={false}
            scrollEventThrottle={16}
            onScroll={handleScroll}
            onScrollBeginDrag={handleScrollBegin}
            onScrollEndDrag={handleScrollEnd}
            onMomentumScrollBegin={handleScrollBegin}
            onMomentumScrollEnd={handleScrollEnd}
            onContentSizeChange={handleContentSizeChange}
            onLayout={handleListLayout}
            {...(Platform.OS === "ios" ? { maintainVisibleContentPosition: { minIndexForVisible: 0 } } : {})}
            // Inverted: the header renders at the visual bottom, under the
            // newest message, so the goal review and pending ghost stay there.
            ListHeaderComponent={listFooter}
          />
        )}
        {messages.length > 0 && showOlder ? (
          <View style={styles.olderWrap} pointerEvents="box-none">
            <Pressable
              style={styles.olderButton}
              onPress={revealOlder}
              accessibilityRole="button"
              accessibilityLabel={`Show ${nextBatch} older ${nextBatch === 1 ? "message" : "messages"}`}
              accessibilityHint="Loads older messages without moving the current view"
              testID="load-older-messages"
              hitSlop={8}
            >
              <ArrowUpIcon size={14} color={colors.textMuted} />
              <Text style={styles.olderText}>{`+${nextBatch} ${nextBatch === 1 ? "message" : "messages"}`}</Text>
            </Pressable>
          </View>
        ) : null}
        {showJump ? (
          <View style={styles.jumpWrap} pointerEvents="box-none">
            <Pressable
              style={styles.jumpButton}
              onPress={scrollToBottom}
              accessibilityRole="button"
              accessibilityLabel="Scroll to bottom"
              accessibilityHint="Jumps to the newest message"
              testID="scroll-to-bottom"
              hitSlop={8}
            >
              <ArrowDownIcon size={20} color={colors.text} />
            </Pressable>
          </View>
        ) : null}
      </View>

      <GoalStrip client={client} sessionID={sessionID} />

      <Composer
        key={sessionID}
        ref={composerRef}
        client={client}
        sessionID={sessionID}
        busy={busy}
        connected={connected}
        workspaceID={workspaceID}
        directory={workspacePath}
        autoAccept={autoAccept}
        onToggleAutoAccept={onToggleAutoAccept}
        pending={pendingSend}
        header={header}
      />

      {parentSessionID && onOpenSession ? (
        <View style={styles.floatingWrap} pointerEvents="box-none">
          <Pressable style={styles.floating} onPress={() => onOpenSession(parentSessionID)}>
            <Text style={styles.floatingText}>← Back to main agent</Text>
          </Pressable>
        </View>
      ) : null}

      {runPreviewOpen && workspaceID ? (
        <RunPreviewModal
          key={sessionID}
          client={client}
          sessionID={sessionID}
          workspaceID={workspaceID}
          onClose={() => setRunPreviewOpen(false)}
        />
      ) : null}

      {auditOpen ? <AuditModal client={client} onClose={() => setAuditOpen(false)} /> : null}
    </Screen>
  )
}

function createStyles(colors: Palette, fonts: Fonts) {
  return StyleSheet.create({
    header: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.hairline,
    },
    back: {
      paddingHorizontal: 4,
    },
    backText: {
      color: colors.textMuted,
      fontSize: 26,
      lineHeight: 28,
    },
    title: {
      flex: 1,
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 15,
      fontWeight: "600",
    },
    dot: {
      width: 8,
      height: 8,
      borderRadius: 4,
    },
    waitingBar: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.accentLine,
      backgroundColor: colors.accentSoft,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    waitingDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: colors.accent,
    },
    waitingText: {
      flex: 1,
      color: colors.accent,
      fontFamily: fonts.ui,
      fontSize: 12,
    },
    actionButton: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairlineStrong,
      backgroundColor: colors.surface,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 5,
    },
    actionText: {
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 12,
      fontWeight: "500",
    },
    listContainer: {
      flex: 1,
    },
    listWrap: {
      flex: 1,
    },
    jumpWrap: {
      position: "absolute",
      right: 16,
      bottom: 16,
      zIndex: 10,
    },
    olderWrap: {
      position: "absolute",
      top: 8,
      left: 0,
      right: 0,
      alignItems: "center",
      zIndex: 10,
    },
    olderButton: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      borderRadius: 999,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairlineStrong,
      backgroundColor: colors.surface,
      paddingHorizontal: 12,
      paddingVertical: 8,
      elevation: 4,
    },
    olderText: {
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 12,
      fontWeight: "600",
    },
    jumpButton: {
      width: 44,
      height: 44,
      borderRadius: 22,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairlineStrong,
      elevation: 4,
    },
    list: {
      gap: 16,
      paddingHorizontal: 14,
      paddingVertical: 16,
    },
    empty: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 14,
      textAlign: "center",
      paddingVertical: 32,
    },
    emptyWrap: {
      alignItems: "center",
      justifyContent: "center",
      minHeight: 240,
      paddingVertical: 48,
      paddingHorizontal: 24,
      overflow: "hidden",
    },
    emptyDeco: {
      position: "absolute",
      top: 0,
      right: -24,
      opacity: 0.5,
    },
    emptyTitle: {
      color: colors.text,
      fontFamily: fonts.display,
      fontSize: 26,
      fontWeight: "500",
      lineHeight: 31,
      textAlign: "center",
    },
    floatingWrap: {
      position: "absolute",
      top: 52,
      left: 0,
      right: 0,
      alignItems: "center",
      zIndex: 10,
    },
    floating: {
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairlineStrong,
      borderRadius: 999,
      paddingHorizontal: 12,
      paddingVertical: 6,
      elevation: 4,
    },
    floatingText: {
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 12,
      fontWeight: "600",
    },
  })
}
