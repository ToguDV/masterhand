import { useEffect, useRef, useState, type DragEvent } from "react"
import {
  conversationErrorMessage,
  sessionUsage,
  useGoalRun,
  useMessages,
  usePendingSend,
  type FormAnswer,
  type FormInfo,
  type Permission,
  type WorkspaceRecord,
} from "@masterhand/client-core"
import { client } from "../client"
import { AssistantBlock, UserBubble } from "./MessageContent"
import { BranchViewer } from "./BranchViewer"
import { Composer, type ComposerHandle } from "./Composer"
import { GoalReview } from "./GoalCards"
import { GoalStrip } from "./GoalStrip"
import { PendingBubble } from "./PendingBubble"
import { PermissionCard, PermissionResolved, type AnsweredPermission } from "./PermissionCard"
import { SessionStats } from "./SessionStats"
import { SessionToolbar } from "./SessionToolbar"
import { Deco } from "./Deco"
import { ArrowDownIcon, PaperclipIcon } from "./icons"

/** Messages rendered at once; older ones load on demand (no virtualization). */
const MESSAGE_PAGE_SIZE = 200

export function ChatView({
  sessionID,
  busy,
  connected,
  workspaceID,
  workspacePath,
  workspaces,
  autoAccept,
  onToggleAutoAccept,
  onOpenSession,
  onSelectWorkspace,
  onAddWorkspace,
  onRemoveWorkspace,
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
  autoAccept: boolean
  onToggleAutoAccept: (on: boolean) => void
  onOpenSession?: (id: string) => void
  onSelectWorkspace: (id: string | null) => void
  onAddWorkspace: () => void
  onRemoveWorkspace: (id: string) => void
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
  const messagesQuery = useMessages(client, sessionID, { busy, connected })
  const pendingSend = usePendingSend(sessionID)
  // The review section below the transcript grows with every goal transition:
  // include it in the stick-to-bottom effect so new rounds scroll into view.
  const goalUpdatedAt = useGoalRun(client, sessionID).data?.updatedAt
  const composerRef = useRef<ComposerHandle>(null)

  const messages = messagesQuery.data ?? []
  const usage = sessionUsage(messages)
  const [visibleCount, setVisibleCount] = useState(MESSAGE_PAGE_SIZE)
  const [showJump, setShowJump] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  /** Nested dragenter/dragleave counter (children fire both on every move). */
  const dragDepth = useRef(0)
  const [dragging, setDragging] = useState(false)

  function hasFiles(event: DragEvent<HTMLElement>): boolean {
    if (Array.from(event.dataTransfer?.types ?? []).includes("Files")) return true
    return (event.dataTransfer?.files?.length ?? 0) > 0
  }

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

  useEffect(() => {
    stickToBottom.current = true
    setShowJump(false)
  }, [sessionID])

  useEffect(() => {
    const element = scrollRef.current
    if (element && stickToBottom.current) {
      element.scrollTop = element.scrollHeight
    }
  }, [messages, pendingSend.pending, goalUpdatedAt])

  function handleScroll() {
    const element = scrollRef.current
    if (!element) return
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 120
    stickToBottom.current = nearBottom
    setShowJump(!nearBottom)
  }

  function scrollToBottom() {
    const element = scrollRef.current
    if (!element) return
    stickToBottom.current = true
    setShowJump(false)
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
    element.scrollTo({ top: element.scrollHeight, behavior: reduceMotion ? "auto" : "smooth" })
  }

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onDragEnter={(event) => {
        if (!hasFiles(event)) return
        event.preventDefault()
        dragDepth.current += 1
        setDragging(true)
      }}
      onDragOver={(event) => {
        if (!hasFiles(event)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = "copy"
      }}
      onDragLeave={() => {
        if (dragDepth.current === 0) return
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDragging(false)
      }}
      onDragEnd={() => {
        dragDepth.current = 0
        setDragging(false)
      }}
      onDrop={(event) => {
        if (!hasFiles(event)) return
        event.preventDefault()
        dragDepth.current = 0
        setDragging(false)
        const files = Array.from(event.dataTransfer?.files ?? [])
        if (files.length > 0) composerRef.current?.attach(files)
      }}
    >
      {dragging && (
        <div className="mh-dropzone" role="status" aria-live="polite">
          <PaperclipIcon size={20} />
          Drop files to attach
        </div>
      )}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        data-testid="chat-scroll"
        className="scroll-thin min-h-0 flex-1 overflow-y-auto px-3 py-4 md:px-6"
      >
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
          <GoalReview sessionID={sessionID} onOpenSession={onOpenSession} />
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
          {pendingSend.pending && (
            <PendingBubble
              pending={pendingSend.pending}
              onRetry={() => composerRef.current?.retry()}
              onDismiss={pendingSend.dismiss}
            />
          )}
        </div>
      </div>
      {showJump && (
        <button
          type="button"
          onClick={scrollToBottom}
          aria-label="Scroll to bottom"
          title="Scroll to bottom"
          className="mh-btn mh-btn--secondary mh-btn--icon absolute bottom-40 left-1/2 z-20 -translate-x-1/2 rounded-full bg-surface shadow-elev1"
        >
          <ArrowDownIcon size={18} />
        </button>
      )}
      <GoalStrip sessionID={sessionID} />
      <Composer
        ref={composerRef}
        sessionID={sessionID}
        busy={busy}
        connected={connected}
        workspaceID={workspaceID}
        directory={workspacePath}
        autoAccept={autoAccept}
        onToggleAutoAccept={onToggleAutoAccept}
        pending={pendingSend}
        header={
          <SessionToolbar
            workspaces={workspaces}
            workspaceID={workspaceID}
            onSelectWorkspace={onSelectWorkspace}
            onAddWorkspace={onAddWorkspace}
            onRemoveWorkspace={onRemoveWorkspace}
            branch={workspaceID ? <BranchViewer workspaceID={workspaceID} /> : undefined}
            trailing={<SessionStats usage={usage} />}
          />
        }
      />
    </div>
  )
}
