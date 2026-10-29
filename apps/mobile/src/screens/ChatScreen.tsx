import { useEffect, useRef, useState, type ReactNode } from "react"
import { FlatList, Linking, Pressable, StyleSheet, Text, View } from "react-native"
import { useQueryClient } from "@tanstack/react-query"
import {
  finishResultFromIsolation,
  isAmbiguousError,
  sessionUsage,
  useBffStatus,
  useGoalRun,
  useMessages,
  usePendingSend,
  usePreview,
  useSessionRun,
  type ChatMessage,
  type Client,
  type CreateWorkspaceInput,
  type FinishSessionResult,
  type FormAnswer,
  type FormInfo,
  type SessionIsolation,
  type WorkspaceRecord,
} from "@masterhand/client-core"
import { Composer, type ComposerHandle } from "../components/Composer"
import { BranchChip, BranchPicker } from "../components/BranchPicker"
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
import { PlayIcon } from "../components/icons"
import { useTheme, useThemedStyles, type Fonts, type Palette } from "../theme"

export function ChatScreen({
  client,
  sessionID,
  title,
  busy,
  connected,
  workspaceID,
  workspacePath = null,
  isolation,
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
  isolation?: SessionIsolation
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
  const queryClient = useQueryClient()
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
  const [finishing, setFinishing] = useState(false)
  const [finishResult, setFinishResult] = useState<FinishSessionResult | null>(null)
  const [finishError, setFinishError] = useState<string | null>(null)
  const [finishNotice, setFinishNotice] = useState<string | null>(null)
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()
  const messages = messagesQuery.data ?? []
  const usage = sessionUsage(messages)
  // The review footer grows with every goal transition: include it in the
  // follow-scroll. Expanding a round is local state and must NOT yank the
  // user to the bottom, so this replaces the old onContentSizeChange hook.
  const goalUpdatedAt = useGoalRun(client, sessionID).data?.updatedAt

  useEffect(() => {
    if (messages.length === 0) return
    listRef.current?.scrollToEnd({ animated: true })
  }, [messages, goalUpdatedAt])

  async function finish() {
    setFinishing(true)
    setFinishError(null)
    setFinishNotice(null)
    try {
      const result = await client.api.sessions.finish(sessionID)
      setFinishResult(result)
      if (result.error) setFinishError(result.error)
      void queryClient.invalidateQueries({ queryKey: ["sessions"] })
    } catch (error) {
      if (isAmbiguousError(error)) {
        // Commit + push + PR may still be running (or already done). Never a
        // hard failure: reconcile against the isolated-session record.
        const isolation = await findIsolation()
        const reconciled = finishResultFromIsolation(isolation)
        if (reconciled) {
          setFinishResult(reconciled)
          setFinishNotice("The server did not answer in time — this result comes from the session record.")
        } else {
          setFinishError(
            "The server did not answer in time — the operation may still be running. Check the branch before retrying.",
          )
        }
        void queryClient.invalidateQueries({ queryKey: ["sessions"] })
      } else {
        setFinishError("Could not finish the session")
      }
    } finally {
      setFinishing(false)
    }
  }

  /**
   * Walks the workspace session list for the isolated-session record after an
   * ambiguous finish. Bounded: the server may still be committing/pushing.
   */
  async function findIsolation(): Promise<SessionIsolation | null> {
    if (!workspaceID) return null
    for (const delay of [0, 1500, 3000]) {
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
      try {
        const page = await client.api.sessions.list(workspaceID)
        const isolation = page.sessions.find((session) => session.id === sessionID)?.isolation
        if (finishResultFromIsolation(isolation)) return isolation ?? null
      } catch {
        // keep polling: a transient failure must not hide the confirmation
      }
    }
    return null
  }

  const header = (
    <SessionToolbar
      workspaces={workspaces}
      workspaceID={workspaceID}
      onSelectWorkspace={(id) => onSelectWorkspace?.(id)}
      onAddWorkspace={async (input) => {
        await onAddWorkspace?.(input)
      }}
      onRemoveWorkspace={(id, options) => onRemoveWorkspace?.(id, options)}
      branch={
        // The header chip is the only branch shown: read-only for isolated
        // sessions (their branch cannot be switched), the picker for
        // standard ones.
        isolation ? (
          <BranchChip branch={isolation.branch} />
        ) : workspaceID ? (
          <BranchPicker client={client} workspaceID={workspaceID} />
        ) : undefined
      }
      trailing={<SessionStats usage={usage} />}
    />
  )

  const isolationBar: ReactNode | undefined = isolation ? (
    <View>
      <View style={styles.isolationRow}>
        <Text style={styles.isolationLabel}>Isolated</Text>
        <View style={styles.isolationSpacer} />
        {isolation.prUrl ? (
          <Pressable onPress={() => void Linking.openURL(isolation.prUrl!)} hitSlop={4}>
            <Text style={styles.link}>PR ↗</Text>
          </Pressable>
        ) : null}
        <Pressable
          style={[styles.finishButton, finishing && styles.disabled]}
          onPress={() => void finish()}
          disabled={finishing}
        >
          <Text style={styles.finishText}>{finishing ? "Finishing…" : "Finish & PR"}</Text>
        </Pressable>
      </View>
      {finishResult || finishError || finishNotice ? (
        <View style={styles.finishStatus}>
          <Text style={styles.finishStatusText}>
            {finishResult ? (finishResult.committed ? "Changes committed." : "No changes to commit.") : ""}
            {finishResult?.pushed ? " Branch pushed." : ""}
          </Text>
          {finishResult?.prUrl ? (
            <Pressable onPress={() => void Linking.openURL(finishResult.prUrl!)} hitSlop={4}>
              <Text style={styles.link}>Open pull request ↗</Text>
            </Pressable>
          ) : null}
          {finishError ? <Text style={styles.finishError}>{finishError}</Text> : null}
          {finishNotice ? <Text style={styles.finishStatusText}>{finishNotice}</Text> : null}
        </View>
      ) : null}
    </View>
  ) : undefined

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

      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(entry) => entry.info.id}
        contentContainerStyle={styles.list}
        style={styles.listContainer}
        ListFooterComponent={
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
        }
        ListEmptyComponent={
          messagesQuery.isLoading ? (
            <Text style={styles.empty}>Loading conversation…</Text>
          ) : (
            <View style={styles.emptyWrap}>
              <Deco variant="dots" style={styles.emptyDeco} />
              <Text style={styles.emptyTitle}>Write a message to start working with the agent.</Text>
            </View>
          )
        }
        renderItem={({ item }) => (
          <MessageBubble
            entry={item}
            onOpenSession={onOpenSession}
            forms={forms}
            answeredForms={answeredForms}
            busyFormID={busyFormID}
            onRespondForm={onRespondForm}
            onCancelForm={onCancelForm}
          />
        )}
      />

      <GoalStrip client={client} sessionID={sessionID} />

      <Composer
        key={sessionID}
        ref={composerRef}
        client={client}
        sessionID={sessionID}
        busy={busy}
        connected={connected}
        workspaceID={workspaceID}
        directory={isolation?.worktreePath ?? workspacePath}
        autoAccept={autoAccept}
        onToggleAutoAccept={onToggleAutoAccept}
        pending={pendingSend}
        header={header}
        isolationBar={isolationBar}
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
    isolationRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      gap: 8,
    },
    isolationSpacer: {
      flex: 1,
    },
    isolationLabel: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 11,
      letterSpacing: 0.8,
      textTransform: "uppercase",
      fontWeight: "600",
    },
    finishButton: {
      backgroundColor: colors.accent,
      borderRadius: 12,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    finishText: {
      color: colors.onAccent,
      fontFamily: fonts.ui,
      fontSize: 12,
      fontWeight: "500",
    },
    finishStatus: {
      flexDirection: "row",
      alignItems: "center",
      flexWrap: "wrap",
      gap: 8,
      paddingTop: 6,
    },
    finishStatusText: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 12,
    },
    finishError: {
      color: colors.danger,
      fontFamily: fonts.ui,
      fontSize: 12,
    },
    link: {
      color: colors.accent,
      fontFamily: fonts.ui,
      fontSize: 12,
      fontWeight: "600",
    },
    disabled: {
      opacity: 0.5,
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
