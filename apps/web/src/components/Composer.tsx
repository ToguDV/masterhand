import { useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_COUNT,
  ATTACHMENT_MAX_TOTAL_BYTES,
  ATTACHMENT_METADATA_KEY,
  attachmentErrorMessage,
  attachmentMetadata,
  buildAttachmentContext,
  buildComposerPopover,
  collectAgentMentions,
  composerErrorMessage,
  composerTrigger,
  createAttachmentID,
  createDeliveryMarker,
  defaultModelValue,
  deliveryMetadata,
  flattenModels,
  formatFileSize,
  goalErrorMessage,
  inlineAttachmentFiles,
  isAmbiguousError,
  isEffortVariant,
  mentionableAgents,
  mergeCommands,
  mimeFromName,
  parseModel,
  queryKeys,
  recentModelValue,
  selectableAgents,
  sessionModelValue,
  splitCommand,
  useAgents,
  useCommands,
  useModels,
  useSessions,
  variantLabel,
  type ComposerPopover,
  type ComposerTrigger,
  type PendingSendController,
  type UploadedAttachment,
} from "@masterhand/client-core"
import { client } from "../client"
import { AttachmentChip, type ComposerAttachment } from "./Attachments"
import { ComposerSuggestions } from "./ComposerSuggestions"
import { ProviderGlyph } from "./ProviderGlyph"
import { SearchSelect } from "./SearchSelect"
import { SideQuestionPanel } from "./SideQuestionPanel"
import { ArrowUpIcon, BrainIcon, PaperclipIcon, ShieldCheckIcon, SlidersIcon, StopIcon } from "./icons"

const PREFERENCES_STORAGE_KEY = "masterhand.sessionPreferences"

/** Imperative surface for the chat container's ghost-bubble retry (#125). */
export interface ComposerHandle {
  retry: () => void
  /** Adds files dropped onto the chat column. */
  attach: (files: File[]) => void
}

interface SessionPreferences {
  agent: string
  model: string
  variant: string
}

function readPreferences(sessionID: string): Partial<SessionPreferences> {
  try {
    const raw = window.localStorage.getItem(PREFERENCES_STORAGE_KEY)
    const map = raw ? (JSON.parse(raw) as Record<string, Partial<SessionPreferences>>) : {}
    const value = map[sessionID]
    if (!value || typeof value !== "object") return {}
    return {
      ...(typeof value.agent === "string" ? { agent: value.agent } : {}),
      ...(typeof value.model === "string" ? { model: value.model } : {}),
      ...(typeof value.variant === "string" ? { variant: value.variant } : {}),
    }
  } catch {
    return {}
  }
}

function writePreferences(sessionID: string, preferences: SessionPreferences): void {
  try {
    const raw = window.localStorage.getItem(PREFERENCES_STORAGE_KEY)
    const map = raw ? (JSON.parse(raw) as Record<string, SessionPreferences>) : {}
    map[sessionID] = preferences
    window.localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(map))
  } catch {
    // storage may be unavailable (private mode)
  }
}

export function Composer({
  ref,
  sessionID,
  busy,
  connected = true,
  workspaceID,
  directory = null,
  autoAccept,
  onToggleAutoAccept,
  pending,
  header,
}: {
  /** Retry handle used by the chat container's ghost bubble. */
  ref?: Ref<ComposerHandle>
  sessionID: string
  busy: boolean
  connected?: boolean
  workspaceID: string | null
  directory?: string | null
  autoAccept: boolean
  onToggleAutoAccept: (on: boolean) => void
  /** Pending-send state owned by the chat container (#125). */
  pending: PendingSendController
  /** Composer context bar (workspace menu, branch, stats). Rendered as the dock head. */
  header?: ReactNode
}) {
  const agentsQuery = useAgents(client)
  const modelsQuery = useModels(client)
  const sessionsQuery = useSessions(client, true, 10_000, workspaceID)
  const commandsQuery = useCommands(client, directory)

  const agents = useMemo(() => selectableAgents(agentsQuery.data ?? []), [agentsQuery.data])
  const subagents = useMemo(() => mentionableAgents(agentsQuery.data ?? []), [agentsQuery.data])
  const commands = useMemo(() => mergeCommands(commandsQuery.data ?? []), [commandsQuery.data])

  const catalog = modelsQuery.data
  const modelOptions = useMemo(
    () => flattenModels(catalog?.models ?? [], catalog?.providers ?? []),
    [catalog],
  )
  const session = sessionsQuery.data?.find((item) => item.id === sessionID)
  const defaultModel = useMemo(() => {
    const sessions = sessionsQuery.data ?? []
    const preferred = sessionModelValue(session, modelOptions) ?? recentModelValue(sessions, modelOptions)
    return defaultModelValue(catalog?.defaultModel ?? null, modelOptions, preferred)
  }, [catalog, modelOptions, sessionsQuery.data, session])

  // Per-session selections: restored on mount (the view is keyed by session)
  // and written back so switching sessions or reloading keeps them.
  const stored = useMemo(() => readPreferences(sessionID), [sessionID])
  const queryClient = useQueryClient()
  const [text, setText] = useState("")
  const textRef = useRef(text)
  textRef.current = text
  /** Synchronous in-flight guard; the visible pending state lives in `pending`. */
  const inFlight = useRef<{ text: string; marker: string; attachmentIDs: string[] } | null>(null)
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const attachmentsRef = useRef(attachments)
  attachmentsRef.current = attachments
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [agent, setAgent] = useState(stored.agent ?? "")
  const [model, setModel] = useState(stored.model ?? "")
  const [variant, setVariant] = useState(stored.variant ?? "")
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const modelTouched = useRef(Boolean(stored.model))

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const pendingCaret = useRef<number | null>(null)
  const [caret, setCaret] = useState(0)
  const [caretTick, setCaretTick] = useState(0)
  const [activeIndex, setActiveIndex] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const [sideQuestion, setSideQuestion] = useState<{ sessionID: string; question: string } | null>(null)
  const [startingSideQuestion, setStartingSideQuestion] = useState(false)
  // Synchronous in-flight guards: a React state flag is not a lock, so two
  // submits dispatched in the same tick would both read `sending === false`
  // (#72). `inFlight` and the side-question flag are set/cleared synchronously
  // around every non-idempotent send.
  const startingSideQuestionRef = useRef(false)
  /** Same synchronous guard for a `/goal` start (the BFF run is non-idempotent). */
  const startingGoalRef = useRef(false)
  /** Fork created by this composer that must be removed if it is never shown. */
  const ownedForkRef = useRef<string | null>(null)
  /** False once the composer unmounted, so a fork in flight is removed later. */
  const aliveRef = useRef(true)

  const variants = useMemo(
    () => modelOptions.find((option) => option.value === model)?.variants ?? [],
    [model, modelOptions],
  )
  const selectedModel = modelOptions.find((option) => option.value === model)

  useEffect(() => {
    const fallback = agents[0]
    if (!fallback) return
    if (!agent || !agents.some((item) => item.id === agent)) setAgent(fallback.id)
  }, [agent, agents])

  useEffect(() => {
    if (modelTouched.current) return
    setModel(defaultModel)
  }, [defaultModel])

  useEffect(() => {
    if (modelOptions.length === 0 || !model) return
    if (!modelOptions.some((option) => option.value === model)) {
      modelTouched.current = false
      setModel(defaultModel)
    }
  }, [model, modelOptions, defaultModel])

  useEffect(() => {
    if (!modelOptions.some((option) => option.value === model)) return
    if (variant && !variants.includes(variant)) setVariant("")
  }, [model, modelOptions, variant, variants])

  useEffect(() => {
    writePreferences(sessionID, { agent, model, variant })
  }, [sessionID, agent, model, variant])

  // The active trigger is derived from the text and caret, so it stays in sync
  // with edits and cursor moves instead of being a separate mode to maintain.
  const trigger = useMemo(
    () => (dismissed ? null : composerTrigger(text, caret)),
    [text, caret, dismissed],
  )

  const popover = useMemo<ComposerPopover | null>(
    () => (trigger ? buildComposerPopover(trigger, commands, subagents) : null),
    [trigger, commands, subagents],
  )

  useEffect(() => {
    setActiveIndex(0)
  }, [popover])

  // Programmatic edits (suggestion selection) must move the caret after React
  // commits the new value.
  useEffect(() => {
    if (caretTick === 0) return
    const position = pendingCaret.current
    if (position === null) return
    pendingCaret.current = null
    const element = textareaRef.current
    if (!element) return
    element.focus()
    element.setSelectionRange(position, position)
  }, [caretTick])

  // A side-question fork must not outlive the composer (session switch/reload).
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      const fork = ownedForkRef.current
      if (fork) void client.api.removeSession(fork).catch(() => {})
    }
  }, [])

  /** Adds files from the picker, a drop or a paste, enforcing the limits. */
  function addFiles(files: File[]): void {
    if (files.length === 0) return
    const next = [...attachmentsRef.current]
    let total = next.reduce((sum, item) => sum + item.size, 0)
    let message: string | null = null

    for (const file of files) {
      if (next.length >= ATTACHMENT_MAX_COUNT) {
        message = `You can attach up to ${ATTACHMENT_MAX_COUNT} files per message.`
        break
      }
      if (file.size > ATTACHMENT_MAX_BYTES) {
        message = `${file.name || "This file"} is larger than ${formatFileSize(ATTACHMENT_MAX_BYTES)}.`
        continue
      }
      if (total + file.size > ATTACHMENT_MAX_TOTAL_BYTES) {
        message = `Attachments are limited to ${formatFileSize(ATTACHMENT_MAX_TOTAL_BYTES)} per message.`
        continue
      }
      const name = file.name || "file"
      if (
        next.some(
          (item) =>
            item.name === name && item.size === file.size && item.file.lastModified === file.lastModified,
        )
      ) {
        continue
      }
      const mime = file.type || mimeFromName(name)
      next.push({
        id: createAttachmentID(),
        file,
        name,
        mime,
        size: file.size,
        ...(mime.startsWith("image/") ? { previewUrl: URL.createObjectURL(file) } : {}),
        status: "ready",
      })
      total += file.size
    }

    setAttachments(next)
    setError(message)
    if (!message) setDismissed(false)
  }

  function removeAttachment(id: string): void {
    const item = attachmentsRef.current.find((entry) => entry.id === id)
    if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl)
    setAttachments((current) => current.filter((entry) => entry.id !== id))
  }

  function removeAttachmentsByID(ids: readonly string[]): void {
    if (ids.length === 0) return
    const sent = new Set(ids)
    for (const item of attachmentsRef.current) {
      if (sent.has(item.id) && item.previewUrl) URL.revokeObjectURL(item.previewUrl)
    }
    setAttachments((current) => current.filter((entry) => !sent.has(entry.id)))
  }

  // Object URLs for local previews must not outlive the composer.
  useEffect(() => {
    return () => {
      for (const item of attachmentsRef.current) {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl)
      }
    }
  }, [])

  // A session switch must never reuse a file uploaded for the previous
  // session (its `uri` points at the old session directory).
  const sessionRef = useRef(sessionID)
  useEffect(() => {
    if (sessionRef.current === sessionID) return
    sessionRef.current = sessionID
    for (const item of attachmentsRef.current) {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl)
    }
    setAttachments([])
  }, [sessionID])

  /**
   * Uploads every staged file (two at a time, so two 50 MB multiparts never
   * overlap). Already-uploaded files from a failed attempt are reused.
   */
  async function uploadAttachments(
    list: ReadonlyArray<ComposerAttachment>,
  ): Promise<{ uploaded: UploadedAttachment[]; failed: { name: string; message: string } | null }> {
    if (!workspaceID) {
      return { uploaded: [], failed: { name: "the file", message: "Select a workspace before attaching files." } }
    }
    const queue = list.filter((item) => !item.uploaded)
    const results = new Map<string, UploadedAttachment>()
    let failed: { name: string; message: string } | null = null
    let cursor = 0

    const worker = async (): Promise<void> => {
      while (cursor < queue.length) {
        const item = queue[cursor]
        cursor += 1
        if (!item) return
        setAttachments((current) =>
          current.map((entry) =>
            entry.id === item.id ? { ...entry, status: "uploading", error: undefined } : entry,
          ),
        )
        try {
          const uploaded = await client.api.attachments.upload(workspaceID, sessionID, {
            id: item.id,
            name: item.name,
            mime: item.mime,
            size: item.size,
            body: item.file,
          })
          results.set(item.id, uploaded)
          setAttachments((current) =>
            current.map((entry) =>
              entry.id === item.id ? { ...entry, status: "ready", uploaded, error: undefined } : entry,
            ),
          )
        } catch (uploadError) {
          const message = attachmentErrorMessage(uploadError, item.name)
          if (!failed) failed = { name: item.name, message }
          setAttachments((current) =>
            current.map((entry) =>
              entry.id === item.id ? { ...entry, status: "error", error: message } : entry,
            ),
          )
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(2, queue.length) }, worker))
    // Preserve the selection order; a file removed during the upload is not
    // sent (its uploaded bytes become TTL debris, never a silent attachment).
    const stillStaged = new Set(attachmentsRef.current.map((entry) => entry.id))
    const uploaded = list.flatMap((item) => {
      if (!stillStaged.has(item.id)) return []
      const found = results.get(item.id) ?? item.uploaded
      return found ? [found] : []
    })
    return { uploaded, failed }
  }

  /** Releases the composer and clears the text/attachments that were sent. */
  function completeSend(pending: { text: string; marker: string; attachmentIDs: string[] }): void {
    inFlight.current = null
    setSending(false)
    // Only clear what was actually sent: text typed while the request was in
    // flight (slow network) must survive instead of being wiped.
    if (textRef.current.trim() === pending.text) {
      setText("")
      setCaret(0)
    }
    removeAttachmentsByID(pending.attachmentIDs)
    setDismissed(false)
  }

  // The shared controller clears the ghost once the history shows this send's
  // marker (lost-response reconciliation, #71/#125). If the request has not
  // answered yet, release the composer too instead of waiting for the deadline.
  useEffect(() => {
    const current = inFlight.current
    if (current && pending.pending === null) completeSend(current)
  }, [pending.pending])

  function moveCaret(position: number): void {
    setCaret(position)
  }

  function applyReplacement(active: ComposerTrigger, replacement: string): void {
    // Collapse a space that already followed the trigger, so selecting a
    // suggestion never leaves a double space.
    const end = replacement.endsWith(" ") && text[active.end] === " " ? active.end + 1 : active.end
    const next = text.slice(0, active.start) + replacement + text.slice(end)
    const position = active.start + replacement.length
    pendingCaret.current = position
    setText(next)
    setCaret(position)
    setCaretTick((tick) => tick + 1)
    setDismissed(false)
  }

  function selectSuggestion(index: number): void {
    if (!popover || !trigger) return
    const item = popover.items[Math.min(index, popover.items.length - 1)]
    if (!item) return
    applyReplacement(trigger, item.replacement)
  }

  /**
   * Runs one prompt request. Plain prompts are tracked by the shared pending
   * controller (ghost bubble); slash commands keep the button-only feedback.
   */
  async function deliver(
    text: string,
    marker: string,
    command: ReturnType<typeof splitCommand>,
    prepared?: ReadonlyArray<UploadedAttachment>,
  ) {
    const staged = attachmentsRef.current
    const current = { text, marker, attachmentIDs: staged.map((item) => item.id) }
    inFlight.current = current
    setSending(true)
    setError(null)
    try {
      let uploaded: ReadonlyArray<UploadedAttachment> = prepared ?? []
      if (!prepared && staged.length > 0) {
        const result = await uploadAttachments(staged)
        if (result.failed) {
          // No prompt was sent, so no ghost: the draft (with the failed chip)
          // stays in the composer and Send retries it.
          if (inFlight.current === current) setError(result.failed.message)
          return
        }
        uploaded = result.uploaded
      }

      // Begin the ghost only once a prompt is actually being sent: an upload
      // failure must never look like a lost prompt.
      if (!command) pending.begin(text, marker, uploaded)

      const modelValue = model ? parseModel(model, variant || undefined) : undefined
      const mentionText = command ? command.text : text
      const mentions = collectAgentMentions(mentionText, subagents)
      const context = {
        ...(agent ? { agent } : {}),
        ...(modelValue ? { model: modelValue } : {}),
        ...(mentions.length > 0 ? { agents: mentions } : {}),
      }
      const files = inlineAttachmentFiles(uploaded)
      const promptText = `${text}${buildAttachmentContext(uploaded)}`
      const metadata = {
        ...(command ? {} : deliveryMetadata(marker)),
        ...(uploaded.length > 0 ? { [ATTACHMENT_METADATA_KEY]: attachmentMetadata(uploaded) } : {}),
      }
      if (command) {
        await client.api.runCommand(
          sessionID,
          {
            name: command.command.name,
            text: `${command.text}${buildAttachmentContext(uploaded)}`,
            ...(files.length > 0 ? { files } : {}),
            ...context,
          },
          { agent: session?.agent, model: session?.model },
        )
      } else {
        await client.api.prompt(
          sessionID,
          { text: promptText, ...(files.length > 0 ? { files } : {}), metadata, ...context },
          { agent: session?.agent, model: session?.model },
        )
      }
      if (inFlight.current === current) completeSend(current)
    } catch (err) {
      // A delivery already confirmed through the history wins over a lost or
      // timed-out response: never surface a false failure then.
      if (inFlight.current === current) {
        setError(composerErrorMessage(err, "send"))
        // Hard failures are retryable from the ghost; an ambiguous one keeps
        // reconciling against the history (lost-response rules).
        if (!command && !isAmbiguousError(err)) pending.fail(marker)
      }
    } finally {
      if (inFlight.current === current) {
        inFlight.current = null
        setSending(false)
      }
    }
  }

  async function send() {
    const trimmed = text.trim()
    const staged = attachmentsRef.current
    // Refs, not the `sending` state: two events in the same tick must not both
    // pass this check and fire two prompts (#72).
    if ((!trimmed && staged.length === 0) || inFlight.current || startingSideQuestionRef.current || startingGoalRef.current) {
      return
    }
    const command = trimmed ? splitCommand(trimmed, commands) : null
    if (command?.command.name === "btw") {
      await askSideQuestion(command.text)
      return
    }
    if (command?.command.name === "goal") {
      if (staged.length > 0) {
        setError(
          "Attachments are not supported with /goal. Send the file in a normal message first, then start the goal.",
        )
        return
      }
      await startGoal(command.text)
      return
    }
    const marker = createDeliveryMarker()
    // v1: only plain prompts get the ghost; commands keep the button feedback.
    // `deliver` begins it after the attachments finish uploading.
    await deliver(trimmed, marker, command)
  }

  /** `/goal`: starts the BFF adversarial review loop instead of a plain prompt. */
  async function startGoal(goal: string) {
    if (!goal) {
      setError("Describe the goal after /goal")
      return
    }
    if (attachmentsRef.current.length > 0) {
      setError(
        "Attachments are not supported with /goal. Send the file in a normal message first, then start the goal.",
      )
      return
    }
    if (inFlight.current || startingSideQuestionRef.current || startingGoalRef.current) return
    startingGoalRef.current = true
    setSending(true)
    setError(null)
    try {
      const modelValue = model ? parseModel(model, variant || undefined) : undefined
      await client.api.goal.start(sessionID, {
        goal,
        model: modelValue
          ? { providerID: modelValue.providerID, id: modelValue.id, variant: modelValue.variant ?? null }
          : null,
        agent: agent || null,
      })
      // SSE carries the run, but a lost frame must not hide the new strip.
      await queryClient.invalidateQueries({ queryKey: queryKeys.goal(sessionID) })
      if (textRef.current.trim() === `/goal ${goal}`) {
        setText("")
        setCaret(0)
      }
    } catch (err) {
      setError(goalErrorMessage(err))
      // The start is marker-reconciled server-side; refetch to show the run
      // if it actually landed despite the error.
      await queryClient.invalidateQueries({ queryKey: queryKeys.goal(sessionID) })
    } finally {
      startingGoalRef.current = false
      setSending(false)
    }
  }

  /** Ghost-bubble retry: resends the failed text with a fresh marker. */
  function retry(): void {
    const current = pending.pending
    if (!current || current.status !== "failed") return
    if (inFlight.current || startingSideQuestionRef.current || startingGoalRef.current) return
    const marker = createDeliveryMarker()
    void deliver(current.text, marker, null, current.attachments)
  }

  useImperativeHandle(ref, () => ({ retry, attach: addFiles }))

  /** `/btw`: fork the session, ask the question there and show the answer in a panel. */
  async function askSideQuestion(question: string) {
    if (!question) {
      setError("Write a question after /btw")
      return
    }
    setStartingSideQuestion(true)
    startingSideQuestionRef.current = true
    setError(null)
    const staged = attachmentsRef.current
    let created: string | null = null
    try {
      let uploaded: ReadonlyArray<UploadedAttachment> = staged.map((item) => item.uploaded).filter(Boolean) as UploadedAttachment[]
      if (staged.some((item) => !item.uploaded)) {
        const result = await uploadAttachments(staged)
        if (result.failed) {
          setError(result.failed.message)
          return
        }
        uploaded = result.uploaded
      }
      const fork = await client.api.forkSession(sessionID)
      created = fork.id
      // The composer unmounted while the fork was in flight: its cleanup
      // already ran and never saw this id, so remove it here (#68).
      if (!aliveRef.current) {
        void client.api.removeSession(fork.id).catch(() => {})
        return
      }
      // Register the fork before the prompt: if the prompt fails (or the
      // composer unmounts) it must still be removable (#68).
      const previous = ownedForkRef.current
      ownedForkRef.current = fork.id
      if (previous && previous !== fork.id) {
        // A second /btw replaces the open panel; the previous fork must not leak.
        void client.api.removeSession(previous).catch(() => {})
      }
      const modelValue = model ? parseModel(model, variant || undefined) : undefined
      const files = inlineAttachmentFiles(uploaded)
      await client.api.prompt(fork.id, {
        text: `${question}${buildAttachmentContext(uploaded)}`,
        ...(files.length > 0 ? { files } : {}),
        ...(uploaded.length > 0 ? { metadata: { [ATTACHMENT_METADATA_KEY]: attachmentMetadata(uploaded) } } : {}),
        ...(agent ? { agent } : {}),
        ...(modelValue ? { model: modelValue } : {}),
      })
      setSideQuestion({ sessionID: fork.id, question })
      if (textRef.current.trim() === question) {
        setText("")
        setCaret(0)
      }
      removeAttachmentsByID(staged.map((item) => item.id))
      setDismissed(false)
    } catch (err) {
      // A fork created in this attempt must not leak when the prompt fails.
      if (created) {
        if (ownedForkRef.current === created) ownedForkRef.current = null
        void client.api.removeSession(created).catch(() => {})
      }
      setError(composerErrorMessage(err, "side question"))
    } finally {
      startingSideQuestionRef.current = false
      setStartingSideQuestion(false)
    }
  }

  function closeSideQuestion() {
    setSideQuestion(null)
    const fork = ownedForkRef.current
    ownedForkRef.current = null
    if (fork) void client.api.removeSession(fork).catch(() => {})
  }

  async function stop() {
    setError(null)
    try {
      await client.api.abortSession(sessionID)
    } catch (stopError) {
      // Never fail silently: the turn may still be running.
      setError(
        isAmbiguousError(stopError)
          ? "The server did not answer in time — the agent may still be stopping. Check the status."
          : "Could not stop the agent. Try again.",
      )
    }
  }

  const effortIcon = variants.some(isEffortVariant) ? (
    <BrainIcon size={14} className="shrink-0 text-ink-muted" />
  ) : (
    <SlidersIcon size={14} className="shrink-0 text-ink-muted" />
  )

  return (
    <div className="pb-safe border-t border-hairline bg-canvas px-3 pt-3 md:px-6">
      <div className="mh-chat-col space-y-2">
        {sideQuestion && (
          <SideQuestionPanel
            sessionID={sideQuestion.sessionID}
            question={sideQuestion.question}
            connected={connected}
            onClose={closeSideQuestion}
          />
        )}

        <div className="mh-composer-dock">
          {header && <div className="mh-composer-dock__head">{header}</div>}

          <div className="mh-composer-dock__body relative">
            {popover && (
              <ComposerSuggestions
                id="composer-suggestions"
                title={popover.title}
                hint={popover.hint}
                items={popover.items}
                activeIndex={Math.min(activeIndex, Math.max(0, popover.items.length - 1))}
                emptyLabel={popover.emptyLabel}
                onActive={setActiveIndex}
                onSelect={selectSuggestion}
              />
            )}
            {attachments.length > 0 && (
              <div className="mh-attachment-strip" aria-label="Attached files">
                {attachments.map((attachment) => (
                  <AttachmentChip key={attachment.id} attachment={attachment} onRemove={removeAttachment} />
                ))}
              </div>
            )}
            <textarea
              ref={textareaRef}
              value={text}
              role="combobox"
              aria-expanded={Boolean(popover)}
              aria-controls={popover ? "composer-suggestions" : undefined}
              aria-autocomplete="list"
              aria-activedescendant={
                popover && popover.items.length > 0
                  ? `composer-suggestions-${popover.items[Math.min(activeIndex, popover.items.length - 1)]?.id}`
                  : undefined
              }
              onChange={(event) => {
                setText(event.target.value)
                setCaret(event.target.selectionStart ?? event.target.value.length)
                setDismissed(false)
              }}
              onPaste={(event) => {
                const items = Array.from(event.clipboardData?.items ?? [])
                const files = items
                  .filter((item) => item.kind === "file")
                  .flatMap((item) => {
                    const file = item.getAsFile()
                    return file ? [file] : []
                  })
                const fallback = Array.from(event.clipboardData?.files ?? [])
                const pasted = files.length > 0 ? files : fallback
                if (pasted.length > 0) {
                  event.preventDefault()
                  addFiles(pasted)
                }
              }}
              onKeyDown={(event) => {
                if (popover && popover.items.length > 0) {
                  if (event.key === "ArrowDown") {
                    event.preventDefault()
                    setActiveIndex((index) => (index + 1) % popover.items.length)
                    return
                  }
                  if (event.key === "ArrowUp") {
                    event.preventDefault()
                    setActiveIndex((index) => (index - 1 + popover.items.length) % popover.items.length)
                    return
                  }
                  if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
                    event.preventDefault()
                    selectSuggestion(activeIndex)
                    return
                  }
                }
                if (event.key === "Escape" && popover) {
                  event.preventDefault()
                  setDismissed(true)
                  return
                }
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault()
                  void send()
                }
              }}
              onFocus={() => setDismissed(false)}
              onBlur={() => setDismissed(true)}
              onClick={(event) => {
                setDismissed(false)
                moveCaret(event.currentTarget.selectionStart ?? 0)
              }}
              onKeyUp={(event) => {
                if (event.key !== "Escape") setDismissed(false)
                moveCaret(event.currentTarget.selectionStart ?? 0)
              }}
              rows={1}
              placeholder="Write a message…"
              className="mh-composer-dock__field scroll-thin field-sizing-content max-h-40"
            />
          </div>

          <div className="mh-composer-dock__toolbar">
            <button
              type="button"
              className="mh-icon-btn shrink-0"
              onClick={() => fileInputRef.current?.click()}
              title="Attach files"
              aria-label="Attach files"
            >
              <PaperclipIcon size={16} />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              tabIndex={-1}
              aria-hidden="true"
              className="sr-only"
              onChange={(event) => {
                const files = Array.from(event.target.files ?? [])
                // Reset so selecting the same file again fires `change`.
                event.target.value = ""
                addFiles(files)
              }}
            />
            <SearchSelect
              compact
              ghost
              value={agent}
              options={agents.map((item) => ({ value: item.id, label: item.name }))}
              onChange={setAgent}
              ariaLabel="Agent"
              placeholder="agent…"
            />
            <SearchSelect
              compact
              ghost
              value={model}
              options={modelOptions.map((option) => ({
                value: option.value,
                label: option.label,
                triggerLabel: option.model,
              }))}
              onChange={(value) => {
                modelTouched.current = true
                setModel(value)
              }}
              icon={
                selectedModel ? (
                  <ProviderGlyph providerID={selectedModel.providerID} name={selectedModel.provider} />
                ) : undefined
              }
              title={selectedModel?.label}
              ariaLabel="Model"
              placeholder="model…"
            />
            {variants.length > 0 && (
              <SearchSelect
                compact
                ghost
                icon={effortIcon}
                value={variant}
                options={[
                  { value: "", label: "Default" },
                  ...variants.map((key) => ({ value: key, label: variantLabel(key) })),
                ]}
                onChange={setVariant}
                ariaLabel="Effort"
                placeholder="Default"
              />
            )}
            <button
              type="button"
              aria-pressed={autoAccept}
              onClick={() => onToggleAutoAccept(!autoAccept)}
              title="Auto-accept permission requests for this session (answers “once”)"
              className={`mh-chip ml-auto shrink-0 cursor-pointer ${autoAccept ? "mh-chip--outline text-accent" : "mh-chip--outline"}`}
            >
              <ShieldCheckIcon size={13} />
              {autoAccept ? "Auto-accept: on" : "Auto-accept"}
            </button>
            {busy ? (
              <button
                type="button"
                onClick={() => void stop()}
                title="Stop the agent"
                className="mh-btn mh-btn--danger mh-btn--sm shrink-0"
              >
                <StopIcon size={14} />
                Stop
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void send()}
                disabled={(!text.trim() && attachments.length === 0) || sending || startingSideQuestion}
                title="Send message"
                className="mh-btn mh-btn--primary mh-btn--sm shrink-0"
              >
                <ArrowUpIcon size={14} />
                {startingSideQuestion ? "Starting…" : sending ? "Sending…" : "Send"}
              </button>
            )}
          </div>

          {error && <p className="mh-composer-dock__error text-xs text-danger">{error}</p>}
        </div>
      </div>
    </div>
  )
}
