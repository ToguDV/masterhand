import { useEffect, useMemo, useRef, useState } from "react"
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native"
import {
  ApiError,
  buildComposerPopover,
  collectAgentMentions,
  composerTrigger,
  defaultModelValue,
  flattenModels,
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
  type Client,
  type ComposerPopover,
} from "@masterhand/client-core"
import { ChoiceModal, type ChoiceOption } from "./ChoiceModal"
import { ComposerSuggestions } from "./ComposerSuggestions"
import { SideQuestionPanel } from "./SideQuestionPanel"
import { loadSessionPreferences, saveSessionPreferences } from "../storage"
import { colors } from "../theme"

type OpenPicker = "agent" | "model" | "effort" | null

export function Composer({
  client,
  sessionID,
  busy,
  connected = true,
  workspaceID,
  directory = null,
  autoAccept,
  onToggleAutoAccept,
}: {
  client: Client
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

  const [text, setText] = useState("")
  const [agent, setAgent] = useState("")
  const [model, setModel] = useState("")
  const [variant, setVariant] = useState("")
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [picker, setPicker] = useState<OpenPicker>(null)
  const [caret, setCaret] = useState(0)
  const [forcedSelection, setForcedSelection] = useState<{ start: number; end: number } | undefined>(undefined)
  const [dismissed, setDismissed] = useState(false)
  const [sideQuestion, setSideQuestion] = useState<{ sessionID: string; question: string } | null>(null)
  const [startingSideQuestion, setStartingSideQuestion] = useState(false)
  // Synchronous in-flight guard: the `sending` state is not a lock, so two
  // presses dispatched in the same tick would both fire a prompt (#72).
  const sendLock = useRef(false)
  const modelTouched = useRef(false)
  const loaded = useRef(false)
  const sideQuestionRef = useRef(sideQuestion)
  sideQuestionRef.current = sideQuestion

  const variants = useMemo(
    () => modelOptions.find((option) => option.value === model)?.variants ?? [],
    [model, modelOptions],
  )

  // Per-session selections: restore from storage when the session changes, then
  // write back so reopening the session brings back agent, model and effort.
  useEffect(() => {
    let active = true
    loaded.current = false
    void loadSessionPreferences(sessionID).then((preferences) => {
      if (!active) return
      if (preferences.agent) setAgent(preferences.agent)
      if (preferences.model) {
        modelTouched.current = true
        setModel(preferences.model)
      }
      if (preferences.variant) setVariant(preferences.variant)
      loaded.current = true
    })
    return () => {
      active = false
    }
  }, [sessionID])

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
    if (!loaded.current) return
    void saveSessionPreferences(sessionID, { agent, model, variant })
  }, [sessionID, agent, model, variant])

  // A side-question fork must not outlive the composer (session switch/reload).
  useEffect(
    () => () => {
      const current = sideQuestionRef.current
      if (current) void client.api.removeSession(current.sessionID).catch(() => {})
    },
    [client],
  )

  const trigger = useMemo(
    () => (dismissed ? null : composerTrigger(text, caret)),
    [text, caret, dismissed],
  )

  const popover = useMemo<ComposerPopover | null>(
    () => (trigger ? buildComposerPopover(trigger, commands, subagents) : null),
    [trigger, commands, subagents],
  )

  function selectSuggestion(id: string): void {
    if (!popover || !trigger) return
    const item = popover.items.find((entry) => entry.id === id)
    if (!item) return
    const end = item.replacement.endsWith(" ") && text[trigger.end] === " " ? trigger.end + 1 : trigger.end
    const next = text.slice(0, trigger.start) + item.replacement + text.slice(end)
    const position = trigger.start + item.replacement.length
    setText(next)
    setCaret(position)
    setForcedSelection({ start: position, end: position })
    setDismissed(false)
  }

  async function send() {
    const trimmed = text.trim()
    // Refs, not the `sending` state: two events in the same tick must not both
    // pass this check and fire two prompts (#72).
    if (!trimmed || sendLock.current) return
    sendLock.current = true
    try {
      const command = splitCommand(trimmed, commands)
      if (command?.command.name === "btw") {
        await askSideQuestion(command.text)
        return
      }
      setSending(true)
      setError(null)
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
        setText("")
        setCaret(0)
        setForcedSelection(undefined)
        setDismissed(false)
      } catch (err) {
        setError(err instanceof ApiError ? `Could not send (HTTP ${err.status})` : "Could not send")
      } finally {
        setSending(false)
      }
    } finally {
      sendLock.current = false
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
      setText("")
      setCaret(0)
      setForcedSelection(undefined)
      setDismissed(false)
    } catch (err) {
      setError(
        err instanceof ApiError
          ? `Could not start the side question (HTTP ${err.status})`
          : "Could not start the side question",
      )
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

  const agentChoices: ChoiceOption[] = agents.map((item) => ({ value: item.id, label: item.name }))
  const modelChoices: ChoiceOption[] = modelOptions.map((option) => ({ value: option.value, label: option.label }))
  const effortChoices: ChoiceOption[] = variants.map((key) => ({ value: key, label: variantLabel(key) }))

  return (
    <View style={styles.container}>
      <View style={styles.selectors}>
        <Selector
          label={agents.find((item) => item.id === agent)?.name ?? "agent…"}
          onPress={() => setPicker("agent")}
          disabled={agentChoices.length === 0}
        />
        <Selector
          label={modelOptions.find((option) => option.value === model)?.label ?? "model…"}
          onPress={() => setPicker("model")}
          disabled={modelChoices.length === 0}
        />
        {variants.length > 0 && (
          <Selector
            label={variant ? variantLabel(variant) : "effort: default"}
            onPress={() => setPicker("effort")}
            disabled={false}
          />
        )}
        <Pressable
          style={[styles.selector, styles.autoAccept, autoAccept && styles.autoAcceptOn]}
          onPress={() => onToggleAutoAccept(!autoAccept)}
          accessibilityRole="switch"
          accessibilityState={{ checked: autoAccept }}
          accessibilityLabel="Auto-accept permission requests for this session"
        >
          <Text
            style={[styles.selectorText, autoAccept && styles.autoAcceptText]}
            numberOfLines={1}
          >
            {autoAccept ? "auto-accept: on" : "auto-accept"}
          </Text>
        </Pressable>
      </View>

      {popover && (
        <ComposerSuggestions
          title={popover.title}
          hint={popover.hint}
          items={popover.items}
          emptyLabel={popover.emptyLabel}
          onSelect={selectSuggestion}
        />
      )}

      {sideQuestion && (
        <SideQuestionPanel
          client={client}
          sessionID={sideQuestion.sessionID}
          question={sideQuestion.question}
          connected={connected}
          onClose={closeSideQuestion}
        />
      )}

      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          value={text}
          onChangeText={(value) => {
            setText(value)
            setDismissed(false)
          }}
          onFocus={() => setDismissed(false)}
          onBlur={() => setDismissed(true)}
          selection={forcedSelection}
          onSelectionChange={(event) => {
            setCaret(event.nativeEvent.selection.start)
            if (forcedSelection) setForcedSelection(undefined)
          }}
          placeholder="Write a message…"
          placeholderTextColor={colors.muted}
          multiline
          testID="composer-input"
        />
        {busy ? (
          <Pressable style={[styles.action, styles.stop]} onPress={() => void stop()}>
            <Text style={styles.actionText}>Stop</Text>
          </Pressable>
        ) : (
          <Pressable
            style={[styles.action, (!text.trim() || sending || startingSideQuestion) && styles.actionDisabled]}
            disabled={!text.trim() || sending || startingSideQuestion}
            onPress={() => void send()}
          >
            <Text style={styles.actionText}>{startingSideQuestion ? "Starting…" : "Send"}</Text>
          </Pressable>
        )}
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <ChoiceModal
        visible={picker === "agent"}
        title="Agent"
        options={agentChoices}
        selected={agent}
        onSelect={setAgent}
        onClose={() => setPicker(null)}
      />
      <ChoiceModal
        visible={picker === "model"}
        title="Model"
        options={modelChoices}
        selected={model}
        onSelect={(value) => {
          modelTouched.current = true
          setModel(value)
        }}
        onClose={() => setPicker(null)}
      />
      <ChoiceModal
        visible={picker === "effort"}
        title="Effort"
        options={[{ value: "", label: "Default" }, ...effortChoices]}
        selected={variant}
        onSelect={setVariant}
        onClose={() => setPicker(null)}
      />
    </View>
  )
}

function Selector({ label, onPress, disabled }: { label: string; onPress: () => void; disabled: boolean }) {
  return (
    <Pressable style={[styles.selector, disabled && styles.actionDisabled]} onPress={onPress} disabled={disabled}>
      <Text style={styles.selectorText} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  container: {
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.background,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 16,
  },
  selectors: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  selector: {
    flexGrow: 1,
    flexBasis: "30%",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  selectorText: {
    color: colors.text,
    fontSize: 12,
  },
  autoAccept: {
    flexGrow: 0,
    flexBasis: "auto",
  },
  autoAcceptOn: {
    borderColor: colors.warning,
    backgroundColor: "rgba(245, 158, 11, 0.12)",
  },
  autoAcceptText: {
    color: colors.warning,
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
  },
  input: {
    flex: 1,
    maxHeight: 140,
    minHeight: 44,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    borderRadius: 12,
    color: colors.text,
    fontSize: 15,
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 12,
  },
  action: {
    height: 44,
    justifyContent: "center",
    borderRadius: 12,
    backgroundColor: colors.accent,
    paddingHorizontal: 18,
  },
  stop: {
    backgroundColor: "#7f1d1d",
  },
  actionDisabled: {
    opacity: 0.5,
  },
  actionText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "700",
  },
  error: {
    color: colors.danger,
    fontSize: 12,
  },
})
