import { useEffect, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  conversationErrorMessage,
  formatSpeed,
  formatTokens,
  sessionUsage,
  tokenSpeed,
  useMessages,
  type FinishSessionResult,
  type FormAnswer,
  type FormInfo,
  type SessionIsolation,
} from "@masterhand/client-core"
import { client } from "../client"
import { AssistantBlock, UserBubble } from "./MessageContent"
import { Composer } from "./Composer"
import { AuditPanel } from "./AuditPanel"
import { PreviewPanel } from "./PreviewPanel"

/** Messages rendered at once; older ones load on demand (no virtualization). */
const MESSAGE_PAGE_SIZE = 200

export function ChatView({
  sessionID,
  busy,
  connected,
  workspaceID,
  workspacePath,
  isolation,
  autoAccept,
  onToggleAutoAccept,
  onOpenSession,
  forms,
  answeredForms,
  busyFormID,
  onRespondForm,
  onCancelForm,
}: {
  sessionID: string
  busy: boolean
  connected: boolean
  workspaceID: string | null
  workspacePath: string | null
  isolation?: SessionIsolation
  autoAccept: boolean
  onToggleAutoAccept: (on: boolean) => void
  onOpenSession?: (id: string) => void
  forms: FormInfo[]
  answeredForms: Array<{ form: FormInfo; answer: FormAnswer }>
  busyFormID: string | null
  onRespondForm: (form: FormInfo, answer: FormAnswer) => void
  onCancelForm: (form: FormInfo) => void
}) {
  const queryClient = useQueryClient()
  const messagesQuery = useMessages(client, sessionID, { busy, connected })
  const [finishing, setFinishing] = useState(false)
  const [finishResult, setFinishResult] = useState<FinishSessionResult | null>(null)
  const [finishError, setFinishError] = useState<string | null>(null)

  const messages = messagesQuery.data ?? []
  const usage = sessionUsage(messages)
  const tokenBreakdown = formatTokens(usage)
  const speed = formatSpeed(tokenSpeed(usage, usage.durationMs))
  const [visibleCount, setVisibleCount] = useState(MESSAGE_PAGE_SIZE)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)

  // A very long session (the client loads up to 10 000 messages) would mount a
  // bubble per message; render the newest page and let the user expand it.
  const hiddenCount = Math.max(0, messages.length - visibleCount)
  const visibleMessages = hiddenCount > 0 ? messages.slice(hiddenCount) : messages

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

  useEffect(() => {
    const element = scrollRef.current
    if (element && stickToBottom.current) {
      element.scrollTop = element.scrollHeight
    }
  }, [messages])

  function handleScroll() {
    const element = scrollRef.current
    if (!element) return
    stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PreviewPanel sessionID={sessionID} />
      <AuditPanel />
      <div ref={scrollRef} onScroll={handleScroll} className="scroll-thin min-h-0 flex-1 overflow-y-auto px-3 py-4 md:px-6">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
          {messagesQuery.isLoading && <p className="text-center text-sm text-zinc-500">Loading conversation…</p>}
          {messagesQuery.error && (
            <p className="text-center text-sm text-red-400">{conversationErrorMessage(messagesQuery.error)}</p>
          )}
          {!messagesQuery.isLoading && messages.length === 0 && (
            <p className="py-12 text-center text-sm text-zinc-500">
              Write a message to start working with the agent.
            </p>
          )}
          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => setVisibleCount((count) => count + MESSAGE_PAGE_SIZE)}
              className="mx-auto rounded-full border border-zinc-700 px-3 py-1 text-xs text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
            >
              Show {Math.min(MESSAGE_PAGE_SIZE, hiddenCount)} earlier messages
            </button>
          )}
          {visibleMessages.map((entry) =>
            entry.info.role === "user" ? (
              <UserBubble key={entry.info.id} entry={entry} />
            ) : (
              <AssistantBlock
                key={entry.info.id}
                entry={entry}
                onOpenSession={onOpenSession}
                forms={forms}
                answeredForms={answeredForms}
                busyFormID={busyFormID}
                onRespondForm={onRespondForm}
                onCancelForm={onCancelForm}
              />
            ),
          )}
        </div>
      </div>
      {(usage.cost > 0 || tokenBreakdown) && (
        <div className="px-3 pt-2 md:px-6">
          <p className="mx-auto w-full max-w-3xl text-right text-xs text-zinc-600">
            Session · ${usage.cost.toFixed(4)}
            {tokenBreakdown ? ` · ${tokenBreakdown}` : ""}
            {speed ? ` · ${speed}` : ""}
          </p>
        </div>
      )}
      {isolation && (
        <div className="border-t border-zinc-800 px-3 py-2 md:px-6">
          <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-2 text-xs">
            <span className="text-zinc-500">Isolated worktree</span>
            <code
              className="max-w-full truncate rounded bg-zinc-900 px-1.5 py-0.5 text-indigo-300"
              title={isolation.worktreePath}
            >
              {isolation.branch}
            </code>
            {isolation.prUrl && (
              <a
                href={isolation.prUrl}
                target="_blank"
                rel="noreferrer"
                className="text-indigo-400 hover:underline"
              >
                Pull request ↗
              </a>
            )}
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => void finish()}
              disabled={finishing}
              title="Commit the worktree and push the branch (PR when a provider CLI is available)"
              className="rounded-lg border border-indigo-500/40 bg-indigo-500/10 px-2.5 py-1 font-medium text-indigo-200 hover:bg-indigo-500/20 disabled:opacity-50"
            >
              {finishing ? "Finishing…" : "Finish & PR"}
            </button>
          </div>
          {(finishResult || finishError) && (
            <p className="mx-auto mt-1 w-full max-w-3xl text-[11px] text-zinc-500">
              {finishResult
                ? finishResult.committed
                  ? "Changes committed."
                  : "No changes to commit."
                : null}
              {finishResult?.pushed ? " Branch pushed." : null}
              {finishResult?.prUrl && (
                <>
                  {" "}
                  <a href={finishResult.prUrl} target="_blank" rel="noreferrer" className="text-indigo-400 hover:underline">
                    Open pull request ↗
                  </a>
                </>
              )}
              {finishError ? <span className="text-red-400">{finishError}</span> : null}
            </p>
          )}
        </div>
      )}
      <Composer
        sessionID={sessionID}
        busy={busy}
        connected={connected}
        workspaceID={workspaceID}
        directory={isolation?.worktreePath ?? workspacePath}
        autoAccept={autoAccept}
        onToggleAutoAccept={onToggleAutoAccept}
      />
    </div>
  )
}
