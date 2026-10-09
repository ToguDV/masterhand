import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react"
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native"
import { useQueryClient } from "@tanstack/react-query"
import {
  buildComposerPopover,
  collectAgentMentions,
  composerErrorMessage,
  composerTrigger,
  createDeliveryMarker,
  defaultModelValue,
  deliveryMetadata,
  flattenModels,
  goalErrorMessage,
  isAmbiguousError,
  isEffortVariant,
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
  type Client,
  type ComposerPopover,
  type CreateWorkspaceInput,
  type PendingSendController,
  type WorkspaceRecord,
} from "@masterhand/client-core"
import { ChoiceModal, type ChoiceOption } from "./ChoiceModal"
import { ComposerSuggestions } from "./ComposerSuggestions"
import { SideQuestionPanel } from "./SideQuestionPanel"
import { WorkspaceModal } from "./WorkspaceModal"
import { BrainIcon, ChevronDownIcon, FolderIcon, SlidersIcon } from "./icons"
import { loadSessionPreferences, saveSessionPreferences } from "../storage"
import { useTheme, useThemedStyles, type Fonts, type Palette } from "../theme"

type OpenPicker = "agent" | "model" | "effort" | null

/** Imperative surface for the chat screen's ghost-bubble retry (#125). */
export interface ComposerHandle {
  retry: () => void
}

export function Composer({
  ref,
  client,
  sessionID,
  busy,
  connected = true,
  workspaceID,
  directory = null,
  autoAccept,
  onToggleAutoAccept,
  pending,
  workspaces = [],
  onSelectWorkspace,
  onAddWorkspace,
  onRemoveWorkspace,
}: {
  /** Retry handle used by the chat screen's ghost bubble. */
  ref?: Ref<ComposerHandle>
  client: Client
  sessionID: string
  busy: boolean
  connected?: boolean
  workspaceID: string | null
  directory?: string | null
  autoAccept: boolean
  onToggleAutoAccept: (on: boolean) => void
  /** Pending-send state owned by the chat screen (#125). */
  pending: PendingSendController
  /** Workspace management lives in the composer top bar (web parity, #92). */
  workspaces?: WorkspaceRecord[]
  onSelectWorkspace?: (id: string) => void
  onAddWorkspace?: (input: CreateWorkspaceInput) => Promise<void>
  onRemoveWorkspace?: (id: string, options: { deleteFiles: boolean }) => void
}) {
  const agentsQuery = useAgents(client)
  const modelsQuery = useModels(client)
  const sessionsQuery = useSessions(client, true, 10_000, workspaceID)
  const commandsQuery = useCommands(client, directory)
  const queryClient = useQueryClient()

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
  const textRef = useRef(text)
  textRef.current = text
  /** Synchronous in-flight guard; the visible pending state lives in `pending`. */
  const inFlight = useRef<{ text: string; marker: string } | null>(null)
  const [agent, setAgent] = useState("")
  const [model, setModel] = useState("")
  const [variant, setVariant] = useState("")
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [picker, setPicker] = useState<OpenPicker>(null)
  const [workspaceOpen, setWorkspaceOpen] = useState(false)
  const [caret, setCaret] = useState(0)
  const [forcedSelection, setForcedSelection] = useState<{ start: number; end: number } | undefined>(undefined)
  const [dismissed, setDismissed] = useState(false)
  const [sideQuestion, setSideQuestion] = useState<{ sessionID: string; question: string } | null>(null)
  const [startingSideQuestion, setStartingSideQuestion] = useState(false)
  const [startingGoal, setStartingGoal] = useState(false)
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()
  // Synchronous in-flight guards: the `sending` state is not a lock, so two
  // presses dispatched in the same tick would both fire a prompt (#72).
  // `inFlight` is set before the first `await` and cleared by the request
  // outcome or by the delivery reconciliation.
  const startingSideQuestionRef = useRef(false)
  const startingGoalRef = useRef(false)
  /** Fork created by this composer that must be removed if it is never shown. */
  const ownedForkRef = useRef<string | null>(null)
  /** False once the composer unmounted, so a fork in flight is removed later. */
  const aliveRef = useRef(true)
  const modelTouched = useRef(false)
  const loaded = useRef(false)

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
    // Best effort: a failed preference write must not surface as an unhandled
    // rejection (issue #82); the in-memory selection still applies.
    void saveSessionPreferences(sessionID, { agent, model, variant }).catch(() => {})
  }, [sessionID, agent, model, variant])

  // A side-question fork must not outlive the composer (session switch/reload).
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      const fork = ownedForkRef.current
      if (fork) void client.api.removeSession(fork).catch(() => {})
    }
  }, [client])

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

  /** Releases the composer and clears the text that was actually sent. */
  function completeSend(pending: { text: string; marker: string }): void {
    inFlight.current = null
    setSending(false)
    // Only clear what was actually sent: text typed while the request was in
    // flight (slow network) must survive instead of being wiped.
    if (textRef.current.trim() === pending.text) {
      setText("")
      setCaret(0)
      setForcedSelection(undefined)
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
    if (!trimmed || inFlight.current || startingSideQuestionRef.current || startingGoalRef.current) return
    const command = splitCommand(trimmed, commands)
    if (command?.command.name === "btw") {
      await askSideQuestion(command.text)
      return
    }
    if (command?.command.name === "goal") {
      await startGoal(command.text)
      return
    }
    const marker = createDeliveryMarker()
    // v1: only plain prompts get the ghost; commands keep the button feedback.
    if (!command) pending.begin(trimmed, marker)
    await deliver(trimmed, marker, command)
  }

  /** `/goal`: starts the BFF adversarial review loop instead of a plain prompt. */
  async function startGoal(goal: string) {
    if (!goal) {
      setError("Describe the goal after /goal")
      return
    }
    if (inFlight.current || startingSideQuestionRef.current || startingGoalRef.current) return
    startingGoalRef.current = true
    setStartingGoal(true)
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
        setForcedSelection(undefined)
      }
      setDismissed(false)
    } catch (err) {
      setError(goalErrorMessage(err))
      // The start is marker-reconciled server-side; refetch to show the run
      // if it actually landed despite the error.
      await queryClient.invalidateQueries({ queryKey: queryKeys.goal(sessionID) })
    } finally {
      startingGoalRef.current = false
      setStartingGoal(false)
      setSending(false)
    }
  }

  /** Ghost-bubble retry: resends the failed text with a fresh marker. */
  function retry(): void {
    const current = pending.pending
    if (!current || current.status !== "failed") return
    if (inFlight.current || startingSideQuestionRef.current || startingGoalRef.current) return
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
        setForcedSelection(undefined)
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
    try {
      await client.api.abortSession(sessionID)
    } catch {
      // the state reconciles through events
    }
  }

  const agentChoices: ChoiceOption[] = agents.map((item) => ({ value: item.id, label: item.name }))
  const modelChoices: ChoiceOption[] = modelOptions.map((option) => ({ value: option.value, label: option.label }))
  const effortChoices: ChoiceOption[] = variants.map((key) => ({ value: key, label: variantLabel(key) }))
  const workspace = workspaces.find((item) => item.id === workspaceID) ?? null
  // Effort variants get the brain glyph; provider-specific ones the sliders.
  const effortIsBrain = variants.length > 0 && variants.every((key) => isEffortVariant(key))

  return (
    <View style={styles.container}>
      <View style={styles.topBar}>
        <Pressable
          style={styles.workspaceTrigger}
          onPress={() => setWorkspaceOpen(true)}
          accessibilityRole="button"
          accessibilityLabel="Workspace"
        >
          <FolderIcon size={14} color={colors.textMuted} />
          <Text style={styles.workspaceName} numberOfLines={1}>
            {workspace?.name ?? "No workspace"}
          </Text>
          <ChevronDownIcon size={14} color={colors.textMuted} />
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
          placeholderTextColor={colors.textFaint}
          multiline
          testID="composer-input"
        />
        {busy ? (
          <Pressable style={[styles.action, styles.stop]} onPress={() => void stop()}>
            <Text style={[styles.actionText, styles.stopText]}>Stop</Text>
          </Pressable>
        ) : (
          <Pressable
            style={[
              styles.action,
              styles.send,
              (!text.trim() || sending || startingSideQuestion || startingGoal) && styles.actionDisabled,
            ]}
            disabled={!text.trim() || sending || startingSideQuestion || startingGoal}
            onPress={() => void send()}
          >
            <Text style={styles.actionText}>
              {startingSideQuestion || startingGoal ? "Starting…" : "Send"}
            </Text>
          </Pressable>
        )}
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

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
            icon={
              effortIsBrain ? (
                <BrainIcon size={14} color={colors.textMuted} />
              ) : (
                <SlidersIcon size={14} color={colors.textMuted} />
              )
            }
            accessibilityLabel="Effort"
            label={variant ? variantLabel(variant) : ""}
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

      <WorkspaceModal
        visible={workspaceOpen}
        workspaces={workspaces}
        selectedID={workspaceID}
        onSelect={(id) => onSelectWorkspace?.(id)}
        onAdd={async (input) => {
          await onAddWorkspace?.(input)
        }}
        onRemove={(id, options) => {
          setWorkspaceOpen(false)
          onRemoveWorkspace?.(id, options)
        }}
        onClose={() => setWorkspaceOpen(false)}
      />
    </View>
  )
}

function Selector({
  label,
  onPress,
  disabled,
  icon,
  accessibilityLabel,
}: {
  label: string
  onPress: () => void
  disabled: boolean
  icon?: React.ReactNode
  accessibilityLabel?: string
}) {
  const styles = useThemedStyles(createStyles)
  return (
    <Pressable
      style={[styles.selector, disabled && styles.actionDisabled]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
    >
      {icon}
      {label ? (
        <Text style={styles.selectorText} numberOfLines={1}>
          {label}
        </Text>
      ) : null}
    </Pressable>
  )
}

function createStyles(colors: Palette, fonts: Fonts) {
  return StyleSheet.create({
    container: {
      gap: 8,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.hairline,
      backgroundColor: colors.surface,
      paddingHorizontal: 12,
      paddingTop: 8,
      paddingBottom: 16,
    },
    topBar: {
      flexDirection: "row",
      alignItems: "center",
    },
    workspaceTrigger: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      maxWidth: "100%",
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairlineStrong,
      backgroundColor: colors.surface,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    workspaceName: {
      flexShrink: 1,
      color: colors.textSoft,
      fontFamily: fonts.ui,
      fontSize: 12,
    },
    selectors: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
    },
    selector: {
      flexGrow: 1,
      flexBasis: "30%",
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairlineStrong,
      backgroundColor: colors.surface,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    selectorText: {
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 12,
    },
    autoAccept: {
      flexGrow: 0,
      flexBasis: "auto",
    },
    autoAcceptOn: {
      borderColor: colors.accentLine,
      backgroundColor: colors.accentSoft,
    },
    autoAcceptText: {
      color: colors.accent,
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
      borderColor: colors.hairlineStrong,
      backgroundColor: colors.surface,
      borderRadius: 12,
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 15,
      paddingHorizontal: 12,
      paddingTop: 12,
      paddingBottom: 12,
    },
    action: {
      height: 44,
      justifyContent: "center",
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: "transparent",
      paddingHorizontal: 18,
    },
    send: {
      backgroundColor: colors.accent,
      borderColor: colors.accent,
    },
    stop: {
      backgroundColor: colors.dangerSoft,
      borderColor: colors.dangerLine,
    },
    actionDisabled: {
      opacity: 0.5,
    },
    actionText: {
      color: colors.onAccent,
      fontFamily: fonts.ui,
      fontSize: 14,
      fontWeight: "500",
    },
    stopText: {
      color: colors.danger,
    },
    error: {
      color: colors.danger,
      fontFamily: fonts.ui,
      fontSize: 12,
    },
  })
}
