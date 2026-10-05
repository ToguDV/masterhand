import { useEffect, useMemo, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  ApiError,
  RequestTimeoutError,
  buildComposerPopover,
  collectAgentMentions,
  composerTrigger,
  defaultModelValue,
  flattenModels,
  mentionableAgents,
  mergeCommands,
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
  type ChatMessage,
  type ComposerPopover,
  type ComposerTrigger,
} from "@masterhand/client-core"
import { client } from "../client"
import { ComposerSuggestions } from "./ComposerSuggestions"
import { SearchSelect } from "./SearchSelect"
import { SideQuestionPanel } from "./SideQuestionPanel"

const PREFERENCES_STORAGE_KEY = "masterhand.sessionPreferences"

/** Maps a failed composer request to a user-facing message. */
function composerErrorMessage(error: unknown, kind: "send" | "side question"): string {
  if (error instanceof RequestTimeoutError) {
    return kind === "send"
      ? "The server did not respond — your message may not have been sent. Check the chat before retrying."
      : "The server did not respond — the side question may not have started. Try again."
  }
  if (error instanceof ApiError) {
    return kind === "send"
      ? `Could not send (HTTP ${error.status})`
      : `Could not start the side question (HTTP ${error.status})`
  }
  return kind === "send" ? "Could not send" : "Could not start the side question"
}

/** Plain text of a chat message (user messages carry a single text part). */
function chatMessageText(message: ChatMessage): string {
  return message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
}

/** A send waiting for its HTTP response, kept for delivery reconciliation. */
interface PendingSend {
  text: string
  at: number
  /** User-message ids already known when the send started. */
  known: Set<string>
}

/** Clock tolerance between the client and the server when matching the sent message. */
const DELIVERY_SKEW_MS = 5_000

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
  sessionID,
  busy,
  connected = true,
  workspaceID,
  directory = null,
  autoAccept,
  onToggleAutoAccept,
}: {
  sessionID: string
  busy: boolean
  connected?: boolean
  workspaceID: string | null
  directory?: string | null
  autoAccept: boolean
  onToggleAutoAccept: (on: boolean) => void
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
  const pendingSend = useRef<PendingSend | null>(null)
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
  const sideQuestionRef = useRef(sideQuestion)
  sideQuestionRef.current = sideQuestion

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
  useEffect(
    () => () => {
      const current = sideQuestionRef.current
      if (current) void client.api.removeSession(current.sessionID).catch(() => {})
    },
    [],
  )

  /** Releases the composer and clears the text that was actually sent. */
  function completeSend(pending: PendingSend): void {
    pendingSend.current = null
    setSending(false)
    // Only clear what was actually sent: text typed while the request was in
    // flight (slow network) must survive instead of being wiped.
    if (textRef.current.trim() === pending.text) {
      setText("")
      setCaret(0)
    }
    setDismissed(false)
  }

  // Delivery reconciliation: the prompt response can be lost while opencode
  // already processed the message, so waiting only for the request deadline
  // would keep the button locked (and warn falsely) until it expires. As soon
  // as the live history shows the sent message, the send is confirmed and the
  // composer is released immediately; the deadline stays as the fallback for
  // an unconfirmable send.
  useEffect(() => {
    if (!sending) return
    const pending = pendingSend.current
    if (!pending) return
    const check = (): void => {
      const messages = queryClient.getQueryData<ChatMessage[]>(queryKeys.messages(sessionID))
      const delivered = messages?.some(
        (message) =>
          message.info.role === "user" &&
          !pending.known.has(message.info.id) &&
          message.info.time.created >= pending.at - DELIVERY_SKEW_MS &&
          chatMessageText(message) === pending.text,
      )
      if (delivered) completeSend(pending)
    }
    check()
    return queryClient.getQueryCache().subscribe(check)
  }, [sending, queryClient, sessionID])

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

  async function send() {
    const trimmed = text.trim()
    if (!trimmed || sending) return
    const command = splitCommand(trimmed, commands)
    if (command?.command.name === "btw") {
      await askSideQuestion(command.text)
      return
    }
    setSending(true)
    setError(null)
    const known = queryClient.getQueryData<ChatMessage[]>(queryKeys.messages(sessionID)) ?? []
    const pending: PendingSend = {
      text: trimmed,
      at: Date.now(),
      known: new Set(
        known.filter((message) => message.info.role === "user").map((message) => message.info.id),
      ),
    }
    pendingSend.current = pending
    try {
      const modelValue = model ? parseModel(model, variant || undefined) : undefined
      const mentionText = command ? command.text : trimmed
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
          { text: trimmed, ...context },
          { agent: session?.agent, model: session?.model },
        )
      }
      if (pendingSend.current === pending) completeSend(pending)
    } catch (err) {
      // A delivery already confirmed through the history wins over a lost or
      // timed-out response: never surface a false failure then.
      if (pendingSend.current === pending) setError(composerErrorMessage(err, "send"))
    } finally {
      if (pendingSend.current === pending) {
        pendingSend.current = null
        setSending(false)
      }
    }
  }

  /** `/btw`: fork the session, ask the question there and show the answer in a panel. */
  async function askSideQuestion(question: string) {
    if (!question) {
      setError("Write a question after /btw")
      return
    }
    setStartingSideQuestion(true)
    setError(null)
    try {
      const fork = await client.api.forkSession(sessionID)
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
      setError(composerErrorMessage(err, "side question"))
    } finally {
      setStartingSideQuestion(false)
    }
  }

  function closeSideQuestion() {
    const current = sideQuestion
    setSideQuestion(null)
    if (current) void client.api.removeSession(current.sessionID).catch(() => {})
  }

  async function stop() {
    try {
      await client.api.abortSession(sessionID)
    } catch {
      // the state reconciles through events
    }
  }

  return (
    <div className="pb-safe border-t border-hairline bg-canvas px-3 pt-2 md:px-6">
      <div className="mh-chat-col space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <SearchSelect
            value={agent}
            options={agents.map((item) => ({ value: item.id, label: item.name }))}
            onChange={setAgent}
            ariaLabel="Agent"
            placeholder="agent…"
          />
          <SearchSelect
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
              value={variant}
              options={[
                { value: "", label: "Effort: default" },
                ...variants.map((key) => ({ value: key, label: `Effort: ${variantLabel(key)}` })),
              ]}
              onChange={setVariant}
              ariaLabel="Effort"
              placeholder="Effort: default"
            />
          )}
          <button
            type="button"
            aria-pressed={autoAccept}
            onClick={() => onToggleAutoAccept(!autoAccept)}
            title="Auto-accept permission requests for this session (answers “once”)"
            className={`mh-chip shrink-0 cursor-pointer ${autoAccept ? "mh-chip--warning" : "mh-chip--outline"}`}
          >
            {autoAccept ? "Auto-accept: on" : "Auto-accept"}
          </button>
        </div>

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

        {error && <p className="text-xs text-danger">{error}</p>}
      </div>
    </div>
  )
}
