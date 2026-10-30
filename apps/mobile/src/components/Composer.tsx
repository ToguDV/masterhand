import { useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from "react"
import { Image, Pressable, StyleSheet, Text, TextInput, View } from "react-native"
import * as DocumentPicker from "expo-document-picker"
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
  type Client,
  type ComposerPopover,
  type PendingSendController,
  type UploadedAttachment,
} from "@masterhand/client-core"
import { ChoiceModal, type ChoiceOption } from "./ChoiceModal"
import { ComposerSuggestions } from "./ComposerSuggestions"
import { ProviderGlyph } from "./ProviderGlyph"
import { SideQuestionPanel } from "./SideQuestionPanel"
import { BrainIcon, ChevronDownIcon, CloseIcon, FileIcon, PaperclipIcon, SlidersIcon } from "./icons"
import { loadSessionPreferences, saveSessionPreferences } from "../storage"
import { useTheme, useThemedStyles, type Fonts, type Palette } from "../theme"

type OpenPicker = "agent" | "model" | "effort" | null

/** A file picked on the device, before/while it is uploaded on Send. */
interface ComposerAttachment {
  id: string
  /** Local file URI from the document picker. */
  uri: string
  name: string
  mime: string
  size: number
  status: "ready" | "uploading" | "error"
  error?: string
  uploaded?: UploadedAttachment
}

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
  header,
  isolationBar,
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
  /** Composer context bar (workspace menu, branch, stats). Rendered as the dock head. */
  header?: ReactNode
  /** Isolated-worktree strip. Rendered inside the dock for isolated sessions. */
  isolationBar?: ReactNode
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
  const inFlight = useRef<{ text: string; marker: string; attachmentIDs: string[] } | null>(null)
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const attachmentsRef = useRef(attachments)
  attachmentsRef.current = attachments
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

  /** Adds picked files, enforcing the same limits as the web composer. */
  function addAssets(assets: ReadonlyArray<{ uri: string; name: string; mimeType?: string | null; size?: number }>): void {
    const next = [...attachmentsRef.current]
    let total = next.reduce((sum, item) => sum + item.size, 0)
    let message: string | null = null
    for (const asset of assets) {
      if (next.length >= ATTACHMENT_MAX_COUNT) {
        message = `You can attach up to ${ATTACHMENT_MAX_COUNT} files per message.`
        break
      }
      const size = typeof asset.size === "number" && Number.isFinite(asset.size) ? Math.max(0, asset.size) : 0
      if (size > ATTACHMENT_MAX_BYTES) {
        message = `${asset.name || "This file"} is larger than ${formatFileSize(ATTACHMENT_MAX_BYTES)}.`
        continue
      }
      if (total + size > ATTACHMENT_MAX_TOTAL_BYTES) {
        message = `Attachments are limited to ${formatFileSize(ATTACHMENT_MAX_TOTAL_BYTES)} per message.`
        continue
      }
      const name = asset.name || "file"
      if (next.some((item) => item.uri === asset.uri && item.name === name)) continue
      next.push({
        id: createAttachmentID(),
        uri: asset.uri,
        name,
        mime: asset.mimeType || mimeFromName(name),
        size,
        status: "ready",
      })
      total += size
    }
    setAttachments(next)
    setError(message)
  }

  async function pickFiles(): Promise<void> {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: "*/*",
        multiple: true,
        copyToCacheDirectory: true,
      })
      if (result.canceled) return
      addAssets(result.assets)
    } catch {
      setError("Could not open the file picker.")
    }
  }

  function removeAttachment(id: string): void {
    setAttachments((current) => current.filter((entry) => entry.id !== id))
  }

  function removeAttachmentsByID(ids: readonly string[]): void {
    if (ids.length === 0) return
    const sent = new Set(ids)
    setAttachments((current) => current.filter((entry) => !sent.has(entry.id)))
  }

  /** Uploads staged files two at a time (same contract as the web composer). */
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
            uri: item.uri,
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
      setForcedSelection(undefined)
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
    // v1: only plain prompts get the ghost; `deliver` begins it after uploads.
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
    void deliver(current.text, marker, null, current.attachments)
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
    const staged = attachmentsRef.current
    let created: string | null = null
    try {
      let uploaded: ReadonlyArray<UploadedAttachment> = staged
        .map((item) => item.uploaded)
        .filter(Boolean) as UploadedAttachment[]
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
        setForcedSelection(undefined)
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

  const agentChoices: ChoiceOption[] = agents.map((item) => ({ value: item.id, label: item.name }))
  const modelChoices: ChoiceOption[] = modelOptions.map((option) => ({ value: option.value, label: option.label }))
  const selectedModel = modelOptions.find((option) => option.value === model)
  const effortChoices: ChoiceOption[] = variants.map((key) => ({ value: key, label: variantLabel(key) }))
  // Effort variants get the brain glyph; provider-specific ones the sliders.
  const effortIsBrain = variants.length > 0 && variants.every((key) => isEffortVariant(key))

  return (
    <View style={styles.dockWrap}>
      <View style={styles.dock} testID="composer-dock">
        {header ? <View style={styles.dockHead}>{header}</View> : null}
        {isolationBar ? <View style={styles.dockStrip}>{isolationBar}</View> : null}

        <View style={styles.dockBody}>
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

          {attachments.length > 0 && (
            <View style={styles.attachmentStrip} testID="composer-attachments">
              {attachments.map((item) => (
                <View
                  key={item.id}
                  style={[styles.attachment, item.status === "error" && styles.attachmentError]}
                >
                  {item.mime.startsWith("image/") ? (
                    <Image source={{ uri: item.uri }} style={styles.attachmentThumb} />
                  ) : (
                    <View style={styles.attachmentGlyph}>
                      <FileIcon size={16} color={colors.textMuted} />
                    </View>
                  )}
                  <View style={styles.attachmentText}>
                    <Text style={styles.attachmentName} numberOfLines={1}>
                      {item.name}
                    </Text>
                    <Text style={styles.attachmentMeta} numberOfLines={1}>
                      {item.status === "uploading" ? "Uploading…" : item.error ?? formatFileSize(item.size)}
                    </Text>
                  </View>
                  <Pressable
                    style={styles.attachmentRemove}
                    onPress={() => removeAttachment(item.id)}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${item.name}`}
                    hitSlop={6}
                  >
                    <CloseIcon size={13} color={colors.textMuted} />
                  </Pressable>
                </View>
              ))}
            </View>
          )}

          <TextInput
            style={styles.field}
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
        </View>

        <View style={styles.dockToolbar}>
          <Pressable
            style={styles.attach}
            onPress={() => void pickFiles()}
            accessibilityRole="button"
            accessibilityLabel="Attach files"
            testID="composer-attach"
          >
            <PaperclipIcon size={18} color={colors.textMuted} />
          </Pressable>
          <Selector
            label={agents.find((item) => item.id === agent)?.name ?? "agent…"}
            onPress={() => setPicker("agent")}
            disabled={agentChoices.length === 0}
          />
          <Selector
            icon={
              selectedModel ? (
                <ProviderGlyph providerID={selectedModel.providerID} name={selectedModel.provider} />
              ) : undefined
            }
            accessibilityLabel={selectedModel ? `Model, ${selectedModel.label}` : "Model"}
            label={selectedModel?.model ?? "model…"}
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
              label={variant ? variantLabel(variant) : "Default"}
              onPress={() => setPicker("effort")}
              disabled={false}
            />
          )}
          <Pressable
            style={[styles.autoAccept, autoAccept && styles.autoAcceptOn]}
            onPress={() => onToggleAutoAccept(!autoAccept)}
            accessibilityRole="switch"
            accessibilityState={{ checked: autoAccept }}
            accessibilityLabel="Auto-accept permission requests for this session"
          >
            <Text style={[styles.autoAcceptText, autoAccept && styles.autoAcceptTextOn]} numberOfLines={1}>
              {autoAccept ? "auto-accept: on" : "auto-accept"}
            </Text>
          </Pressable>
          {busy ? (
            <Pressable style={[styles.send, styles.stop]} onPress={() => void stop()}>
              <Text style={[styles.sendText, styles.stopText]}>Stop</Text>
            </Pressable>
          ) : (
            <Pressable
              style={[
                styles.send,
                ((!text.trim() && attachments.length === 0) || sending || startingSideQuestion || startingGoal) &&
                  styles.actionDisabled,
              ]}
              disabled={(!text.trim() && attachments.length === 0) || sending || startingSideQuestion || startingGoal}
              onPress={() => void send()}
            >
              <Text style={styles.sendText}>{startingSideQuestion || startingGoal ? "Starting…" : "Send"}</Text>
            </Pressable>
          )}
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}
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
  const { colors } = useTheme()
  return (
    <Pressable
      style={[styles.selector, disabled && styles.actionDisabled]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
    >
      {icon}
      <Text style={styles.selectorText} numberOfLines={1}>
        {label}
      </Text>
      <ChevronDownIcon size={12} color={colors.textFaint} />
    </Pressable>
  )
}

function createStyles(colors: Palette, fonts: Fonts) {
  return StyleSheet.create({
    dockWrap: {
      paddingHorizontal: 12,
      paddingTop: 8,
      paddingBottom: 16,
    },
    dock: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      borderRadius: 16,
      backgroundColor: colors.surface,
    },
    dockHead: {
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.hairline,
    },
    dockStrip: {
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.hairline,
    },
    dockBody: {
      gap: 8,
      paddingHorizontal: 12,
      paddingTop: 8,
    },
    attach: {
      width: 30,
      height: 30,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 8,
    },
    attachmentStrip: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 6,
      paddingBottom: 4,
    },
    attachment: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      maxWidth: "100%",
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      borderRadius: 10,
      padding: 4,
      backgroundColor: colors.surfaceMuted,
    },
    attachmentError: {
      borderColor: colors.dangerLine,
      backgroundColor: colors.dangerSoft,
    },
    attachmentThumb: {
      width: 36,
      height: 36,
      borderRadius: 8,
      backgroundColor: colors.surface,
    },
    attachmentGlyph: {
      width: 36,
      height: 36,
      borderRadius: 8,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.surface,
    },
    attachmentText: {
      flexShrink: 1,
      minWidth: 0,
      maxWidth: 220,
    },
    attachmentName: {
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 12,
      fontWeight: "500",
    },
    attachmentMeta: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 11,
    },
    attachmentRemove: {
      width: 26,
      height: 26,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 13,
    },
    field: {
      minHeight: 44,
      maxHeight: 140,
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 15,
      lineHeight: 22,
      paddingVertical: 4,
    },
    dockToolbar: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: 8,
      paddingTop: 4,
      paddingBottom: 8,
    },
    selector: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      maxWidth: "100%",
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    selectorText: {
      flexShrink: 1,
      color: colors.textSoft,
      fontFamily: fonts.ui,
      fontSize: 12,
    },
    autoAccept: {
      flexDirection: "row",
      alignItems: "center",
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairlineStrong,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    autoAcceptOn: {
      borderColor: colors.accentLine,
      backgroundColor: colors.accentSoft,
    },
    autoAcceptText: {
      color: colors.textSoft,
      fontFamily: fonts.ui,
      fontSize: 12,
    },
    autoAcceptTextOn: {
      color: colors.accent,
    },
    send: {
      marginLeft: "auto",
      justifyContent: "center",
      backgroundColor: colors.accent,
      borderRadius: 12,
      paddingHorizontal: 16,
      paddingVertical: 8,
    },
    stop: {
      backgroundColor: colors.dangerSoft,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.dangerLine,
    },
    actionDisabled: {
      opacity: 0.5,
    },
    sendText: {
      color: colors.onAccent,
      fontFamily: fonts.ui,
      fontSize: 13,
      fontWeight: "500",
    },
    stopText: {
      color: colors.danger,
    },
    error: {
      color: colors.danger,
      fontFamily: fonts.ui,
      fontSize: 12,
      paddingHorizontal: 12,
      paddingBottom: 10,
    },
  })
}
