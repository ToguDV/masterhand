import { useEffect, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  conversationErrorMessage,
  sessionUsage,
  useMessages,
  type FinishSessionResult,
  type FormAnswer,
  type FormInfo,
  type Permission,
  type SessionIsolation,
  type WorkspaceRecord,
} from "@masterhand/client-core"
import { client } from "../client"
import { AssistantBlock, UserBubble } from "./MessageContent"
import { Composer } from "./Composer"
import { PermissionCard, PermissionResolved, type AnsweredPermission } from "./PermissionCard"
import { SessionStats } from "./SessionStats"
import { SessionToolbar } from "./SessionToolbar"
import { Deco } from "./Deco"
import { ExternalLinkIcon } from "./icons"

/** Messages rendered at once; older ones load on demand (no virtualization). */
const MESSAGE_PAGE_SIZE = 200

export function ChatView({
  sessionID,
  busy,
  connected,
  workspaceID,
  workspacePath,
  workspaces,
  isolation,
  autoAccept,
  onToggleAutoAccept,
  onOpenSession,
  onSelectWorkspace,
  onAddWorkspace,
  onRemoveWorkspace,
  onCreateSession,
  creating,
  forms,
  answeredForms,
  busyFormID,
  onRespondForm,
  onCancelForm,
  permissions,
  answeredPermissions,
  respondingPermissionID,
  onRespondPermission,
}: {
  sessionID: string
  busy: boolean
  connected: boolean
  workspaceID: string | null
  workspacePath: string | null
  workspaces: WorkspaceRecord[]
  isolation?: SessionIsolation
  autoAccept: boolean
  onToggleAutoAccept: (on: boolean) => void
  onOpenSession?: (id: string) => void
  onSelectWorkspace: (id: string | null) => void
  onAddWorkspace: () => void
  onRemoveWorkspace: (id: string) => void
  onCreateSession: (isolated: boolean) => void
  creating: boolean
  forms: FormInfo[]
  answeredForms: Array<{ form: FormInfo; answer: FormAnswer }>
  busyFormID: string | null
  onRespondForm: (form: FormInfo, answer: FormAnswer) => void
  onCancelForm: (form: FormInfo) => void
  permissions: Permission[]
  answeredPermissions: AnsweredPermission[]
  respondingPermissionID: string | null
  onRespondPermission: (permission: Permission, response: "once" | "always" | "reject") => void
}) {
  const queryClient = useQueryClient()
  const messagesQuery = useMessages(client, sessionID, { busy, connected })
  const [finishing, setFinishing] = useState(false)
  const [finishResult, setFinishResult] = useState<FinishSessionResult | null>(null)
  const [finishError, setFinishError] = useState<string | null>(null)

  const messages = messagesQuery.data ?? []
  const usage = sessionUsage(messages)
  const [visibleCount, setVisibleCount] = useState(MESSAGE_PAGE_SIZE)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)

  // A very long session (the client loads up to 10 000 messages) would mount a
  // bubble per message; render the newest page and let the user expand it.
  const hiddenCount = Math.max(0, messages.length - visibleCount)
  const visibleMessages = hiddenCount > 0 ? messages.slice(hiddenCount) : messages

  // Permissions anchor to the tool call that raised them; opencode does not
  // always report the source, so anything unmatched stays in the flow at the
  // end of the transcript instead of disappearing.
  const sessionPermissions = permissions.filter((permission) => permission.sessionID === sessionID)
  const sessionAnswered = answeredPermissions.filter((entry) => entry.permission.sessionID === sessionID)
  const callIDs = new Set<string>()
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "tool") callIDs.add(part.callID)
    }
  }
  const unmatchedPending = sessionPermissions.filter(
    (permission) => !(permission.source?.id && callIDs.has(permission.source.id)),
  )
  const unmatchedAnswered = sessionAnswered.filter(
    (entry) => !(entry.permission.source?.id && callIDs.has(entry.permission.source.id)),
  )

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
      <div ref={scrollRef} onScroll={handleScroll} className="scroll-thin min-h-0 flex-1 overflow-y-auto px-3 py-4 md:px-6">
        <div className="mh-chat-col mh-thread">
          <p className="sr-only" role="status">
            {sessionPermissions.length > 0
              ? "A permission request is pending. The agent is waiting for your approval."
              : ""}
          </p>
          {messagesQuery.isLoading && <p className="text-center text-sm text-ink-muted">Loading conversation…</p>}
          {messagesQuery.error && (
            <p className="text-center text-sm text-danger">{conversationErrorMessage(messagesQuery.error)}</p>
          )}
          {!messagesQuery.isLoading && messages.length === 0 && (
            <div className="mh-empty border-0 bg-transparent">
              <Deco variant="blob" style={{ top: -60, right: -70, width: 240, height: 220 }} />
              <Deco variant="dots" style={{ bottom: -14, left: -18 }} />
              <h3 className="mh-heading-2">No messages yet</h3>
              <p className="mh-empty__body mh-body-sm">Write a message to start working with the agent.</p>
            </div>
          )}
          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => setVisibleCount((count) => count + MESSAGE_PAGE_SIZE)}
              className="mh-pill mx-auto"
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
                permissions={sessionPermissions}
                answeredPermissions={sessionAnswered}
                respondingPermissionID={respondingPermissionID}
                onRespondPermission={onRespondPermission}
              />
            ),
          )}
          {unmatchedPending.map((permission) => (
            <PermissionCard
              key={permission.id}
              permission={permission}
              busy={respondingPermissionID === permission.id}
              onRespond={(response) => onRespondPermission(permission, response)}
            />
          ))}
          {unmatchedAnswered.map((entry) => (
            <PermissionResolved key={entry.permission.id} entry={entry} />
          ))}
        </div>
      </div>
      {isolation && (
        <div className="border-t border-hairline px-3 py-2 md:px-6">
          <div className="mh-chat-col flex flex-wrap items-center gap-2 text-xs">
            <span className="text-ink-muted">Isolated worktree</span>
            <code
              className="mh-chip mh-chip--accent mh-chip--mono max-w-full truncate"
              title={isolation.worktreePath}
            >
              {isolation.branch}
            </code>
            {isolation.prUrl && (
              <a href={isolation.prUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                Pull request
                <ExternalLinkIcon size={12} className="ml-1 inline-block align-text-bottom" />
              </a>
            )}
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => void finish()}
              disabled={finishing}
              title="Commit the worktree and push the branch (PR when a provider CLI is available)"
              className="mh-btn mh-btn--secondary mh-btn--sm"
            >
              {finishing ? "Finishing…" : "Finish & PR"}
            </button>
          </div>
          {(finishResult || finishError) && (
            <p className="mh-chat-col mt-1 text-[11px] text-ink-muted">
              {finishResult
                ? finishResult.committed
                  ? "Changes committed."
                  : "No changes to commit."
                : null}
              {finishResult?.pushed ? " Branch pushed." : null}
              {finishResult?.prUrl && (
                <>
                  {" "}
                  <a href={finishResult.prUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                    Open pull request
                    <ExternalLinkIcon size={12} className="ml-1 inline-block align-text-bottom" />
                  </a>
                </>
              )}
              {finishError ? <span className="text-danger">{finishError}</span> : null}
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
        header={
          <SessionToolbar
            workspaces={workspaces}
            workspaceID={workspaceID}
            onSelectWorkspace={onSelectWorkspace}
            onAddWorkspace={onAddWorkspace}
            onRemoveWorkspace={onRemoveWorkspace}
            onCreateSession={onCreateSession}
            creating={creating}
            trailing={<SessionStats usage={usage} />}
          />
        }
      />
    </div>
  )
}
