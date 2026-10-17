/**
 * Scheduled tasks (issue #147) shared client contract: prompts the BFF fires
 * into opencode sessions on an interval or cron expression, plus the run
 * history each fire leaves behind. State lives server-side; the BFF announces
 * changes with a bare `scheduler.updated` frame, so clients reconcile by
 * refetching (there is nothing in the frame to write into the cache).
 */

export type ScheduleKind = "interval" | "cron"

export interface ScheduleSpec {
  kind: ScheduleKind
  intervalMinutes?: number
  cron?: string
}

/** A model reference as the task's prompt runs with. */
export interface ModelRef {
  providerID: string
  id: string
  variant?: string
}

export interface ScheduledTask {
  id: string
  name: string
  prompt: string
  model: ModelRef
  schedule: ScheduleSpec
  /** IANA zone the schedule is evaluated in. */
  timezone: string
  directory: string
  paused: boolean
  lastRunAt: string | null
  nextRunAt: string | null
  createdAt: string
}

/** Body of `POST /api/scheduled-tasks`. */
export interface ScheduledTaskInput {
  name: string
  prompt: string
  model: ModelRef
  schedule: ScheduleSpec
  timezone?: string
  directory: string
}

/** Partial body of `PATCH /api/scheduled-tasks/:id`. */
export interface ScheduledTaskPatch {
  name?: string
  prompt?: string
  model?: ModelRef
  schedule?: ScheduleSpec
  timezone?: string
  directory?: string
  paused?: boolean
}

export type ScheduledRunStatus = "queued" | "firing" | "running" | "completed" | "failed" | "interrupted" | "skipped"

export interface ScheduledRun {
  id: string
  taskId: string
  sessionID: string | null
  status: ScheduledRunStatus
  source: "schedule" | "manual"
  error: string | null
  startedAt: string
  endedAt: string | null
}

export const SCHEDULER_EVENT_TYPE = "scheduler.updated"

/**
 * Parses a `scheduler.updated` frame: `{ data: { taskID } }` with the targeted
 * task's id, or null when a task id is absent. Same synthetic-frame shape as
 * goal.updated/board.updated. There is no payload of truth of our own to write
 * into the cache; the client refetches instead.
 */
export function schedulerEventOf(event: unknown): { taskID: string | null } | null {
  if (!event || typeof event !== "object") return null
  if ((event as { type?: unknown }).type !== SCHEDULER_EVENT_TYPE) return null
  const data = (event as { data?: unknown }).data
  if (!data || typeof data !== "object") return { taskID: null }
  const taskID = (data as { taskID?: unknown }).taskID
  if (typeof taskID !== "string" || !taskID) return { taskID: null }
  return { taskID }
}
