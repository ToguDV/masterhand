import { useMemo, useRef, useState } from "react"
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native"
import {
  ApiError,
  RequestTimeoutError,
  directoryName,
  flattenModels,
  useCreateScheduledTask,
  useDeleteScheduledTask,
  useModels,
  useRunScheduledTaskNow,
  useScheduledTaskRuns,
  useScheduledTasks,
  useUpdateScheduledTask,
  useWorkspaces,
  type Client,
  type ModelRef,
  type ScheduledRun,
  type ScheduledRunStatus,
  type ScheduledTask,
  type ScheduledTaskInput,
  type ScheduleSpec,
} from "@masterhand/client-core"
import { ChoiceModal } from "./ChoiceModal"
import { ChevronDownIcon, PauseIcon, PlayIcon, PlusIcon, TrashIcon } from "./icons"
import { ProviderGlyph } from "./ProviderGlyph"
import { useTheme, useThemedStyles, type Fonts, type Palette } from "../theme"

/**
 * Mobile scheduler task manager (issue #172): the same task list, create/edit
 * form, run-now/pause/resume/delete actions and lazy per-task run history as
 * the web `SchedulerPanel`, over the frozen `client-core` scheduler contract.
 * State lives server-side; `scheduler.updated` frames refetch through the
 * shared hooks, so this section never polls or retries a lost write itself.
 */

/* Schedule selector option values: interval minutes, cron presets and the two
   "custom" entries that swap the free-text editor underneath. */
const INTERVAL_PRESETS: Array<[string, string]> = [
  ["5", "Every 5 min"],
  ["15", "Every 15 min"],
  ["30", "Every 30 min"],
]
const CRON_PRESETS: Array<[string, string, string]> = [
  ["hourly", "Hourly", "0 * * * *"],
  ["daily", "Daily", "0 0 * * *"],
  ["weekly", "Weekly", "0 0 * * 1"],
]
const SCHEDULE_OPTIONS = [
  ...INTERVAL_PRESETS.map(([value, label]) => ({ value, label })),
  { value: "interval-custom", label: "Custom minutes…" },
  ...CRON_PRESETS.map(([token, label]) => ({ value: token, label })),
  { value: "cron-custom", label: "Custom cron…" },
]
const INTERVAL_PRESET_VALUES = new Set(INTERVAL_PRESETS.map(([value]) => value))
const CRON_PRESET_TEXT = new Map(CRON_PRESETS.map(([token, , cron]) => [token, cron]))
const CUSTOM_INTERVAL = "interval-custom"
const CUSTOM_CRON = "cron-custom"

/** Curated zones when the device ships no IANA database (Hermes may not). */
const CURATED_ZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Madrid",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Asia/Kolkata",
  "Australia/Sydney",
  "Pacific/Auckland",
  "America/Sao_Paulo",
  "Africa/Cairo",
]

/** Task status chip: severity lives in the text tint, like the rest of the app. */
function TaskStatusChip({ paused }: { paused: boolean }) {
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()
  return (
    <Text
      accessibilityLabel={paused ? "Task paused" : "Task active"}
      style={[styles.chip, { color: paused ? colors.warning : colors.success }]}
    >
      {paused ? "Paused" : "Active"}
    </Text>
  )
}

/**
 * Absolute timestamps for run history, formatted in the task's schedule
 * timezone so "next run" matches what the schedule fires against.
 */
function formatTimestamp(iso: string, timeZone?: string): string {
  const instant = new Date(iso)
  if (Number.isNaN(instant.getTime())) return "—"
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone || undefined,
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(instant)
}

/** The schedule as one short string ("Every 15 min" / "Cron 0 * * * *"). */
function scheduleText(schedule: ScheduleSpec): string {
  if (schedule.kind === "interval") return `Every ${schedule.intervalMinutes ?? 0} min`
  return `Cron ${schedule.cron ?? ""}`
}

/* Run status labels, consistent with the app's severity palette. */
const RUN_STATUS_LABEL: Record<ScheduledRunStatus, string> = {
  queued: "Queued",
  firing: "Firing",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  interrupted: "Interrupted",
  skipped: "Skipped",
}

/** Error code carried in an `ApiError` body (`{"error": "task_paused", …}`). */
function apiErrorCode(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null
  try {
    const body = JSON.parse(error.message) as { error?: unknown }
    return typeof body.error === "string" ? body.error : null
  } catch {
    return null
  }
}

/** Maps the BFF scheduler error codes to short, readable section copy. */
function schedulerErrorMessage(error: unknown): string {
  if (error instanceof RequestTimeoutError) {
    return "The server did not respond — check the run state before retrying."
  }
  if (error instanceof ApiError) {
    switch (apiErrorCode(error)) {
      case "task_paused":
        return "Paused tasks can't run."
      case "task_not_found":
        return "The task no longer exists — the list was refreshed."
      case "invalid_name":
        return "Give the task a name."
      case "invalid_prompt":
        return "Write the prompt to run."
      case "invalid_directory":
        return "Pick a workspace for the task."
      case "invalid_model":
        return "Pick an available model."
      case "invalid_schedule":
        return "Pick a schedule for the task."
      case "invalid_schedule_kind":
        return "Pick an interval or a cron schedule."
      case "invalid_interval":
        return "The interval must be at least 5 minutes."
      case "invalid_cron":
        return "Use a 5-field cron expression."
      case "invalid_frequency":
        return "The schedule fires more often than every 5 minutes."
      case "invalid_timezone":
        return "Pick a timezone the server knows."
      case "invalid_task":
        return "Check the task fields and try again."
      default:
        return `The change was rejected (HTTP ${error.status})`
    }
  }
  return "Could not reach the server."
}

/** `"providerID/id"` — the picker value a `ModelRef` maps to. */
function modelRefValue(model: ModelRef): string {
  return `${model.providerID}/${model.id}`
}

/** Inverse of `modelRefValue`: splits the picker value into a model ref. */
function modelRefOf(value: string, task: ScheduledTask | null): ModelRef | null {
  const split = value.indexOf("/")
  if (split <= 0 || split === value.length - 1) return null
  const providerID = value.slice(0, split)
  const id = value.slice(split + 1)
  if (!providerID || !id) return null
  // An edited task keeps a pinned variant unless the picker picks another model.
  if (task && task.model.variant && task.model.providerID === providerID && task.model.id === id) {
    return { providerID, id, variant: task.model.variant }
  }
  return { providerID, id }
}

/** Whole IANA timezone list for the picker ("Server default" sits in front). */
function timeZones(): string[] {
  try {
    return Intl.supportedValuesOf("timeZone")
  } catch {
    return CURATED_ZONES
  }
}

/** A custom interval value the section would submit without a volley. */
function validIntervalMinutes(text: string): number | null {
  const minutes = Number.parseInt(text, 10)
  return Number.isInteger(minutes) && minutes >= 5 ? minutes : null
}

/** Structural cron check (5 whitespace-separated fields); semantics stay on the server. */
function validCron(text: string): boolean {
  return /^\s*\S+(\s+\S+){4}\s*$/.test(text)
}

/**
 * Run history of one expanded task: status, source, times and the session
 * each fire created. Fetching is lazy — the hook only runs while a task card
 * is expanded — and refreshed by `scheduler.updated` frames itself.
 */
function RunHistory({
  client,
  task,
  onOpenSession,
}: {
  client: Client
  task: ScheduledTask
  onOpenSession: (sessionID: string) => void
}) {
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()
  const runsQuery = useScheduledTaskRuns(client, task.id)
  const runs = runsQuery.data ?? []

  if (runsQuery.isPending) {
    return <Text style={styles.muted}>Loading run history…</Text>
  }
  if (runsQuery.isError) {
    return <Text style={styles.error}>Could not load the run history.</Text>
  }
  if (runs.length === 0) {
    return <Text style={styles.muted}>No runs yet.</Text>
  }
  return (
    <View style={styles.historyList} accessibilityLabel={`Runs of ${task.name}`}>
      {runs.map((run: ScheduledRun) => (
        <View key={run.id} style={styles.runRow}>
          <View style={styles.runTop}>
            <Text
              style={[
                styles.chip,
                {
                  color:
                    run.status === "failed"
                      ? colors.danger
                      : run.status === "completed"
                        ? colors.success
                        : run.status === "running"
                          ? colors.accent
                          : run.status === "queued" || run.status === "firing"
                            ? colors.textMuted
                            : colors.warning,
                },
              ]}
            >
              {RUN_STATUS_LABEL[run.status]}
            </Text>
            <Text style={[styles.chip, { color: colors.textMuted }]}>
              {run.source === "manual" ? "Manual" : "Scheduled"}
            </Text>
          </View>
          <Text style={styles.muted} numberOfLines={2}>
            {formatTimestamp(run.startedAt, task.timezone)}
            {run.endedAt ? ` – ${formatTimestamp(run.endedAt, task.timezone)}` : ""}
          </Text>
          {run.status === "failed" && run.error ? (
            <Text style={styles.error}>{run.error}</Text>
          ) : null}
          {run.sessionID ? (
            <Pressable
              onPress={() => onOpenSession(run.sessionID!)}
              accessibilityRole="button"
              accessibilityLabel={`Open session of run ${run.id}`}
              style={styles.linkRow}
            >
              <Text style={styles.link}>Open session</Text>
            </Pressable>
          ) : null}
        </View>
      ))}
    </View>
  )
}

/** One task card: identity, schedule, run times and the action bar. */
function TaskCard({
  client,
  task,
  busy,
  historyOpen,
  onRunNow,
  onTogglePause,
  onToggleHistory,
  onEdit,
  onDelete,
  onOpenSession,
}: {
  client: Client
  task: ScheduledTask
  busy: boolean
  historyOpen: boolean
  onRunNow: () => void
  onTogglePause: () => void
  onToggleHistory: () => void
  onEdit: () => void
  onDelete: () => void
  onOpenSession: (sessionID: string) => void
}) {
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()
  const tz = task.timezone || "Server default"
  const lastLine = task.lastRunAt ? `Last ${formatTimestamp(task.lastRunAt, task.timezone)}` : "Never run"
  const runsLine = task.nextRunAt ? `${lastLine} · Next ${formatTimestamp(task.nextRunAt, task.timezone)}` : lastLine
  return (
    <View style={styles.card}>
      <View style={styles.cardTop}>
        <Text style={styles.cardTitle} numberOfLines={1}>
          {task.name}
        </Text>
        <TaskStatusChip paused={task.paused} />
      </View>

      <Text style={styles.mono} numberOfLines={1}>
        {`${scheduleText(task.schedule)} · ${tz}`}
      </Text>
      <Text style={styles.muted} numberOfLines={1}>
        {`${directoryName(task.directory)} · ${task.model.providerID}/${task.model.id}`}
      </Text>
      <Text style={styles.faint}>{runsLine}</Text>

      <View style={styles.actions}>
        {task.paused ? (
          <Pressable
            onPress={onTogglePause}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Resume"
            style={styles.action}
          >
            <PlayIcon size={14} color={colors.textMuted} />
            <Text style={styles.actionText}>Resume</Text>
          </Pressable>
        ) : (
          <>
            <Pressable
              onPress={onRunNow}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel="Run now"
              style={styles.action}
            >
              <PlayIcon size={14} color={colors.textMuted} />
              <Text style={styles.actionText}>Run now</Text>
            </Pressable>
            <Pressable
              onPress={onTogglePause}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel="Pause"
              style={styles.action}
            >
              <PauseIcon size={14} color={colors.textMuted} />
              <Text style={styles.actionText}>Pause</Text>
            </Pressable>
          </>
        )}
        <Pressable
          onPress={onEdit}
          accessibilityRole="button"
          accessibilityLabel="Edit"
          style={styles.action}
        >
          <Text style={styles.actionText}>Edit</Text>
        </Pressable>
        <Pressable
          onPress={onToggleHistory}
          accessibilityRole="button"
          accessibilityLabel="Run history"
          accessibilityState={{ expanded: historyOpen }}
          style={styles.action}
        >
          <ChevronDownIcon size={14} color={colors.textMuted} />
          <Text style={styles.actionText}>Run history</Text>
        </Pressable>
        <Pressable
          onPress={onDelete}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={`Delete ${task.name}`}
          style={styles.deleteAction}
        >
          <TrashIcon size={16} color={colors.danger} />
        </Pressable>
      </View>

      {historyOpen ? <RunHistory client={client} task={task} onOpenSession={onOpenSession} /> : null}
    </View>
  )
}

/** A picker trigger row that opens a `ChoiceModal` (searchable, ≥44px). */
function PickerTrigger({
  label,
  value,
  onPress,
}: {
  label: string
  value: string
  onPress: () => void
}) {
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()
  return (
    <>
      <Text style={styles.label}>{label}</Text>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityValue={{ text: value }}
        style={styles.select}
      >
        <Text style={styles.selectText} numberOfLines={1}>
          {value}
        </Text>
        <ChevronDownIcon size={14} color={colors.textMuted} />
      </Pressable>
    </>
  )
}

/**
 * Create/edit sheet, pre-filled from the task it edits. Validates locally
 * for friendlier messages (the server enforces the same rules) and submits
 * through the client-core mutations, guarded against double submits.
 */
function TaskSheet({ client, task, onClose }: { client: Client; task: ScheduledTask | null; onClose: () => void }) {
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()
  const modelsQuery = useModels(client)
  const workspacesQuery = useWorkspaces(client)
  const createMutation = useCreateScheduledTask(client)
  const updateMutation = useUpdateScheduledTask(client)

  const [name, setName] = useState(task?.name ?? "")
  const [prompt, setPrompt] = useState(task?.prompt ?? "")
  /** Selected schedule option: a preset value or one of the custom tokens. */
  const [scheduleValue, setScheduleValue] = useState(() => initialScheduleValue(task))
  /** Free text backing the custom entries: minutes or a cron expression. */
  const [customSchedule, setCustomSchedule] = useState(() => initialCustomSchedule(task))
  const [modelValue, setModelValue] = useState(task ? modelRefValue(task.model) : "")
  const [timezone, setTimezone] = useState(task?.timezone ?? "")
  const [directory, setDirectory] = useState(task?.directory ?? "")
  const [picker, setPicker] = useState<"model" | "workspace" | "schedule" | "timezone" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)

  const flatModels = flattenModels(modelsQuery.data?.models ?? [], modelsQuery.data?.providers ?? [])
  const modelLabel = flatModels.find((option) => option.value === modelValue)?.label ?? "Pick a model"

  const workspaceOptions = useMemo(() => {
    const options = (workspacesQuery.data ?? []).map((workspace) => ({
      value: workspace.path,
      label: workspace.name,
    }))
    // An edited task may target a raw folder outside the workspace roots.
    const current = directory.trim()
    if (current && !options.some((option) => option.value === current)) {
      options.unshift({ value: current, label: directoryName(current) })
    }
    return options
  }, [workspacesQuery.data, directory])
  const workspaceLabel =
    workspaceOptions.find((option) => option.value === directory)?.label ?? "Pick a workspace"

  const timezoneOptions = useMemo(() => {
    const zones = timeZones()
    const options = [{ value: "", label: "Server default" }, ...zones.map((zone) => ({ value: zone, label: zone }))]
    // An edited task may carry a zone the device list omits: keep showing it.
    if (timezone && !zones.includes(timezone)) {
      options.push({ value: timezone, label: timezone })
    }
    return options
  }, [timezone])
  const timezoneLabel = timezone || "Server default"

  const scheduleLabel = SCHEDULE_OPTIONS.find((option) => option.value === scheduleValue)?.label ?? "Pick a schedule"

  function pickSchedule(value: string) {
    setScheduleValue(value)
    // Seed the free-text editor with a usable starting point.
    if (value === CUSTOM_INTERVAL && !validIntervalMinutes(customSchedule)) setCustomSchedule("30")
    if (value === CUSTOM_CRON && !validCron(customSchedule)) setCustomSchedule("0 9 * * *")
  }

  /** Local schedule validation: returns null and sets the error otherwise. */
  function buildSchedule(): ScheduleSpec | null {
    if (INTERVAL_PRESET_VALUES.has(scheduleValue)) {
      return { kind: "interval", intervalMinutes: Number(scheduleValue) }
    }
    if (scheduleValue === CUSTOM_INTERVAL) {
      const minutes = validIntervalMinutes(customSchedule)
      if (minutes === null) {
        setError("The interval must be a whole number of at least 5 minutes.")
        return null
      }
      return { kind: "interval", intervalMinutes: minutes }
    }
    const presetCron = CRON_PRESET_TEXT.get(scheduleValue)
    if (presetCron) return { kind: "cron", cron: presetCron }
    const cron = customSchedule.trim()
    if (!validCron(cron)) {
      setError("Use a 5-field cron expression, e.g. 0 9 * * 1.")
      return null
    }
    return { kind: "cron", cron }
  }

  /** Upholds the same field rules the server enforces, with shorter messages. */
  function validate(): ScheduledTaskInput | null {
    const trimmedName = name.trim()
    if (!trimmedName) {
      setError("Give the task a name.")
      return null
    }
    const trimmedPrompt = prompt.trim()
    if (!trimmedPrompt) {
      setError("Write the prompt to run.")
      return null
    }
    const model = modelRefOf(modelValue, task)
    if (!model) {
      setError("Pick a model.")
      return null
    }
    const trimmedDirectory = directory.trim()
    if (!trimmedDirectory) {
      setError("Pick a workspace for the task.")
      return null
    }
    const schedule = buildSchedule()
    if (!schedule) return null
    return {
      name: trimmedName,
      prompt: trimmedPrompt,
      model,
      schedule,
      timezone: timezone || undefined,
      directory: trimmedDirectory,
    }
  }

  async function submit() {
    if (savingRef.current) return
    const input = validate()
    if (!input) return
    savingRef.current = true
    setSaving(true)
    setError(null)
    try {
      if (task) {
        // Full-field patch (never `paused`): the write stays idempotent.
        await updateMutation.mutateAsync({
          id: task.id,
          patch: {
            name: input.name,
            prompt: input.prompt,
            model: input.model,
            schedule: input.schedule,
            timezone: input.timezone,
            directory: input.directory,
          },
        })
      } else {
        await createMutation.mutateAsync(input)
      }
      onClose()
    } catch (mutationError) {
      setError(schedulerErrorMessage(mutationError))
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const customMode = scheduleValue === CUSTOM_INTERVAL ? "minutes" : scheduleValue === CUSTOM_CRON ? "cron" : null
  const modelOption = flatModels.find((option) => option.value === modelValue)

  // The pickers are sibling modals, never nested inside the sheet modal:
  // nested modals dismiss and stack unpredictably on device.
  return (
    <>
      <Modal visible animationType="slide" transparent onRequestClose={onClose}>
        <View style={styles.backdrop}>
          <View style={styles.sheet}>
            <ScrollView contentContainerStyle={styles.sheetContent} keyboardShouldPersistTaps="handled">
            <Text style={styles.sheetTitle}>{task ? "Edit task" : "New task"}</Text>
            <Text style={styles.muted}>Fires the prompt into a fresh session in the workspace on its schedule.</Text>

            <Text style={styles.label}>Name</Text>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="Nightly sweep"
              placeholderTextColor={colors.textFaint}
              accessibilityLabel="Task name"
              style={styles.input}
            />

            <Text style={styles.label}>Prompt</Text>
            <TextInput
              value={prompt}
              onChangeText={setPrompt}
              placeholder="Inspect the failing checks and summarize them"
              placeholderTextColor={colors.textFaint}
              multiline
              numberOfLines={3}
              accessibilityLabel="Task prompt"
              style={[styles.input, styles.multiline]}
            />

            <Text style={styles.label}>Model</Text>
            <Pressable
              onPress={() => setPicker("model")}
              accessibilityRole="button"
              accessibilityLabel="Model"
              accessibilityValue={{ text: modelLabel }}
              style={styles.select}
            >
              {modelOption ? (
                <ProviderGlyph providerID={modelOption.providerID} name={modelOption.provider} />
              ) : null}
              <Text style={[styles.selectText, !modelValue && styles.placeholder]} numberOfLines={1}>
                {modelLabel}
              </Text>
              <ChevronDownIcon size={14} color={colors.textMuted} />
            </Pressable>

            <PickerTrigger label="Workspace" value={workspaceLabel} onPress={() => setPicker("workspace")} />
            <PickerTrigger label="Schedule" value={scheduleLabel} onPress={() => setPicker("schedule")} />
            {customMode ? (
              <TextInput
                value={customSchedule}
                onChangeText={setCustomSchedule}
                placeholder={customMode === "minutes" ? "Minutes (≥ 5)" : "0 9 * * 1"}
                placeholderTextColor={colors.textFaint}
                keyboardType={customMode === "minutes" ? "numeric" : "default"}
                accessibilityLabel={
                  customMode === "minutes" ? "Custom interval in minutes" : "Custom cron expression"
                }
                style={styles.input}
              />
            ) : null}
            <PickerTrigger label="Timezone" value={timezoneLabel} onPress={() => setPicker("timezone")} />

            {error ? <Text style={styles.error}>{error}</Text> : null}

            <View style={styles.sheetActions}>
              <Pressable
                onPress={onClose}
                disabled={saving}
                accessibilityRole="button"
                accessibilityLabel="Cancel"
                style={styles.secondary}
              >
                <Text style={styles.secondaryText}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={() => void submit()}
                disabled={saving}
                accessibilityRole="button"
                accessibilityLabel={task ? "Save changes" : "Create task"}
                style={styles.primary}
              >
                <Text style={styles.primaryText}>{saving ? "Saving…" : task ? "Save changes" : "Create task"}</Text>
              </Pressable>
            </View>
          </ScrollView>
          </View>
        </View>
      </Modal>

      <ChoiceModal
        visible={picker === "model"}
        title="Pick a model"
        options={flatModels.map((option) => ({ value: option.value, label: option.label }))}
        selected={modelValue}
        onSelect={setModelValue}
        onClose={() => setPicker(null)}
      />
      <ChoiceModal
        visible={picker === "workspace"}
        title="Pick a workspace"
        options={workspaceOptions}
        selected={directory}
        onSelect={setDirectory}
        onClose={() => setPicker(null)}
      />
      <ChoiceModal
        visible={picker === "schedule"}
        title="Pick a schedule"
        options={SCHEDULE_OPTIONS}
        selected={scheduleValue}
        onSelect={pickSchedule}
        onClose={() => setPicker(null)}
      />
      <ChoiceModal
        visible={picker === "timezone"}
        title="Pick a timezone"
        options={timezoneOptions}
        selected={timezone}
        onSelect={setTimezone}
        onClose={() => setPicker(null)}
      />
    </>
  )
}

/** Seed the schedule picker from the edited task (or the 15-min default). */
function initialScheduleValue(task: ScheduledTask | null): string {
  if (!task) return "15"
  const schedule = task.schedule
  if (schedule.kind === "interval") {
    const minutes = schedule.intervalMinutes
    return minutes !== undefined && INTERVAL_PRESET_VALUES.has(String(minutes)) ? String(minutes) : CUSTOM_INTERVAL
  }
  for (const [token, , cron] of CRON_PRESETS) {
    if (schedule.cron === cron) return token
  }
  return CUSTOM_CRON
}

/** Seed the custom editor with the edited task's own value. */
function initialCustomSchedule(task: ScheduledTask | null): string {
  if (!task) return ""
  const schedule = task.schedule
  if (schedule.kind === "interval") return String(schedule.intervalMinutes ?? 5)
  return schedule.cron ?? ""
}

/** Destructive confirm for deleting a task (cascades its run history). */
function DeleteTaskSheet({
  task,
  busy,
  onConfirm,
  onClose,
}: {
  task: ScheduledTask
  busy: boolean
  onConfirm: () => Promise<void>
  onClose: () => void
}) {
  const styles = useThemedStyles(createStyles)
  const [error, setError] = useState<string | null>(null)
  /** Guard so a double tap cannot submit the delete twice. */
  const confirmingRef = useRef(false)

  async function confirm(): Promise<void> {
    if (busy || confirmingRef.current) return
    confirmingRef.current = true
    setError(null)
    try {
      await onConfirm()
      onClose()
    } catch (confirmError) {
      setError(schedulerErrorMessage(confirmError))
      confirmingRef.current = false
    }
  }

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <Text style={styles.sheetTitle}>Delete task</Text>
          <Text style={styles.muted}>
            Delete <Text style={styles.strong}>{task.name}</Text>? Its run history is removed with it. The sessions it
            created stay. This cannot be undone.
          </Text>

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <View style={styles.sheetActions}>
            <Pressable
              onPress={onClose}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel="Cancel"
              style={styles.secondary}
            >
              <Text style={styles.secondaryText}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={() => void confirm()}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel="Delete"
              style={styles.danger}
            >
              <Text style={styles.dangerText}>{busy ? "Deleting…" : "Delete"}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  )
}

/**
 * The scheduler section: header, task cards, run history and sheets. Its only
 * app dependency is `onOpenSession`, called when a run's session is opened.
 */
export function SchedulerSection({
  client,
  onOpenSession,
}: {
  client: Client
  onOpenSession: (sessionID: string) => void
}) {
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()
  const tasksQuery = useScheduledTasks(client)
  const runNowMutation = useRunScheduledTaskNow(client)
  const updateMutation = useUpdateScheduledTask(client)
  const deleteMutation = useDeleteScheduledTask(client)
  const [historyTaskID, setHistoryTaskID] = useState<string | null>(null)
  /** "new" opens the create sheet; a task opens it pre-filled for editing. */
  const [sheet, setSheet] = useState<ScheduledTask | null | "new">(null)
  const [deleteTarget, setDeleteTarget] = useState<ScheduledTask | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  // Lazy run history: fetched only while one task is expanded; the hook
  // refetches itself on `scheduler.updated` frames — no polling or loops here.
  useScheduledTaskRuns(client, historyTaskID, Boolean(historyTaskID))

  const tasks = tasksQuery.data ?? []
  // Per-task busy targets: only the card whose mutation is in flight goes busy.
  const runBusyTaskID =
    runNowMutation.isPending && typeof runNowMutation.variables === "string" ? runNowMutation.variables : null
  const patchBusyTaskID = updateMutation.isPending ? updateMutation.variables?.id ?? null : null

  function runTaskNow(task: ScheduledTask) {
    // Run-now fires a real opencode turn: never re-fire while one is in flight.
    if (runNowMutation.isPending) return
    setActionError(null)
    runNowMutation.mutate(task.id, { onError: (error) => setActionError(schedulerErrorMessage(error)) })
  }

  function togglePause(task: ScheduledTask) {
    if (updateMutation.isPending) return
    setActionError(null)
    updateMutation.mutate(
      { id: task.id, patch: { paused: !task.paused } },
      { onError: (error) => setActionError(schedulerErrorMessage(error)) },
    )
  }

  /** Deleting cascades the run history; failures stay in the sheet. */
  async function confirmDelete(): Promise<void> {
    const target = deleteTarget
    if (!target || deleteMutation.isPending) return
    setActionError(null)
    // Throws on failure: the sheet catches it and stays open with the reason.
    await deleteMutation.mutateAsync(target.id)
    setDeleteTarget(null)
  }

  return (
    <View style={styles.section}>
      <View style={styles.header}>
        <Text style={styles.title}>Scheduler</Text>
        <Pressable
          onPress={() => {
            setActionError(null)
            setSheet("new")
          }}
          accessibilityRole="button"
          accessibilityLabel="New task"
          style={styles.newTask}
        >
          <PlusIcon size={16} color={colors.onAccent} />
          <Text style={styles.newTaskText}>New task</Text>
        </Pressable>
      </View>

      {tasksQuery.isPending ? <Text style={styles.muted}>Loading tasks…</Text> : null}
      {tasksQuery.isError ? (
        <View style={styles.centerBox}>
          <Text style={styles.muted}>Could not load the scheduler.</Text>
          <Pressable
            onPress={() => void tasksQuery.refetch()}
            accessibilityRole="button"
            accessibilityLabel="Retry"
            style={styles.secondary}
          >
            <Text style={styles.secondaryText}>Retry</Text>
          </Pressable>
        </View>
      ) : null}
      {!tasksQuery.isPending && !tasksQuery.isError && tasks.length === 0 ? (
        <View style={styles.centerBox}>
          <Text style={styles.muted}>No scheduled tasks yet — create one to fire a prompt on a schedule.</Text>
        </View>
      ) : null}
      {tasks.map((task) => (
        <TaskCard
          key={task.id}
          client={client}
          task={task}
          busy={runBusyTaskID === task.id || patchBusyTaskID === task.id}
          historyOpen={historyTaskID === task.id}
          onRunNow={() => runTaskNow(task)}
          onTogglePause={() => togglePause(task)}
          onToggleHistory={() => setHistoryTaskID(historyTaskID === task.id ? null : task.id)}
          onEdit={() => {
            setActionError(null)
            setSheet(task)
          }}
          onDelete={() => {
            setActionError(null)
            setDeleteTarget(task)
          }}
          onOpenSession={onOpenSession}
        />
      ))}
      {actionError ? <Text style={styles.error}>{actionError}</Text> : null}

      {sheet ? <TaskSheet client={client} task={sheet === "new" ? null : sheet} onClose={() => setSheet(null)} /> : null}
      {deleteTarget ? (
        <DeleteTaskSheet
          task={deleteTarget}
          busy={deleteMutation.isPending}
          onConfirm={confirmDelete}
          onClose={() => setDeleteTarget(null)}
        />
      ) : null}
    </View>
  )
}

function createStyles(colors: Palette, fonts: Fonts) {
  return StyleSheet.create({
    section: {
      gap: 8,
      paddingHorizontal: 12,
      paddingTop: 10,
      paddingBottom: 24,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingVertical: 4,
    },
    title: {
      flex: 1,
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 16,
      fontWeight: "600",
    },
    newTask: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      minHeight: 44,
      backgroundColor: colors.accent,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    newTaskText: {
      color: colors.onAccent,
      fontFamily: fonts.ui,
      fontSize: 14,
      fontWeight: "500",
    },
    centerBox: {
      alignItems: "center",
      gap: 8,
      paddingVertical: 32,
      paddingHorizontal: 24,
    },
    card: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      borderRadius: 12,
      backgroundColor: colors.surface,
      padding: 12,
      gap: 4,
    },
    cardTop: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    cardTitle: {
      flex: 1,
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 15,
      fontWeight: "600",
    },
    chip: {
      fontFamily: fonts.ui,
      fontSize: 12,
      fontWeight: "600",
    },
    mono: {
      color: colors.textMuted,
      fontFamily: fonts.mono,
      fontSize: 12,
    },
    muted: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 13,
    },
    faint: {
      color: colors.textFaint,
      fontFamily: fonts.ui,
      fontSize: 12,
    },
    strong: {
      color: colors.text,
      fontWeight: "600",
    },
    error: {
      color: colors.danger,
      fontFamily: fonts.ui,
      fontSize: 12,
    },
    actions: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      gap: 4,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.hairline,
      marginTop: 6,
      paddingTop: 8,
    },
    action: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      minHeight: 44,
      paddingHorizontal: 10,
      justifyContent: "center",
    },
    actionText: {
      color: colors.textSoft,
      fontFamily: fonts.ui,
      fontSize: 13,
    },
    deleteAction: {
      alignItems: "center",
      justifyContent: "center",
      minHeight: 44,
      minWidth: 44,
      marginLeft: "auto",
    },
    historyList: {
      gap: 8,
      paddingTop: 8,
    },
    runRow: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      borderRadius: 12,
      backgroundColor: colors.surface,
      padding: 10,
      gap: 4,
    },
    runTop: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    linkRow: {
      alignSelf: "flex-start",
      minHeight: 44,
      justifyContent: "center",
    },
    link: {
      color: colors.accent,
      fontFamily: fonts.ui,
      fontSize: 13,
      textDecorationLine: "underline",
    },
    label: {
      marginTop: 12,
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 12,
    },
    input: {
      minHeight: 44,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairlineStrong,
      backgroundColor: colors.surface,
      borderRadius: 12,
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 14,
      paddingHorizontal: 12,
      paddingVertical: 10,
      marginTop: 6,
    },
    multiline: {
      minHeight: 88,
      textAlignVertical: "top",
    },
    select: {
      minHeight: 44,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairlineStrong,
      backgroundColor: colors.surface,
      borderRadius: 12,
      paddingHorizontal: 12,
      marginTop: 6,
    },
    selectText: {
      flex: 1,
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 14,
    },
    placeholder: {
      color: colors.textMuted,
    },
    backdrop: {
      flex: 1,
      justifyContent: "flex-end",
      backgroundColor: colors.overlay,
    },
    sheet: {
      maxHeight: "85%",
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      backgroundColor: colors.surface,
      paddingBottom: 24,
    },
    sheetContent: {
      padding: 16,
      gap: 2,
    },
    sheetTitle: {
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 16,
      fontWeight: "600",
    },
    sheetActions: {
      flexDirection: "row",
      justifyContent: "flex-end",
      gap: 8,
      marginTop: 16,
    },
    primary: {
      minHeight: 44,
      justifyContent: "center",
      backgroundColor: colors.accent,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    primaryText: {
      color: colors.onAccent,
      fontFamily: fonts.ui,
      fontSize: 14,
      fontWeight: "500",
    },
    secondary: {
      minHeight: 44,
      justifyContent: "center",
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairlineStrong,
      backgroundColor: colors.surface,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    secondaryText: {
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 14,
      fontWeight: "500",
    },
    danger: {
      minHeight: 44,
      justifyContent: "center",
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.dangerLine,
      backgroundColor: colors.dangerSoft,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    dangerText: {
      color: colors.danger,
      fontFamily: fonts.ui,
      fontSize: 14,
      fontWeight: "500",
    },
  })
}
