import { useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from "react"
import {
  buildComposerPopover,
  collectAgentMentions,
  composerErrorMessage,
  composerTrigger,
  createDeliveryMarker,
  defaultModelValue,
  deliveryMetadata,
  flattenModels,
  isAmbiguousError,
  isEffortVariant,
  mentionableAgents,
  mergeCommands,
  parseModel,
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
} from "@masterhand/client-core"
import { client } from "../client"
import { ComposerSuggestions } from "./ComposerSuggestions"
import { SearchSelect } from "./SearchSelect"
import { SideQuestionPanel } from "./SideQuestionPanel"
import { BrainIcon, ShieldCheckIcon, SlidersIcon } from "./icons"

const PREFERENCES_STORAGE_KEY = "masterhand.sessionPreferences"

/** Imperative surface for the chat container's ghost-bubble retry (#125). */
export interface ComposerHandle {
  retry: () => void
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
  /** Composer top bar (workspace menu, new session, stats). */
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
  const [text, setText] = useState("")
  const textRef = useRef(text)
  textRef.current = text
  /** Synchronous in-flight guard; the visible pending state lives in `pending`. */
  const inFlight = useRef<{ text: string; marker: string } | null>(null)
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
  /** Fork created by this composer that must be removed if it is never shown. */
  const ownedForkRef = useRef<string | null>(null)
  /** False once the composer unmounted, so a fork in flight is removed later. */
  const aliveRef = useRef(true)

  const variants = useMemo(
    () => modelOptions.find((option) => option.value === model)?.variants ?? [],
    [model, modelOptions],
  )

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

  /** Releases the composer and clears the text that was actually sent. */
  function completeSend(pending: { text: string; marker: string }): void {
    inFlight.current = null
    setSending(false)
    // Only clear what was actually sent: text typed while the request was in
    // flight (slow network) must survive instead of being wiped.
    if (textRef.current.trim() === pending.text) {
      setText("")
      setCaret(0)
    }
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
  async function deliver(text: string, marker: string, command: ReturnType<typeof splitCommand>) {
    setSending(true)
    setError(null)
    const current = { text, marker }
    inFlight.current = current
    try {
      const modelValue = model ? parseModel(model, variant || undefined) : undefined
      const mentionText = command ? command.text : text
      const mentions = collectAgentMentions(mentionText, subagents)
      const context = {
        ...(agent ? { agent } : {}),
        ...(modelValue ? { model: modelValue } : {}),
        ...(mentions.length > 0 ? { agents: mentions } : {}),
      }
      if (command) {
        await client.api.runCommand(
          sessionID,
          { name: command.command.name, text: command.text, ...context },
          { agent: session?.agent, model: session?.model },
        )
      } else {
        await client.api.prompt(
          sessionID,
          { text, metadata: deliveryMetadata(marker), ...context },
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
    // Refs, not the `sending` state: two events in the same tick must not both
    // pass this check and fire two prompts (#72).
    if (!trimmed || inFlight.current || startingSideQuestionRef.current) return
    const command = splitCommand(trimmed, commands)
    if (command?.command.name === "btw") {
      await askSideQuestion(command.text)
      return
    }
    const marker = createDeliveryMarker()
    // v1: only plain prompts get the ghost; commands keep the button feedback.
    if (!command) pending.begin(trimmed, marker)
    await deliver(trimmed, marker, command)
  }

  /** Ghost-bubble retry: resends the failed text with a fresh marker. */
  function retry(): void {
    const current = pending.pending
    if (!current || current.status !== "failed") return
    if (inFlight.current || startingSideQuestionRef.current) return
    const marker = createDeliveryMarker()
    pending.begin(current.text, marker)
    void deliver(current.text, marker, null)
  }

  useImperativeHandle(ref, () => ({ retry }))

  /** `/btw`: fork the session, ask the question there and show the answer in a panel. */
  async function askSideQuestion(question: string) {
    if (!question) {
      setError("Write a question after /btw")
      return
    }
    setStartingSideQuestion(true)
    startingSideQuestionRef.current = true
    setError(null)
    let created: string | null = null
    try {
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
      await client.api.prompt(fork.id, {
        text: question,
        ...(agent ? { agent } : {}),
        ...(modelValue ? { model: modelValue } : {}),
      })
      setSideQuestion({ sessionID: fork.id, question })
      if (textRef.current.trim() === question) {
        setText("")
        setCaret(0)
      }
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
    <div className="pb-safe border-t border-hairline bg-canvas px-3 pt-2 md:px-6">
      <div className="mh-chat-col space-y-2">
        {header}

        {sideQuestion && (
          <SideQuestionPanel
            sessionID={sideQuestion.sessionID}
            question={sideQuestion.question}
            connected={connected}
            onClose={closeSideQuestion}
          />
        )}

        <div className="relative">
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
          <div className="flex items-end gap-2">
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
              className="mh-input mh-composer-input scroll-thin field-sizing-content max-h-40 flex-1"
            />
            {busy ? (
              <button type="button" onClick={() => void stop()} className="mh-btn mh-btn--danger h-11 shrink-0">
                Stop
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void send()}
                disabled={!text.trim() || sending || startingSideQuestion}
                className="mh-btn mh-btn--primary h-11 shrink-0"
              >
                {startingSideQuestion ? "Starting…" : sending ? "Sending…" : "Send"}
              </button>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <SearchSelect
            compact
            value={agent}
            options={agents.map((item) => ({ value: item.id, label: item.name }))}
            onChange={setAgent}
            ariaLabel="Agent"
            placeholder="agent…"
          />
          <SearchSelect
            compact
            value={model}
            options={modelOptions.map((option) => ({ value: option.value, label: option.label }))}
            onChange={(value) => {
              modelTouched.current = true
              setModel(value)
            }}
            ariaLabel="Model"
            placeholder="model…"
          />
          {variants.length > 0 && (
            <SearchSelect
              compact
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
            className={`mh-chip ml-auto shrink-0 cursor-pointer ${autoAccept ? "mh-chip--accent" : "mh-chip--outline"}`}
          >
            <ShieldCheckIcon size={13} />
            {autoAccept ? "Auto-accept: on" : "Auto-accept"}
          </button>
        </div>

        {error && <p className="text-xs text-danger">{error}</p>}
      </div>
    </div>
  )
}
