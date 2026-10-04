import { useRef, useState } from "react"
import { FlatList, Linking, Pressable, StyleSheet, Text, View } from "react-native"
import { useQueryClient } from "@tanstack/react-query"
import {
  formatSpeed,
  formatTokens,
  sessionUsage,
  tokenSpeed,
  useBffStatus,
  useMessages,
  type ChatMessage,
  type Client,
  type FinishSessionResult,
  type FormAnswer,
  type FormInfo,
  type SessionIsolation,
} from "@masterhand/client-core"
import { Composer } from "../components/Composer"
import { MessageBubble } from "../components/MessageBubble"
import { PreviewModal } from "../components/PreviewModal"
import { RunModal } from "../components/RunModal"
import { Screen } from "../components/Screen"
import { colors } from "../theme"

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
}) {
  const queryClient = useQueryClient()
  const messagesQuery = useMessages(client, sessionID, { busy, connected })
  const statusQuery = useBffStatus(client)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [runOpen, setRunOpen] = useState(false)
  const listRef = useRef<FlatList<ChatMessage>>(null)
  const [finishing, setFinishing] = useState(false)
  const [finishResult, setFinishResult] = useState<FinishSessionResult | null>(null)
  const [finishError, setFinishError] = useState<string | null>(null)
  const messages = messagesQuery.data ?? []
  const usage = sessionUsage(messages)
  const tokenBreakdown = formatTokens(usage)
  const speed = formatSpeed(tokenSpeed(usage, usage.durationMs))

  async function finish() {
    setFinishing(true)
    setFinishError(null)
    try {
      const result = await client.api.sessions.finish(sessionID)
      setFinishResult(result)
      if (result.error) setFinishError(result.error)
      void queryClient.invalidateQueries({ queryKey: ["sessions"] })
    } catch {
      setFinishError("Could not finish the session")
    } finally {
      setFinishing(false)
    }
  }

  return (
    <Screen>
      <View style={styles.header}>
        <Pressable onPress={onBack} style={styles.back}>
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>
          {title || "Session"}
        </Text>
        {workspaceID ? (
          <Pressable style={styles.previewButton} onPress={() => setRunOpen(true)}>
            <Text style={styles.previewButtonText}>Run</Text>
          </Pressable>
        ) : null}
        {statusQuery.data?.preview?.enabled ? (
          <Pressable style={styles.previewButton} onPress={() => setPreviewOpen(true)}>
            <Text style={styles.previewButtonText}>Preview</Text>
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
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        ListEmptyComponent={
          messagesQuery.isLoading ? (
            <Text style={styles.empty}>Loading conversation…</Text>
          ) : (
            <Text style={styles.empty}>Write a message to start working with the agent.</Text>
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

      {(usage.cost > 0 || tokenBreakdown) ? (
        <Text style={styles.usage}>
          Session · ${usage.cost.toFixed(4)}
          {tokenBreakdown ? ` · ${tokenBreakdown}` : ""}
          {speed ? ` · ${speed}` : ""}
        </Text>
      ) : null}

      {isolation ? (
        <View style={styles.isolationBar}>
          <View style={styles.isolationInfo}>
            <Text style={styles.isolationLabel}>Isolated</Text>
            <Text style={styles.branch} numberOfLines={1}>
              {isolation.branch}
            </Text>
          </View>
          {isolation.prUrl ? (
            <Pressable onPress={() => void Linking.openURL(isolation.prUrl!)}>
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
      ) : null}
      {finishResult || finishError ? (
        <View style={styles.finishStatus}>
          <Text style={styles.finishStatusText}>
            {finishResult ? (finishResult.committed ? "Changes committed." : "No changes to commit.") : ""}
            {finishResult?.pushed ? " Branch pushed." : ""}
          </Text>
          {finishResult?.prUrl ? (
            <Pressable onPress={() => void Linking.openURL(finishResult.prUrl!)}>
              <Text style={styles.link}>Open pull request ↗</Text>
            </Pressable>
          ) : null}
          {finishError ? <Text style={styles.finishError}>{finishError}</Text> : null}
        </View>
      ) : null}

      <Composer
        key={sessionID}
        client={client}
        sessionID={sessionID}
        busy={busy}
        connected={connected}
        workspaceID={workspaceID}
        directory={isolation?.worktreePath ?? workspacePath}
        autoAccept={autoAccept}
        onToggleAutoAccept={onToggleAutoAccept}
      />

      {parentSessionID && onOpenSession ? (
        <View style={styles.floatingWrap} pointerEvents="box-none">
          <Pressable style={styles.floating} onPress={() => onOpenSession(parentSessionID)}>
            <Text style={styles.floatingText}>← Back to main agent</Text>
          </Pressable>
        </View>
      ) : null}

      {previewOpen ? (
        <PreviewModal client={client} sessionID={sessionID} onClose={() => setPreviewOpen(false)} />
      ) : null}

      {runOpen && workspaceID ? (
        <RunModal
          client={client}
          sessionID={sessionID}
          workspaceID={workspaceID}
          onClose={() => setRunOpen(false)}
        />
      ) : null}
    </Screen>
  )
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  back: {
    paddingHorizontal: 4,
  },
  backText: {
    color: colors.muted,
    fontSize: 26,
    lineHeight: 28,
  },
  title: {
    flex: 1,
    color: colors.text,
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
    borderBottomColor: "rgba(99, 102, 241, 0.4)",
    backgroundColor: "rgba(99, 102, 241, 0.12)",
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  waitingDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.accent,
  },
  waitingText: {
    flex: 1,
    color: "#c7d2fe",
    fontSize: 11,
  },
  previewButton: {
    backgroundColor: "rgba(99, 102, 241, 0.15)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.accentMuted,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  previewButtonText: {
    color: "#a5b4fc",
    fontSize: 12,
    fontWeight: "700",
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
    color: colors.muted,
    fontSize: 14,
    textAlign: "center",
    paddingVertical: 32,
  },
  usage: {
    color: colors.muted,
    fontSize: 11,
    textAlign: "right",
    paddingHorizontal: 14,
    paddingTop: 8,
  },
  isolationBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  isolationInfo: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  isolationLabel: {
    color: colors.muted,
    fontSize: 11,
    textTransform: "uppercase",
    fontWeight: "700",
  },
  branch: {
    color: "#a5b4fc",
    fontSize: 11,
    fontFamily: "monospace",
  },
  finishButton: {
    backgroundColor: "rgba(99, 102, 241, 0.15)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.accentMuted,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  finishText: {
    color: "#a5b4fc",
    fontSize: 12,
    fontWeight: "700",
  },
  finishStatus: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 8,
    paddingHorizontal: 14,
    paddingBottom: 6,
  },
  finishStatusText: {
    color: colors.muted,
    fontSize: 11,
  },
  finishError: {
    color: colors.danger,
    fontSize: 11,
  },
  link: {
    color: "#a5b4fc",
    fontSize: 11,
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
    borderColor: colors.accentMuted,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    elevation: 4,
  },
  floatingText: {
    color: "#a5b4fc",
    fontSize: 12,
    fontWeight: "600",
  },
})
