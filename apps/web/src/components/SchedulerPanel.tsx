import { useMemo, useRef, useState } from "react"
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
  type ModelRef,
  type ScheduledRun,
  type ScheduledRunStatus,
  type ScheduledTask,
  type ScheduledTaskInput,
  type ScheduleSpec,
} from "@masterhand/client-core"
import { client } from "../client"
import { ProviderGlyph } from "./ProviderGlyph"
import { SearchSelect, type SearchSelectOption } from "./SearchSelect"
import { useModalFocus } from "./useModalFocus"
import { ChevronDownIcon, ClockIcon, PauseIcon, PlayIcon, TrashIcon } from "./icons"

/**
 * Sidebar "Scheduler" section (issue #147): scheduled prompts the BFF fires
 * into new opencode sessions on an interval or cron schedule. The task list
 * is the server's source of truth, refetched through client-core on
 * `scheduler.updated` frames; the panel only edits it through the mutations,
 * which invalidate on success and never retry a lost write on their own.
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
const SCHEDULE_OPTIONS: SearchSelectOption[] = [
  ...INTERVAL_PRESETS.map(([value, label]) => ({ value, label })),
  { value: "interval-custom", label: "Custom minutes…" },
  ...CRON_PRESETS.map(([token, label]) => ({ value: token, label })),
  { value: "cron-custom", label: "Custom cron…" },
]
const INTERVAL_PRESET_VALUES = new Set(INTERVAL_PRESETS.map(([value]) => value))
const CRON_PRESET_TEXT = new Map(CRON_PRESETS.map(([token, , cron]) => [token, cron]))
const CUSTOM_INTERVAL = "interval-custom"
const CUSTOM_CRON = "cron-custom"

/** Task status chip: severity lives in the text tint, like the rest of the app. */
function TaskStatusChip({ paused }: { paused: boolean }) {
  return (
    <span
      className={`mh-chip shrink-0 ${paused ? "text-warning" : "text-success"}`}
      aria-label={paused ? "Task paused" : "Task active"}
    >
      {paused ? "Paused" : "Active"}
    </span>
  )
}

/**
 * Absolute timestamps for run history, formatted in the task's schedule
 * timezone so "next run" matches what the schedule fires against. Relative
 * words would hide when a schedule actually fires, so this panel formats
 * absolute dates instead of reusing the chat-only `formatRelative` helper.
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

/* Run status labels and tints, consistent with the app's severity palette. */
const RUN_STATUS_LABEL: Record<ScheduledRunStatus, string> = {
  queued: "Queued",
  firing: "Firing",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  interrupted: "Interrupted",
  skipped: "Skipped",
}
const RUN_STATUS_CLASS: Record<ScheduledRunStatus, string> = {
  queued: "text-ink-muted",
  firing: "text-ink-muted",
  running: "text-accent",
  completed: "text-success",
  failed: "text-danger",
  interrupted: "text-warning",
  skipped: "text-warning",
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

/** Maps the BFF scheduler error codes to short, readable panel copy. */
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

/** `"providerID/id"` — the SearchSelect value a `ModelRef` maps to. */
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
    return []
  }
}

/** A custom interval value the panel would submit without a volley. */
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
 * each fire created. Fetching is lazy — the hook only runs while a task row
 * is expanded — and refreshed by `scheduler.updated` frames itself.
 */
function RunHistory({
  task,
  onOpenSession,
}: {
  task: ScheduledTask
  onOpenSession: (sessionID: string) => void
}) {
  const runsQuery = useScheduledTaskRuns(client, task.id)
  const runs = runsQuery.data ?? []

  if (runsQuery.isPending) {
    return <p className="px-1 pb-3 pt-1 text-xs text-ink-muted">Loading run history…</p>
  }
  if (runsQuery.isError) {
    return <p className="px-1 pb-3 pt-1 text-xs text-danger">Could not load the run history.</p>
  }
  return (
    <ul className="flex flex-col gap-2 px-1 pb-3 pt-1" aria-label={`Runs of ${task.name}`}>
      {runs.length === 0 && <li className="px-2 py-2 text-xs text-ink-muted">No runs yet.</li>}
      {runs.map((run) => (
        <li key={run.id} className="rounded-md border border-hairline bg-surface px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`mh-chip ${RUN_STATUS_CLASS[run.status]}`}>{RUN_STATUS_LABEL[run.status]}</span>
            <span className="mh-chip text-ink-muted">{run.source === "manual" ? "Manual" : "Scheduled"}</span>
            <span className="min-w-0 truncate text-xs text-ink-muted">
              {formatTimestamp(run.startedAt, task.timezone)}
              {run.endedAt ? ` – ${formatTimestamp(run.endedAt, task.timezone)}` : ""}
            </span>
            {run.status === "failed" && run.error && (
              <span className="min-w-0 break-words text-xs text-danger">{run.error}</span>
            )}
            {run.sessionID && (
              <button
                type="button"
                onClick={() => onOpenSession(run.sessionID!)}
                className="ml-auto shrink-0 text-xs text-accent underline underline-offset-2"
              >
                Open session
              </button>
            )}
          </div>
        </li>
      ))}
    </ul>
  )
}

/** One task card: identity, schedule, run times and the action bar. */
function TaskCard({
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
  const tz = task.timezone || "Server default"
  return (
    <article className="rounded-md border border-hairline bg-surface px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink" title={task.name}>
          {task.name}
        </span>
        <TaskStatusChip paused={task.paused} />
      </div>

      <p
        className="mt-1 truncate font-mono text-xs text-ink-muted"
        title={`${scheduleText(task.schedule)} · ${tz}`}
      >
        {scheduleText(task.schedule)} · {tz}
      </p>
      <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-ink-muted">
        <span title={task.directory}>{directoryName(task.directory)}</span>
        <span title={task.prompt}>
          {task.model.providerID}/{task.model.id}
        </span>
      </p>
      <p className="mt-0.5 text-xs text-ink-faint">
        {task.lastRunAt ? `Last ${formatTimestamp(task.lastRunAt, task.timezone)}` : "Never run"}
        {task.nextRunAt ? ` · Next ${formatTimestamp(task.nextRunAt, task.timezone)}` : ""}
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-1 border-t border-hairline pt-2">
        {task.paused ? (
          <button
            type="button"
            onClick={onTogglePause}
            disabled={busy}
            className="mh-btn mh-btn--ghost mh-btn--sm"
          >
            <PlayIcon size={14} className="shrink-0 text-ink-muted" />
            Resume
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={onRunNow}
              disabled={busy}
              title="Fire the prompt into a new session now"
              className="mh-btn mh-btn--ghost mh-btn--sm"
            >
              <PlayIcon size={14} className="shrink-0 text-ink-muted" />
              Run now
            </button>
            <button
              type="button"
              onClick={onTogglePause}
              disabled={busy}
              className="mh-btn mh-btn--ghost mh-btn--sm"
            >
              <PauseIcon size={14} className="shrink-0 text-ink-muted" />
              Pause
            </button>
          </>
        )}
        <button type="button" onClick={onEdit} className="mh-btn mh-btn--ghost mh-btn--sm">
          Edit
        </button>
        <button
          type="button"
          onClick={onToggleHistory}
          aria-expanded={historyOpen}
          className="mh-btn mh-btn--ghost mh-btn--sm"
        >
          <ChevronDownIcon
            size={14}
            className={`shrink-0 text-ink-muted transition-transform ${historyOpen ? "" : "-rotate-90"}`}
          />
          Run history
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={busy}
          aria-label={`Delete ${task.name}`}
          title="Delete task"
          className="mh-btn mh-btn--ghost mh-btn--sm ml-auto text-danger hover:text-danger"
        >
          <TrashIcon size={14} />
        </button>
      </div>

      {historyOpen && <RunHistory task={task} onOpenSession={onOpenSession} />}
    </article>
  )
}

/**
 * Create/edit dialog, pre-filled from the task it edits. Validates locally
 * for friendlier messages (the server enforces the same rules) and submits
 * through the client-core mutations, guarded against double submits.
 */
function TaskDialog({ task, onClose }: { task: ScheduledTask | null; onClose: () => void }) {
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
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)

  const dialogRef = useModalFocus<HTMLFormElement>(onClose)

  const flatModels = flattenModels(modelsQuery.data?.models ?? [], modelsQuery.data?.providers ?? [])
  const modelOptions: SearchSelectOption[] = flatModels.map((option) => ({
    value: option.value,
    label: option.label,
    triggerLabel: option.model,
  }))
  const modelIcon = flatModels.find((option) => option.value === modelValue)

  const workspaceOptions: SearchSelectOption[] = useMemo(() => {
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

  const timezoneOptions: SearchSelectOption[] = useMemo(() => {
    const zones = timeZones()
    const options: SearchSelectOption[] = [
      { value: "", label: "Server default" },
      ...zones.map((zone) => ({ value: zone, label: zone })),
    ]
    // An edited task may carry a zone the browser list omits (e.g. "UTC",
    // stored as "Etc/UTC" by the ECMA-402 list): keep showing it.
    if (timezone && !zones.includes(timezone)) {
      options.push({ value: timezone, label: timezone })
    }
    return options
  }, [timezone])

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

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center mh-overlay md:items-center md:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Scheduled task"
    >
      <form
        ref={dialogRef}
        tabIndex={-1}
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
        className="pb-safe mh-dialog max-h-[calc(100dvh-2rem)] w-full overflow-y-auto rounded-b-none outline-none md:rounded-xl"
      >
        <h3 className="mh-dialog__title mh-heading-4">{task ? "Edit task" : "New task"}</h3>
        <p className="mh-body-sm text-ink-muted">
          Fires the prompt into a fresh session in the workspace on its schedule.
        </p>

        <div className="mt-4">
          <label className="mh-label" htmlFor="scheduled-task-name">
            Name
          </label>
          <input
            id="scheduled-task-name"
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Nightly sweep"
            className="mh-input"
          />
        </div>

        <div className="mt-3">
          <label className="mh-label" htmlFor="scheduled-task-prompt">
            Prompt
          </label>
          <textarea
            id="scheduled-task-prompt"
            rows={3}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Inspect the failing checks and summarize them"
            className="mh-textarea"
          />
        </div>

        <p className="mh-label mt-3">Model</p>
        <div className="mt-0">
          <SearchSelect
            value={modelValue}
            options={modelOptions}
            onChange={setModelValue}
            ariaLabel="Model"
            placeholder="Pick a model"
            icon={modelIcon ? <ProviderGlyph providerID={modelIcon.providerID} name={modelIcon.provider} /> : undefined}
            title={modelIcon?.label}
          />
        </div>

        <p className="mh-label mt-3">Workspace</p>
        <div className="mt-0">
          <SearchSelect
            value={directory}
            options={workspaceOptions}
            onChange={setDirectory}
            ariaLabel="Workspace"
            placeholder="Pick a workspace"
          />
        </div>

        <p className="mh-label mt-3">Schedule</p>
        <div className="mt-0">
          <SearchSelect
            value={scheduleValue}
            options={SCHEDULE_OPTIONS}
            onChange={pickSchedule}
            ariaLabel="Schedule"
            placeholder="Pick a schedule"
          />
        </div>
        {customMode && (
          <input
            type={customMode === "minutes" ? "number" : "text"}
            min={customMode === "minutes" ? 5 : undefined}
            value={customSchedule}
            onChange={(event) => setCustomSchedule(event.target.value)}
            placeholder={customMode === "minutes" ? "Minutes (≥ 5)" : "0 9 * * 1"}
            aria-label={customMode === "minutes" ? "Custom interval in minutes" : "Custom cron expression"}
            className="mh-input mt-2"
          />
        )}

        <p className="mh-label mt-3">Timezone</p>
        <div className="mt-0">
          <SearchSelect
            value={timezone}
            options={timezoneOptions}
            onChange={setTimezone}
            ariaLabel="Timezone"
            placeholder="Server default"
          />
        </div>

        {error && (
          <p role="alert" className="mt-2 text-xs text-danger">
            {error}
          </p>
        )}

        <div className="mh-dialog__actions">
          <button type="button" onClick={onClose} disabled={saving} className="mh-btn mh-btn--secondary">
            Cancel
          </button>
          <button type="submit" disabled={saving} className="mh-btn mh-btn--primary">
            {saving ? "Saving…" : task ? "Save changes" : "Create task"}
          </button>
        </div>
      </form>
    </div>
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
function DeleteTaskDialog({
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
  const dialogRef = useModalFocus<HTMLDivElement>(onClose)
  const [error, setError] = useState<string | null>(null)
  /** Guard so a double click cannot submit the delete twice. */
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
    <div
      className="fixed inset-0 z-50 flex items-end justify-center mh-overlay md:items-center md:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Delete task"
    >
      <div ref={dialogRef} tabIndex={-1} className="pb-safe mh-dialog w-full rounded-b-none outline-none md:rounded-xl">
        <h3 className="mh-dialog__title mh-heading-4">Delete task</h3>
        <p className="mh-body-sm text-ink-muted">
          Delete <span className="font-medium text-ink">{task.name}</span>?{" "}
          <span className="text-warning">Its run history is removed with it.</span> The sessions it created stay. This
          cannot be undone.
        </p>

        {error && (
          <p role="alert" className="mt-2 text-xs text-danger">
            {error}
          </p>
        )}

        <div className="mh-dialog__actions">
          <button type="button" onClick={onClose} disabled={busy} className="mh-btn mh-btn--secondary">
            Cancel
          </button>
          <button type="button" onClick={() => void confirm()} disabled={busy} className="mh-btn mh-btn--danger">
            {busy ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * The scheduler panel: header, task cards, run history and dialogs. Its only
 * app dependency is `onOpenSession`, called when a run's session is opened.
 */
export function SchedulerPanel({ onOpenSession }: { onOpenSession: (sessionID: string) => void }) {
  const tasksQuery = useScheduledTasks(client)
  const runNowMutation = useRunScheduledTaskNow(client)
  const updateMutation = useUpdateScheduledTask(client)
  const deleteMutation = useDeleteScheduledTask(client)
  const [historyTaskID, setHistoryTaskID] = useState<string | null>(null)
  /** "new" opens the create dialog; a task opens it pre-filled for editing. */
  const [dialog, setDialog] = useState<ScheduledTask | null | "new">(null)
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

  /** Deleting cascades the run history; failures stay in the dialog. */
  async function confirmDelete(): Promise<void> {
    const target = deleteTarget
    if (!target || deleteMutation.isPending) return
    setActionError(null)
    // Throws on failure: the dialog catches it and stays open with the reason.
    await deleteMutation.mutateAsync(target.id)
    setDeleteTarget(null)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-hairline px-3 py-3">
        <ClockIcon size={16} className="shrink-0 text-ink-muted" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">Scheduler</span>
        <button
          type="button"
          onClick={() => {
            setActionError(null)
            setDialog("new")
          }}
          className="mh-btn mh-btn--secondary mh-btn--sm"
        >
          New task
        </button>
      </div>

      <div className="scroll-thin min-h-0 flex-1 px-2 py-3">
        {tasksQuery.isPending && <p className="mh-body-sm text-ink-muted">Loading tasks…</p>}
        {tasksQuery.isError && (
          <div>
            <p className="mh-body-sm text-ink-muted">Could not load the scheduler.</p>
            <button
              type="button"
              onClick={() => void tasksQuery.refetch()}
              className="mh-btn mh-btn--ghost mh-btn--sm mt-2"
            >
              Retry
            </button>
          </div>
        )}
        {!tasksQuery.isPending && !tasksQuery.isError && tasks.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
            <ClockIcon size={22} className="text-ink-faint" />
            <p className="mh-body-sm text-ink-muted">No scheduled tasks yet — create one to fire a prompt on a schedule.</p>
          </div>
        )}
        {tasks.length > 0 && (
          <div className="flex flex-col gap-2">
            {tasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                busy={runBusyTaskID === task.id || patchBusyTaskID === task.id}
                historyOpen={historyTaskID === task.id}
                onRunNow={() => runTaskNow(task)}
                onTogglePause={() => togglePause(task)}
                onToggleHistory={() => setHistoryTaskID(historyTaskID === task.id ? null : task.id)}
                onEdit={() => {
                  setActionError(null)
                  setDialog(task)
                }}
                onDelete={() => {
                  setActionError(null)
                  setDeleteTarget(task)
                }}
                onOpenSession={onOpenSession}
              />
            ))}
          </div>
        )}
        {actionError && (
          <p role="alert" className="mt-2 text-xs text-danger">
            {actionError}
          </p>
        )}
      </div>

      {dialog && <TaskDialog task={dialog === "new" ? null : dialog} onClose={() => setDialog(null)} />}
      {deleteTarget && (
        <DeleteTaskDialog
          task={deleteTarget}
          busy={deleteMutation.isPending}
          onConfirm={confirmDelete}
          onClose={() => setDeleteTarget(null)}
        />
      )}
    </div>
  )
}
