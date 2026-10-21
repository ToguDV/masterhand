import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs"
import Database from "better-sqlite3"
import { runMigrations } from "./migrations.js"

/** Owner-only data directory: it holds the database, backups and tunnel PIDs. */
const PRIVATE_DIR_MODE = 0o700
/** Owner-only files: SQLite (and its WAL/SHM) plus backups contain credentials. */
const PRIVATE_FILE_MODE = 0o600

/**
 * Creates the data directory or tightens an existing one to 0700 (issue #182).
 * A pre-existing 0755 directory from an older release is fixed here.
 */
export function ensureDataDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE })
  chmodSync(dir, PRIVATE_DIR_MODE)
}

/**
 * Creates the database file at 0600 *before* SQLite opens it: SQLite copies the
 * database mode onto the WAL/SHM sidecars it creates, so they are private from
 * creation. Chmod also tightens a database left 0644 by an older release.
 */
function prepareDatabaseFile(file: string): void {
  closeSync(openSync(file, "a", PRIVATE_FILE_MODE))
  chmodSync(file, PRIVATE_FILE_MODE)
}

/** Sidecars are created on demand; a legacy one must not stay world-readable. */
function tightenDatabaseSidecars(file: string): void {
  for (const suffix of ["-wal", "-shm"]) {
    try {
      chmodSync(`${file}${suffix}`, PRIVATE_FILE_MODE)
    } catch {
      // Not created yet (or a read-only volume); SQLite inherits the DB mode.
    }
  }
}

/** True when the error is a SQLite failure (disk full, read-only, corrupt, …). */
export function isStorageError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === "string" && code.startsWith("SQLITE_")
}

/** True when the error is a UNIQUE/PRIMARY KEY/FOREIGN KEY constraint violation. */
export function isStorageConflict(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT")
}

/**
 * Online copy of a live database (`VACUUM INTO`). The destination must not
 * exist; the result is a consistent, compacted snapshot safe to restore.
 */
export function backupDatabase(source: string, destination: string): void {
  // The snapshot is a full copy of the database. Set the umask before VACUUM
  // creates the file so it is never briefly world-readable; restore it after.
  const previousUmask = process.umask(0o077)
  try {
    const db = new Database(source)
    try {
      db.exec(`VACUUM INTO '${destination.replace(/'/g, "''")}'`)
    } finally {
      db.close()
    }
    chmodSync(destination, PRIVATE_FILE_MODE)
  } finally {
    process.umask(previousUmask)
  }
}

export interface DeviceRecord {
  id: string
  name: string
  createdAt: number
  lastUsedAt: number
}

export interface WorkspaceRecord {
  id: string
  name: string
  path: string
  createdAt: number
}

/**
 * A session running in its own git worktree (isolated mode). `path` is the
 * worktree directory opencode works in; `branch` is the checked-out branch.
 */
export interface IsolatedSessionRecord {
  sessionID: string
  workspaceID: string
  path: string
  branch: string
  baseRef: string
  pushed: boolean
  prUrl: string | null
  createdAt: number
}

/** Reserved preview port for a session (survives BFF restarts). */
export interface PreviewPortRecord {
  sessionID: string
  port: number
  createdAt: number
}

/** Which agent inside a goal run is currently expected to answer. */
export type GoalPhase = "main" | "critic" | "judge"

export type GoalState =
  | "running"
  | "critiquing"
  | "judging"
  | "approved"
  | "paused"
  | "cancelled"
  | "error"

export interface GoalIssue {
  severity: "high" | "medium" | "low"
  claim: string
  evidence: string
}

/** Adversarial review produced by the critic session. */
export interface GoalCritique {
  argument: string
  issues: GoalIssue[]
}

/** Decision produced by the judge session. */
export interface GoalVerdict {
  approved: boolean
  reasoning: string
  requiredChanges: string[]
}

/** Completion marker emitted by the main agent (`<masterhand:goal>`). */
export interface GoalReport {
  status: "complete" | "blocked"
  summary: string
  evidence: string[]
  reason: string | null
}

export interface GoalHistoryEntry {
  round: number
  critique: GoalCritique | null
  verdict: GoalVerdict | null
}

/**
 * One goal run (`/goal`): the adversarial review loop around a session. The
 * record is the orchestrator's durable state so a BFF restart can reconcile
 * in-flight runs instead of losing them.
 */
export interface GoalRunRecord {
  sessionID: string
  /** Unique per run: prompt/session reconciliation markers embed it. */
  runToken: string
  goal: string
  state: GoalState
  round: number
  maxRounds: number
  mainModel: string | null
  criticModel: string | null
  judgeModel: string | null
  criticSessionID: string | null
  judgeSessionID: string | null
  lastReport: GoalReport | null
  lastCritique: GoalCritique | null
  lastVerdict: GoalVerdict | null
  history: GoalHistoryEntry[]
  error: string | null
  awaitingKind: GoalPhase | null
  awaitingSessionID: string | null
  /** Assistant message id observed when the phase was prompted (idempotence baseline). */
  awaitingAssistantID: string | null
  /** Phase attempts spent on transient failures (bounded). */
  attempt: number
  /** Whether the "missing completion marker" corrective nudge was already sent. */
  nudged: boolean
  /** Last transient failure/review activity surfaced to the UI. */
  lastError: string | null
  /** Phase to re-drive on resume ("cap" = round budget exhausted). */
  pausedPhase: GoalPhase | "cap" | null
  /** Increments per prompt so reconciliation markers stay unique. */
  promptSerial: number
  createdAt: number
  updatedAt: number
}

/** Single-user goal settings (critic/judge models, round budget). */
export interface GoalSettingsRecord {
  maxRounds: number
  criticModel: string | null
  judgeModel: string | null
}

/** Default round budget for a goal run before it pauses for a user decision. */
export const DEFAULT_GOAL_MAX_ROUNDS = 5

/** One kanban column on a workspace's board (one board per workspace). */
export interface BoardColumnRecord {
  id: string
  workspaceID: string
  title: string
  position: number
  createdAt: number
  updatedAt: number
}

/** One kanban card inside a column. */
export interface BoardCardRecord {
  id: string
  columnID: string
  title: string
  description: string
  position: number
  createdAt: number
  updatedAt: number
}

/** Full board snapshot as `GET /api/board` returns it (columns with nested cards). */
export interface BoardSnapshot {
  workspaceID: string
  columns: Array<BoardColumnRecord & { cards: BoardCardRecord[] }>
}

/**
 * A blocked action, kept for diagnosis. `permission_denied` comes from
 * opencode (a tool call rejected by the session permission guard);
 * `run_rejected` comes from MasterHand's run-config validation.
 */
export interface AuditEventRecord {
  id: number
  at: number
  sessionID: string | null
  workspaceID: string | null
  kind: "permission_denied" | "run_rejected"
  command: string | null
  reason: string | null
  source: "opencode" | "bff"
}

/**
 * How to start a workspace's dev server. MasterHand runs it through opencode's
 * PTY API and stops it by killing that exact process, so agents never manage
 * (or kill) servers themselves. `source` records who proposed it: the agent
 * (via `.masterhand/run.json`) or the user (edited in the UI).
 */
export interface WorkspaceRunRecord {
  workspaceID: string
  command: string
  args: string[]
  cwd: string | null
  source: "agent" | "user"
  updatedAt: number
}

/**
 * How a scheduled task repeats (issue #147). `intervalMinutes` is enforced
 * `>= 5` at the validation boundary; `cron` is a 5-field croner expression.
 */
export type ScheduleKind = "interval" | "cron"

export interface ScheduleSpec {
  kind: ScheduleKind
  /** kind=interval, enforced >= 5. */
  intervalMinutes?: number
  /** kind=cron, 5-field expression. */
  cron?: string
}

/** A model reference as MasterHand pins it on a session (`variant` optional). */
export interface ModelRef {
  providerID: string
  id: string
  variant?: string
}

/**
 * A scheduler task: run `<prompt>` with `<model>` in `<directory>` on a
 * schedule. Timestamps are ISO strings (they travel through the API as such);
 * `timezone` is an IANA name, `""` meaning the server default.
 */
export interface ScheduledTask {
  id: string
  name: string
  prompt: string
  model: ModelRef
  schedule: ScheduleSpec
  timezone: string
  /** Workspace slug the prompts run in. */
  directory: string
  paused: boolean
  lastRunAt: string | null
  nextRunAt: string | null
  createdAt: string
}

export type ScheduledRunStatus =
  | "queued"
  | "firing"
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "skipped"

/** One execution of a scheduled task (durable for restart reconciliation). */
export interface ScheduledRun {
  id: string
  taskId: string
  sessionID: string | null
  status: ScheduledRunStatus
  /** `schedule` = fired by the loop, `manual` = user-triggered run-now. */
  source: "schedule" | "manual"
  error: string | null
  startedAt: string
  endedAt: string | null
}

export interface Store {
  create(record: DeviceRecord): void
  get(id: string): DeviceRecord | null
  list(): DeviceRecord[]
  remove(id: string): void
  touch(id: string, now?: number): void
  listWorkspaces(): WorkspaceRecord[]
  getWorkspace(id: string): WorkspaceRecord | null
  getWorkspaceByPath(path: string): WorkspaceRecord | null
  createWorkspace(record: WorkspaceRecord): void
  removeWorkspace(id: string): void
  listIsolatedSessions(workspaceID?: string): IsolatedSessionRecord[]
  getIsolatedSession(sessionID: string): IsolatedSessionRecord | null
  createIsolatedSession(record: IsolatedSessionRecord): void
  updateIsolatedSession(sessionID: string, patch: { pushed?: boolean; prUrl?: string | null }): void
  removeIsolatedSession(sessionID: string): void
  listPreviewPorts(): PreviewPortRecord[]
  getPreviewPort(sessionID: string): number | null
  assignPreviewPort(record: PreviewPortRecord): void
  removePreviewPort(sessionID: string): void
  recordAudit(event: Omit<AuditEventRecord, "id">): void
  listAudit(limit?: number): AuditEventRecord[]
  clearAudit(): void
  getWorkspaceRun(workspaceID: string): WorkspaceRunRecord | null
  saveWorkspaceRun(record: WorkspaceRunRecord): void
  removeWorkspaceRun(workspaceID: string): void
  getGoalRun(sessionID: string): GoalRunRecord | null
  saveGoalRun(record: GoalRunRecord): void
  removeGoalRun(sessionID: string): void
  /** Every persisted run (boot reconciliation). */
  listGoalRuns(): GoalRunRecord[]
  getGoalSettings(): GoalSettingsRecord
  saveGoalSettings(settings: GoalSettingsRecord): void
  /** Board snapshot for a workspace (columns with nested cards, sorted by position). */
  getBoard(workspaceID: string): BoardSnapshot
  /** O(1) column lookup for routes (workspace resolution without scanning). */
  getBoardColumn(id: string): BoardColumnRecord | null
  /** O(1) card lookup for routes (workspace resolution without scanning). */
  getBoardCard(id: string): BoardCardRecord | null
  /** Upsert by id: replaying a lost create returns the existing row, never duplicates. */
  createBoardColumn(record: { id: string; workspaceID: string; title: string; position?: number }): BoardColumnRecord
  updateBoardColumn(
    id: string,
    patch: { title?: string; position?: number },
  ): BoardColumnRecord | null
  /** Idempotent: deleting a column removes its cards in the same transaction. */
  deleteBoardColumn(id: string): void
  createBoardCard(record: {
    id: string
    columnID: string
    title: string
    description?: string
    position?: number
  }): BoardCardRecord | null
  updateBoardCard(
    id: string,
    patch: { title?: string; description?: string; columnID?: string; position?: number },
  ): BoardCardRecord | null
  /** Idempotent. */
  deleteBoardCard(id: string): void
  createScheduledTask(record: ScheduledTask): void
  /** Full upsert by id (goal drafting parity). */
  saveScheduledTask(record: ScheduledTask): void
  getScheduledTask(id: string): ScheduledTask | null
  /** All tasks, oldest first (stable tick order). */
  listScheduledTasks(): ScheduledTask[]
  /** Idempotent; removes the task's runs in the same transaction. */
  deleteScheduledTask(id: string): void
  /** One task's run history, newest first. */
  listScheduledRuns(taskId: string): ScheduledRun[]
  createScheduledRun(record: ScheduledRun): void
  saveScheduledRun(record: ScheduledRun): void
  getScheduledRun(id: string): ScheduledRun | null
  /** Newest run of a task still in queued/firing/running, or null. */
  getActiveScheduledRun(taskId: string): ScheduledRun | null
  /** Every queued/firing/running run across tasks (boot reconcile, liveness). */
  listActiveScheduledRuns(): ScheduledRun[]
  /** True when the database answers a trivial read (readiness/health). */
  ping(): boolean
  close(): void
}

export function createSqliteStore(file: string): Store {
  prepareDatabaseFile(file)
  const db = new Database(file)
  // Single BFF instance over one SQLite file (ARCHITECTURE.md ADR-26). WAL
  // keeps readers non-blocking while a write is in flight, NORMAL avoids an
  // fsync per commit on the audit/touch path, and busy_timeout absorbs a
  // concurrent writer briefly instead of failing with SQLITE_BUSY.
  //
  // A corrupt (or non-SQLite) file must fail loudly at boot with a pointer to
  // the restore procedure, not throw opaque errors per request later (#80).
  // SQLite may reject the file at the first pragma, so the whole open/check
  // phase shares one actionable error.
  const integrityFailure = (reason: unknown): Error =>
    new Error(
      `masterhand database cannot be opened or failed its integrity check (${
        reason instanceof Error ? reason.message : String(reason)
      }); restore it from a backup — see docs/runbooks/backups.md`,
    )
  let integrity: unknown
  try {
    db.pragma("journal_mode = WAL")
    tightenDatabaseSidecars(file)
    db.pragma("synchronous = NORMAL")
    db.pragma("busy_timeout = 5000")
    integrity = db.pragma("quick_check", { simple: true })
  } catch (error) {
    db.close()
    throw integrityFailure(error)
  }
  if (integrity !== "ok") {
    db.close()
    throw integrityFailure(integrity)
  }
  // Forward-only schema upgrades (#186): run after the integrity check and
  // before the first db.prepare, so an existing database is upgraded instead
  // of breaking boot. A failure closes the handle and fails loudly with a
  // restore pointer.
  try {
    runMigrations(db)
  } catch (error) {
    db.close()
    throw error
  }

  const createStatement = db.prepare(`
    INSERT INTO devices (id, name, created_at, last_used_at)
    VALUES (@id, @name, @createdAt, @lastUsedAt)
  `)
  const getStatement = db.prepare(`
    SELECT id, name, created_at AS createdAt, last_used_at AS lastUsedAt
    FROM devices
    WHERE id = ?
  `)
  const listStatement = db.prepare(`
    SELECT id, name, created_at AS createdAt, last_used_at AS lastUsedAt
    FROM devices
    ORDER BY created_at DESC
  `)
  const removeStatement = db.prepare("DELETE FROM devices WHERE id = ?")
  const touchStatement = db.prepare("UPDATE devices SET last_used_at = ? WHERE id = ?")

  const listWorkspacesStatement = db.prepare(`
    SELECT id, name, path, created_at AS createdAt
    FROM workspaces
    ORDER BY created_at ASC
  `)
  const getWorkspaceStatement = db.prepare(`
    SELECT id, name, path, created_at AS createdAt
    FROM workspaces
    WHERE id = ?
  `)
  const getWorkspaceByPathStatement = db.prepare(`
    SELECT id, name, path, created_at AS createdAt
    FROM workspaces
    WHERE path = ?
  `)
  const createWorkspaceStatement = db.prepare(`
    INSERT INTO workspaces (id, name, path, created_at)
    VALUES (@id, @name, @path, @createdAt)
  `)
  const removeWorkspaceStatement = db.prepare("DELETE FROM workspaces WHERE id = ?")

  const isolatedSessionColumns = `
    SELECT session_id AS sessionID, workspace_id AS workspaceID, path, branch,
           base_ref AS baseRef, pushed, pr_url AS prUrl, created_at AS createdAt
    FROM isolated_sessions
  `
  const listIsolatedSessionsStatement = db.prepare(`${isolatedSessionColumns} ORDER BY created_at ASC`)
  const listIsolatedSessionsByWorkspaceStatement = db.prepare(
    `${isolatedSessionColumns} WHERE workspace_id = ? ORDER BY created_at ASC`,
  )
  const getIsolatedSessionStatement = db.prepare(`${isolatedSessionColumns} WHERE session_id = ?`)
  const createIsolatedSessionStatement = db.prepare(`
    INSERT INTO isolated_sessions (session_id, workspace_id, path, branch, base_ref, pushed, pr_url, created_at)
    VALUES (@sessionID, @workspaceID, @path, @branch, @baseRef, @pushed, @prUrl, @createdAt)
  `)
  const updateIsolatedSessionStatement = db.prepare(`
    UPDATE isolated_sessions
    SET pushed = COALESCE(@pushed, pushed), pr_url = COALESCE(@prUrl, pr_url)
    WHERE session_id = @sessionID
  `)
  const removeIsolatedSessionStatement = db.prepare("DELETE FROM isolated_sessions WHERE session_id = ?")

  const previewPortColumns = `SELECT session_id AS sessionID, port, created_at AS createdAt FROM preview_ports`
  const listPreviewPortsStatement = db.prepare(`${previewPortColumns} ORDER BY created_at ASC`)
  const getPreviewPortStatement = db.prepare(`${previewPortColumns} WHERE session_id = ?`)
  const assignPreviewPortStatement = db.prepare(`
    INSERT OR REPLACE INTO preview_ports (session_id, port, created_at)
    VALUES (@sessionID, @port, @createdAt)
  `)
  const removePreviewPortStatement = db.prepare("DELETE FROM preview_ports WHERE session_id = ?")

  const auditColumns = `
    SELECT id, at, session_id AS sessionID, workspace_id AS workspaceID, kind, command, reason, source
    FROM audit_events
  `
  const recordAuditStatement = db.prepare(`
    INSERT INTO audit_events (at, session_id, workspace_id, kind, command, reason, source)
    VALUES (@at, @sessionID, @workspaceID, @kind, @command, @reason, @source)
  `)
  const listAuditStatement = db.prepare(`${auditColumns} ORDER BY at DESC, id DESC LIMIT ?`)
  const clearAuditStatement = db.prepare("DELETE FROM audit_events")
  const workspaceRunColumns = `
    SELECT workspace_id AS workspaceID, command, args, cwd, source, updated_at AS updatedAt
    FROM workspace_runs
  `
  const getWorkspaceRunStatement = db.prepare(`${workspaceRunColumns} WHERE workspace_id = ?`)
  const saveWorkspaceRunStatement = db.prepare(`
    INSERT OR REPLACE INTO workspace_runs (workspace_id, command, args, cwd, source, updated_at)
    VALUES (@workspaceID, @command, @args, @cwd, @source, @updatedAt)
  `)
  const removeWorkspaceRunStatement = db.prepare("DELETE FROM workspace_runs WHERE workspace_id = ?")

  const goalRunColumns = `
    SELECT session_id AS sessionID, run_token AS runToken, goal, state, round, max_rounds AS maxRounds,
           main_model AS mainModel, critic_model AS criticModel, judge_model AS judgeModel,
           critic_session_id AS criticSessionID, judge_session_id AS judgeSessionID,
           last_report AS lastReport, last_critique AS lastCritique, last_verdict AS lastVerdict,
           history, error, awaiting_kind AS awaitingKind, awaiting_session_id AS awaitingSessionID,
           awaiting_assistant_id AS awaitingAssistantID, attempt, last_error AS lastError,
           paused_phase AS pausedPhase, prompt_serial AS promptSerial, nudged,
           created_at AS createdAt, updated_at AS updatedAt
    FROM goal_runs
  `
  const getGoalRunStatement = db.prepare(`${goalRunColumns} WHERE session_id = ?`)
  const listGoalRunsStatement = db.prepare(`${goalRunColumns} ORDER BY created_at ASC`)
  const saveGoalRunStatement = db.prepare(`
    INSERT OR REPLACE INTO goal_runs (
      session_id, run_token, goal, state, round, max_rounds, main_model, critic_model, judge_model,
      critic_session_id, judge_session_id, last_report, last_critique, last_verdict,
      history, error, awaiting_kind, awaiting_session_id, awaiting_assistant_id, attempt,
      last_error, paused_phase, prompt_serial, nudged, created_at, updated_at
    ) VALUES (
      @sessionID, @runToken, @goal, @state, @round, @maxRounds, @mainModel, @criticModel, @judgeModel,
      @criticSessionID, @judgeSessionID, @lastReport, @lastCritique, @lastVerdict,
      @history, @error, @awaitingKind, @awaitingSessionID, @awaitingAssistantID, @attempt,
      @lastError, @pausedPhase, @promptSerial, @nudged, @createdAt, @updatedAt
    )
  `)
  const removeGoalRunStatement = db.prepare("DELETE FROM goal_runs WHERE session_id = ?")
  const getGoalSettingsStatement = db.prepare(
    "SELECT max_rounds AS maxRounds, critic_model AS criticModel, judge_model AS judgeModel FROM goal_settings WHERE id = 1",
  )
  const saveGoalSettingsStatement = db.prepare(`
    INSERT OR REPLACE INTO goal_settings (id, max_rounds, critic_model, judge_model)
    VALUES (1, @maxRounds, @criticModel, @judgeModel)
  `)

  const boardColumnColumns = `
    SELECT id, workspace_id AS workspaceID, title, position,
           created_at AS createdAt, updated_at AS updatedAt
    FROM board_columns
  `
  const boardCardColumns = `
    SELECT id, column_id AS columnID, title, description, position,
           created_at AS createdAt, updated_at AS updatedAt
    FROM board_cards
  `
  const listBoardColumnsStatement = db.prepare(`${boardColumnColumns} WHERE workspace_id = ? ORDER BY position ASC`)
  const getBoardColumnStatement = db.prepare(`${boardColumnColumns} WHERE id = ?`)
  const listBoardCardsStatement = db.prepare(`${boardCardColumns} WHERE column_id = ? ORDER BY position ASC`)
  const getBoardCardStatement = db.prepare(`${boardCardColumns} WHERE id = ?`)
  const insertBoardColumnStatement = db.prepare(`
    INSERT INTO board_columns (id, workspace_id, title, position, created_at, updated_at)
    VALUES (@id, @workspaceID, @title, @position, @createdAt, @updatedAt)
    ON CONFLICT(id) DO NOTHING
  `)
  const updateBoardColumnTitleStatement = db.prepare(`
    UPDATE board_columns SET title = @title, updated_at = @updatedAt WHERE id = @id
  `)
  const updateBoardColumnPositionStatement = db.prepare(`
    UPDATE board_columns SET position = @position, updated_at = @updatedAt WHERE id = @id
  `)
  const deleteBoardColumnStatement = db.prepare("DELETE FROM board_columns WHERE id = ?")
  const deleteBoardCardsInColumnStatement = db.prepare("DELETE FROM board_cards WHERE column_id = ?")
  const insertBoardCardStatement = db.prepare(`
    INSERT INTO board_cards (id, column_id, title, description, position, created_at, updated_at)
    VALUES (@id, @columnID, @title, @description, @position, @createdAt, @updatedAt)
    ON CONFLICT(id) DO NOTHING
  `)
  const updateBoardCardFieldsStatement = db.prepare(`
    UPDATE board_cards
    SET title = @title, description = @description, column_id = @columnID,
        position = @position, updated_at = @updatedAt
    WHERE id = @id
  `)
  const updateBoardCardPositionStatement = db.prepare(
    "UPDATE board_cards SET position = @position, updated_at = @updatedAt WHERE id = @id",
  )
  const updateBoardCardContentStatement = db.prepare(`
    UPDATE board_cards
    SET title = @title, description = @description, position = @position, updated_at = @updatedAt
    WHERE id = @id
  `)
  const deleteBoardCardStatement = db.prepare("DELETE FROM board_cards WHERE id = ?")
  const deleteBoardCardsOfWorkspaceStatement = db.prepare(`
    DELETE FROM board_cards WHERE column_id IN (SELECT id FROM board_columns WHERE workspace_id = ?)
  `)
  const deleteBoardColumnsOfWorkspaceStatement = db.prepare("DELETE FROM board_columns WHERE workspace_id = ?")

  const scheduledTaskColumns = `
    SELECT id, name, prompt, model, schedule, timezone, directory, paused,
           last_run_at AS lastRunAt, next_run_at AS nextRunAt, created_at AS createdAt
    FROM scheduled_tasks
  `
  const getScheduledTaskStatement = db.prepare(`${scheduledTaskColumns} WHERE id = ?`)
  const listScheduledTasksStatement = db.prepare(`${scheduledTaskColumns} ORDER BY created_at ASC, id ASC`)
  const saveScheduledTaskStatement = db.prepare(`
    INSERT OR REPLACE INTO scheduled_tasks (
      id, name, prompt, model, schedule, timezone, directory, paused,
      last_run_at, next_run_at, created_at
    ) VALUES (
      @id, @name, @prompt, @model, @schedule, @timezone, @directory, @paused,
      @lastRunAt, @nextRunAt, @createdAt
    )
  `)
  const deleteScheduledTaskStatement = db.prepare("DELETE FROM scheduled_tasks WHERE id = ?")
  const deleteScheduledRunsOfTaskStatement = db.prepare("DELETE FROM scheduled_runs WHERE task_id = ?")

  const scheduledRunColumns = `
    SELECT id, task_id AS taskId, session_id AS sessionID, status, source,
           error, started_at AS startedAt, ended_at AS endedAt
    FROM scheduled_runs
  `
  const listScheduledRunsOfTaskStatement = db.prepare(
    `${scheduledRunColumns} WHERE task_id = ? ORDER BY started_at DESC, rowid DESC`,
  )
  const listActiveScheduledRunsStatement = db.prepare(
    `${scheduledRunColumns} WHERE status IN ('queued', 'firing', 'running') ORDER BY started_at DESC, rowid DESC`,
  )
  const getActiveScheduledRunStatement = db.prepare(
    `${scheduledRunColumns} WHERE task_id = ? AND status IN ('queued', 'firing', 'running')
     ORDER BY started_at DESC, rowid DESC LIMIT 1`,
  )
  const getScheduledRunStatement = db.prepare(`${scheduledRunColumns} WHERE id = ?`)
  const saveScheduledRunStatement = db.prepare(`
    INSERT OR REPLACE INTO scheduled_runs (id, task_id, session_id, status, source, error, started_at, ended_at)
    VALUES (@id, @taskId, @sessionID, @status, @source, @error, @startedAt, @endedAt)
  `)

  /** Reindexes a workspace's columns to 0..n-1 in position order. */
  function reindexBoardColumns(workspaceID: string, now: number): void {
    const rows = listBoardColumnsStatement.all(workspaceID) as BoardColumnRecord[]
    rows.forEach((row, index) => {
      if (row.position !== index) {
        updateBoardColumnPositionStatement.run({ id: row.id, position: index, updatedAt: now })
      }
    })
  }

  /** Reindexes one column's cards to 0..n-1 in position order. */
  function reindexBoardCards(columnID: string, now: number): void {
    const rows = listBoardCardsStatement.all(columnID) as BoardCardRecord[]
    rows.forEach((row, index) => {
      if (row.position !== index) {
        updateBoardCardPositionStatement.run({
          id: row.id,
          position: index,
          updatedAt: now,
        })
      }
    })
  }

  function readBoardSnapshot(workspaceID: string): BoardSnapshot {
    const columns = listBoardColumnsStatement.all(workspaceID) as BoardColumnRecord[]
    return {
      workspaceID,
      columns: columns.map((column) => ({
        ...column,
        cards: listBoardCardsStatement.all(column.id) as BoardCardRecord[],
      })),
    }
  }

  function clampBoardPosition(value: number | undefined, size: number): number {
    if (value === undefined || !Number.isInteger(value) || value < 0) return size
    return Math.min(value, size)
  }

  /**
   * SQLite has no boolean type; rows come back with `pushed` as 0/1. The
   * queries above alias the columns, so normalize here.
   */
  function normalizeIsolatedSession(row: Record<string, unknown>): IsolatedSessionRecord {
    return { ...(row as unknown as IsolatedSessionRecord), pushed: row.pushed === 1 }
  }

  /** `workspace_runs.args` is stored as a JSON array; a corrupt row reads as []. */
  function parseArgs(value: string): string[] {
    try {
      const parsed: unknown = JSON.parse(value)
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []
    } catch {
      return []
    }
  }

  /** Goal JSON columns read tolerantly: a corrupt value degrades to null/[]. */
  function parseJson<T>(value: unknown): T | null {
    if (typeof value !== "string" || value.length === 0) return null
    try {
      return JSON.parse(value) as T
    } catch {
      return null
    }
  }

  function normalizeGoalRun(row: Record<string, unknown>): GoalRunRecord {
    const history = parseJson<GoalHistoryEntry[]>(row.history)
    return {
      ...(row as unknown as GoalRunRecord),
      runToken: typeof row.runToken === "string" ? row.runToken : "",
      nudged: row.nudged === 1,
      lastReport: parseJson<GoalReport>(row.lastReport),
      lastCritique: parseJson<GoalCritique>(row.lastCritique),
      lastVerdict: parseJson<GoalVerdict>(row.lastVerdict),
      history: Array.isArray(history) ? history : [],
    }
  }

  /** `scheduled_tasks.model` is a JSON blob; a corrupt value degrades inertly. */
  function normalizeModelRef(value: unknown): ModelRef {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const raw = value as { providerID?: unknown; id?: unknown; variant?: unknown }
      return {
        providerID: typeof raw.providerID === "string" ? raw.providerID : "",
        id: typeof raw.id === "string" ? raw.id : "",
        ...(typeof raw.variant === "string" && raw.variant ? { variant: raw.variant } : {}),
      }
    }
    return { providerID: "", id: "" }
  }

  /** `scheduled_tasks.schedule` is a JSON blob; a corrupt value reads inert. */
  function normalizeScheduleSpec(value: unknown): ScheduleSpec {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const raw = value as Record<string, unknown>
      if (raw.kind === "cron") {
        return { kind: "cron", ...(typeof raw.cron === "string" ? { cron: raw.cron } : {}) }
      }
      if (raw.kind === "interval") {
        const interval = typeof raw.intervalMinutes === "number" && Number.isFinite(raw.intervalMinutes)
          ? raw.intervalMinutes
          : undefined
        return {
          kind: "interval",
          ...(interval !== undefined ? { intervalMinutes: interval } : {}),
        }
      }
    }
    // Inert by construction: `computeNextRunAt` yields null for it.
    return { kind: "interval", intervalMinutes: 0 }
  }

  function normalizeScheduledTask(row: Record<string, unknown>): ScheduledTask {
    return {
      id: typeof row.id === "string" ? row.id : "",
      name: typeof row.name === "string" ? row.name : "",
      prompt: typeof row.prompt === "string" ? row.prompt : "",
      model: normalizeModelRef(parseJson<ModelRef>(row.model) ?? row.model),
      schedule: normalizeScheduleSpec(parseJson<ScheduleSpec>(row.schedule) ?? row.schedule),
      timezone: typeof row.timezone === "string" ? row.timezone : "",
      directory: typeof row.directory === "string" ? row.directory : "",
      paused: row.paused === 1,
      lastRunAt: typeof row.lastRunAt === "string" ? row.lastRunAt : null,
      nextRunAt: typeof row.nextRunAt === "string" ? row.nextRunAt : null,
      createdAt: typeof row.createdAt === "string" ? row.createdAt : "",
    }
  }

  /** Corrupt rows must never crash reads; unknown statuses stay inert (no SQL match). */
  function normalizeScheduledRun(row: Record<string, unknown>): ScheduledRun {
    return {
      id: typeof row.id === "string" ? row.id : "",
      taskId: typeof row.taskId === "string" ? row.taskId : "",
      sessionID: typeof row.sessionID === "string" && row.sessionID ? row.sessionID : null,
      status: (typeof row.status === "string" ? row.status : "failed") as ScheduledRunStatus,
      source: (typeof row.source === "string" ? row.source : "schedule") as ScheduledRun["source"],
      error: typeof row.error === "string" ? row.error : null,
      startedAt: typeof row.startedAt === "string" ? row.startedAt : "",
      endedAt: typeof row.endedAt === "string" ? row.endedAt : null,
    }
  }

  return {
    create(record) {
      createStatement.run(record)
    },
    get(id) {
      return (getStatement.get(id) as DeviceRecord | undefined) ?? null
    },
    list() {
      return listStatement.all() as DeviceRecord[]
    },
    remove(id) {
      removeStatement.run(id)
    },
    touch(id, now = Date.now()) {
      touchStatement.run(now, id)
    },
    listWorkspaces() {
      return listWorkspacesStatement.all() as WorkspaceRecord[]
    },
    getWorkspace(id) {
      return (getWorkspaceStatement.get(id) as WorkspaceRecord | undefined) ?? null
    },
    getWorkspaceByPath(path) {
      return (getWorkspaceByPathStatement.get(path) as WorkspaceRecord | undefined) ?? null
    },
    createWorkspace(record) {
      createWorkspaceStatement.run(record)
    },
    removeWorkspace(id) {
      const removeBoardRows = db.transaction(() => {
        deleteBoardCardsOfWorkspaceStatement.run(id)
        deleteBoardColumnsOfWorkspaceStatement.run(id)
        removeWorkspaceStatement.run(id)
      })
      removeBoardRows()
    },
    listIsolatedSessions(workspaceID) {
      const rows = workspaceID
        ? listIsolatedSessionsByWorkspaceStatement.all(workspaceID)
        : listIsolatedSessionsStatement.all()
      return (rows as Record<string, unknown>[]).map(normalizeIsolatedSession)
    },
    getIsolatedSession(sessionID) {
      const row = getIsolatedSessionStatement.get(sessionID) as Record<string, unknown> | undefined
      return row ? normalizeIsolatedSession(row) : null
    },
    createIsolatedSession(record) {
      createIsolatedSessionStatement.run({ ...record, pushed: record.pushed ? 1 : 0 })
    },
    updateIsolatedSession(sessionID, patch) {
      updateIsolatedSessionStatement.run({
        sessionID,
        pushed: patch.pushed === undefined ? null : patch.pushed ? 1 : 0,
        prUrl: patch.prUrl === undefined ? null : patch.prUrl,
      })
    },
    removeIsolatedSession(sessionID) {
      removeIsolatedSessionStatement.run(sessionID)
    },
    listPreviewPorts() {
      return listPreviewPortsStatement.all() as PreviewPortRecord[]
    },
    getPreviewPort(sessionID) {
      const row = getPreviewPortStatement.get(sessionID) as { port: number } | undefined
      return row?.port ?? null
    },
    assignPreviewPort(record) {
      assignPreviewPortStatement.run(record)
    },
    removePreviewPort(sessionID) {
      removePreviewPortStatement.run(sessionID)
    },
    recordAudit(event) {
      recordAuditStatement.run(event)
    },
    listAudit(limit = 100) {
      return listAuditStatement.all(limit) as AuditEventRecord[]
    },
    clearAudit() {
      clearAuditStatement.run()
    },
    getWorkspaceRun(workspaceID) {
      const row = getWorkspaceRunStatement.get(workspaceID) as
        | (Omit<WorkspaceRunRecord, "args"> & { args: string })
        | undefined
      return row ? { ...row, args: parseArgs(row.args) } : null
    },
    saveWorkspaceRun(record) {
      saveWorkspaceRunStatement.run({ ...record, args: JSON.stringify(record.args) })
    },
    removeWorkspaceRun(workspaceID) {
      removeWorkspaceRunStatement.run(workspaceID)
    },
    getGoalRun(sessionID) {
      const row = getGoalRunStatement.get(sessionID) as Record<string, unknown> | undefined
      return row ? normalizeGoalRun(row) : null
    },
    saveGoalRun(record) {
      saveGoalRunStatement.run({
        ...record,
        nudged: record.nudged ? 1 : 0,
        lastReport: record.lastReport ? JSON.stringify(record.lastReport) : null,
        lastCritique: record.lastCritique ? JSON.stringify(record.lastCritique) : null,
        lastVerdict: record.lastVerdict ? JSON.stringify(record.lastVerdict) : null,
        history: JSON.stringify(record.history ?? []),
      })
    },
    removeGoalRun(sessionID) {
      removeGoalRunStatement.run(sessionID)
    },
    listGoalRuns() {
      return (listGoalRunsStatement.all() as Record<string, unknown>[]).map(normalizeGoalRun)
    },
    getGoalSettings() {
      const row = getGoalSettingsStatement.get() as GoalSettingsRecord | undefined
      return row ?? { maxRounds: DEFAULT_GOAL_MAX_ROUNDS, criticModel: null, judgeModel: null }
    },
    saveGoalSettings(settings) {
      saveGoalSettingsStatement.run(settings)
    },
    getBoard(workspaceID) {
      return readBoardSnapshot(workspaceID)
    },
    getBoardColumn(id) {
      return (getBoardColumnStatement.get(id) as BoardColumnRecord | undefined) ?? null
    },
    getBoardCard(id) {
      return (getBoardCardStatement.get(id) as BoardCardRecord | undefined) ?? null
    },
    createBoardColumn(record) {
      const now = Date.now()
      const create = db.transaction(() => {
        const existing = getBoardColumnStatement.get(record.id) as BoardColumnRecord | undefined
        if (existing) return existing
        const siblings = listBoardColumnsStatement.all(record.workspaceID) as BoardColumnRecord[]
        const position = clampBoardPosition(record.position, siblings.length)
        // Shift siblings at/after the insertion point, then reindex.
        for (const sibling of siblings) {
          if (sibling.position >= position) {
            updateBoardColumnPositionStatement.run({ id: sibling.id, position: sibling.position + 1, updatedAt: now })
          }
        }
        insertBoardColumnStatement.run({
          id: record.id,
          workspaceID: record.workspaceID,
          title: record.title,
          position,
          createdAt: now,
          updatedAt: now,
        })
        reindexBoardColumns(record.workspaceID, now)
        return getBoardColumnStatement.get(record.id) as BoardColumnRecord
      })
      return create()
    },
    updateBoardColumn(id, patch) {
      const now = Date.now()
      const update = db.transaction(() => {
        const current = getBoardColumnStatement.get(id) as BoardColumnRecord | undefined
        if (!current) return null
        if (patch.title !== undefined) {
          updateBoardColumnTitleStatement.run({ id, title: patch.title, updatedAt: now })
        }
        if (patch.position !== undefined && Number.isInteger(patch.position) && patch.position >= 0) {
          const siblings = (listBoardColumnsStatement.all(current.workspaceID) as BoardColumnRecord[]).filter(
            (row) => row.id !== id,
          )
          const position = Math.min(patch.position, siblings.length)
          const ordered = [...siblings.slice(0, position), current, ...siblings.slice(position)]
          ordered.forEach((row, index) => {
            updateBoardColumnPositionStatement.run({ id: row.id, position: index, updatedAt: now })
          })
        }
        return getBoardColumnStatement.get(id) as BoardColumnRecord
      })
      return update()
    },
    deleteBoardColumn(id) {
      const remove = db.transaction(() => {
        const current = getBoardColumnStatement.get(id) as BoardColumnRecord | undefined
        if (!current) return
        deleteBoardCardsInColumnStatement.run(id)
        deleteBoardColumnStatement.run(id)
        reindexBoardColumns(current.workspaceID, Date.now())
      })
      remove()
    },
    createBoardCard(record) {
      const now = Date.now()
      const create = db.transaction(() => {
        const existing = getBoardCardStatement.get(record.id) as BoardCardRecord | undefined
        if (existing) return existing
        const column = getBoardColumnStatement.get(record.columnID) as BoardColumnRecord | undefined
        if (!column) return null
        const siblings = listBoardCardsStatement.all(record.columnID) as BoardCardRecord[]
        const position = clampBoardPosition(record.position, siblings.length)
        for (const sibling of siblings) {
          if (sibling.position >= position) {
            updateBoardCardPositionStatement.run({
              id: sibling.id,
              position: sibling.position + 1,
              updatedAt: now,
            })
          }
        }
        insertBoardCardStatement.run({
          id: record.id,
          columnID: record.columnID,
          title: record.title,
          description: record.description ?? "",
          position,
          createdAt: now,
          updatedAt: now,
        })
        reindexBoardCards(record.columnID, now)
        return getBoardCardStatement.get(record.id) as BoardCardRecord
      })
      return create()
    },
    updateBoardCard(id, patch) {
      const now = Date.now()
      const update = db.transaction(() => {
        const current = getBoardCardStatement.get(id) as BoardCardRecord | undefined
        if (!current) return null
        const targetColumnID = patch.columnID ?? current.columnID
        const targetColumn = getBoardColumnStatement.get(targetColumnID) as BoardColumnRecord | undefined
        if (!targetColumn) return null
        // One board per workspace: a card never leaves its workspace through a
        // cross-column move (the route answers 409 before this fallback).
        if (targetColumnID !== current.columnID) {
          const sourceColumn = getBoardColumnStatement.get(current.columnID) as BoardColumnRecord | undefined
          if (!sourceColumn || sourceColumn.workspaceID !== targetColumn.workspaceID) return null
        }
        const title = patch.title ?? current.title
        const description = patch.description ?? current.description
        if (targetColumnID === current.columnID) {
          const siblings = (listBoardCardsStatement.all(current.columnID) as BoardCardRecord[]).filter(
            (row) => row.id !== id,
          )
          const at =
            patch.position !== undefined && Number.isInteger(patch.position) && patch.position >= 0
              ? Math.min(patch.position, siblings.length)
              : Math.min(current.position, siblings.length)
          const ordered = [...siblings.slice(0, at), current, ...siblings.slice(at)]
          ordered.forEach((row, index) => {
            if (row.id === id) {
              updateBoardCardContentStatement.run({ id, title, description, position: index, updatedAt: now })
            } else {
              updateBoardCardPositionStatement.run({
                id: row.id,
                position: index,
                updatedAt: now,
              })
            }
          })
        } else {
          // Cross-column move: reindex source, insert into target, reindex target.
          const sourceSiblings = (listBoardCardsStatement.all(current.columnID) as BoardCardRecord[]).filter(
            (row) => row.id !== id,
          )
          sourceSiblings.forEach((row, index) => {
            updateBoardCardPositionStatement.run({
              id: row.id,
              position: index,
              updatedAt: now,
            })
          })
          const targetSiblings = listBoardCardsStatement.all(targetColumnID) as BoardCardRecord[]
          const at =
            patch.position !== undefined && Number.isInteger(patch.position) && patch.position >= 0
              ? Math.min(patch.position, targetSiblings.length)
              : targetSiblings.length
          for (const sibling of targetSiblings) {
            if (sibling.position >= at) {
              updateBoardCardPositionStatement.run({
                id: sibling.id,
                position: sibling.position + 1,
                updatedAt: now,
              })
            }
          }
          updateBoardCardFieldsStatement.run({
            id,
            title,
            description,
            columnID: targetColumnID,
            position: at,
            updatedAt: now,
          })
          reindexBoardCards(targetColumnID, now)
        }
        return getBoardCardStatement.get(id) as BoardCardRecord
      })
      return update()
    },
    deleteBoardCard(id) {
      const card = getBoardCardStatement.get(id) as BoardCardRecord | undefined
      if (!card) return
      const remove = db.transaction(() => {
        deleteBoardCardStatement.run(id)
        reindexBoardCards(card.columnID, Date.now())
      })
      remove()
    },
    createScheduledTask(record) {
      saveScheduledTaskStatement.run({
        ...record,
        paused: record.paused ? 1 : 0,
        model: JSON.stringify(record.model),
        schedule: JSON.stringify(record.schedule),
      })
    },
    saveScheduledTask(record) {
      saveScheduledTaskStatement.run({
        ...record,
        paused: record.paused ? 1 : 0,
        model: JSON.stringify(record.model),
        schedule: JSON.stringify(record.schedule),
      })
    },
    getScheduledTask(id) {
      const row = getScheduledTaskStatement.get(id) as Record<string, unknown> | undefined
      return row ? normalizeScheduledTask(row) : null
    },
    listScheduledTasks() {
      return (listScheduledTasksStatement.all() as Record<string, unknown>[]).map(normalizeScheduledTask)
    },
    deleteScheduledTask(id) {
      const remove = db.transaction(() => {
        deleteScheduledRunsOfTaskStatement.run(id)
        deleteScheduledTaskStatement.run(id)
      })
      remove()
    },
    listScheduledRuns(taskId) {
      return (listScheduledRunsOfTaskStatement.all(taskId) as Record<string, unknown>[]).map(normalizeScheduledRun)
    },
    createScheduledRun(record) {
      saveScheduledRunStatement.run(record)
    },
    saveScheduledRun(record) {
      saveScheduledRunStatement.run(record)
    },
    getScheduledRun(id) {
      const row = getScheduledRunStatement.get(id) as Record<string, unknown> | undefined
      return row ? normalizeScheduledRun(row) : null
    },
    getActiveScheduledRun(taskId) {
      const row = getActiveScheduledRunStatement.get(taskId) as Record<string, unknown> | undefined
      return row ? normalizeScheduledRun(row) : null
    },
    listActiveScheduledRuns() {
      return (listActiveScheduledRunsStatement.all() as Record<string, unknown>[]).map(normalizeScheduledRun)
    },
    ping() {
      try {
        db.prepare("SELECT 1").get()
        return true
      } catch {
        return false
      }
    },
    close() {
      db.close()
    },
  }
}

export function createMemoryStore(): Store {
  const records = new Map<string, DeviceRecord>()
  const workspaces = new Map<string, WorkspaceRecord>()
  const isolatedSessions = new Map<string, IsolatedSessionRecord>()
  const previewPorts = new Map<string, PreviewPortRecord>()
  const audit: AuditEventRecord[] = []
  let auditSequence = 0
  const workspaceRuns = new Map<string, WorkspaceRunRecord>()
  const goalRuns = new Map<string, GoalRunRecord>()
  let goalSettings: GoalSettingsRecord = { maxRounds: DEFAULT_GOAL_MAX_ROUNDS, criticModel: null, judgeModel: null }
  const boardColumns = new Map<string, BoardColumnRecord>()
  const boardCards = new Map<string, BoardCardRecord>()
  const scheduledTasks = new Map<string, ScheduledTask>()
  const scheduledRuns = new Map<string, ScheduledRun>()

  function columnsOf(workspaceID: string): BoardColumnRecord[] {
    return [...boardColumns.values()]
      .filter((column) => column.workspaceID === workspaceID)
      .sort((a, b) => a.position - b.position)
  }

  function cardsOf(columnID: string): BoardCardRecord[] {
    return [...boardCards.values()]
      .filter((card) => card.columnID === columnID)
      .sort((a, b) => a.position - b.position)
  }

  function reindexMemoryColumns(workspaceID: string, now: number): void {
    columnsOf(workspaceID).forEach((column, index) => {
      if (column.position !== index) boardColumns.set(column.id, { ...column, position: index, updatedAt: now })
    })
  }

  function reindexMemoryCards(columnID: string, now: number): void {
    cardsOf(columnID).forEach((card, index) => {
      if (card.position !== index) boardCards.set(card.id, { ...card, position: index, updatedAt: now })
    })
  }

  function clampMemoryPosition(value: number | undefined, size: number): number {
    if (value === undefined || !Number.isInteger(value) || value < 0) return size
    return Math.min(value, size)
  }
  return {
    create(record) {
      records.set(record.id, record)
    },
    get(id) {
      return records.get(id) ?? null
    },
    list() {
      return [...records.values()]
    },
    remove(id) {
      records.delete(id)
    },
    touch(id, now = Date.now()) {
      const record = records.get(id)
      if (record) records.set(id, { ...record, lastUsedAt: now })
    },
    listWorkspaces() {
      return [...workspaces.values()].sort((a, b) => a.createdAt - b.createdAt)
    },
    getWorkspace(id) {
      return workspaces.get(id) ?? null
    },
    getWorkspaceByPath(path) {
      return [...workspaces.values()].find((workspace) => workspace.path === path) ?? null
    },
    createWorkspace(record) {
      workspaces.set(record.id, record)
    },
    removeWorkspace(id) {
      workspaces.delete(id)
      for (const column of [...boardColumns.values()]) {
        if (column.workspaceID !== id) continue
        for (const card of [...boardCards.values()]) {
          if (card.columnID === column.id) boardCards.delete(card.id)
        }
        boardColumns.delete(column.id)
      }
    },
    listIsolatedSessions(workspaceID) {
      const values = [...isolatedSessions.values()].sort((a, b) => a.createdAt - b.createdAt)
      return workspaceID ? values.filter((record) => record.workspaceID === workspaceID) : values
    },
    getIsolatedSession(sessionID) {
      return isolatedSessions.get(sessionID) ?? null
    },
    createIsolatedSession(record) {
      isolatedSessions.set(record.sessionID, record)
    },
    updateIsolatedSession(sessionID, patch) {
      const record = isolatedSessions.get(sessionID)
      if (!record) return
      isolatedSessions.set(sessionID, {
        ...record,
        pushed: patch.pushed ?? record.pushed,
        prUrl: patch.prUrl === undefined ? record.prUrl : patch.prUrl,
      })
    },
    removeIsolatedSession(sessionID) {
      isolatedSessions.delete(sessionID)
    },
    listPreviewPorts() {
      return [...previewPorts.values()].sort((a, b) => a.createdAt - b.createdAt)
    },
    getPreviewPort(sessionID) {
      return previewPorts.get(sessionID)?.port ?? null
    },
    assignPreviewPort(record) {
      previewPorts.set(record.sessionID, record)
    },
    removePreviewPort(sessionID) {
      previewPorts.delete(sessionID)
    },
    recordAudit(event) {
      audit.unshift({ id: ++auditSequence, ...event })
      if (audit.length > 500) audit.length = 500
    },
    listAudit(limit = 100) {
      return audit.slice(0, limit)
    },
    clearAudit() {
      audit.length = 0
    },
    getWorkspaceRun(workspaceID) {
      return workspaceRuns.get(workspaceID) ?? null
    },
    saveWorkspaceRun(record) {
      workspaceRuns.set(record.workspaceID, record)
    },
    removeWorkspaceRun(workspaceID) {
      workspaceRuns.delete(workspaceID)
    },
    getGoalRun(sessionID) {
      return goalRuns.get(sessionID) ?? null
    },
    saveGoalRun(record) {
      goalRuns.set(record.sessionID, record)
    },
    removeGoalRun(sessionID) {
      goalRuns.delete(sessionID)
    },
    listGoalRuns() {
      return [...goalRuns.values()].sort((a, b) => a.createdAt - b.createdAt)
    },
    getGoalSettings() {
      return goalSettings
    },
    saveGoalSettings(settings) {
      goalSettings = settings
    },
    getBoard(workspaceID) {
      return { workspaceID, columns: columnsOf(workspaceID).map((column) => ({ ...column, cards: cardsOf(column.id) })) }
    },
    getBoardColumn(id) {
      return boardColumns.get(id) ?? null
    },
    getBoardCard(id) {
      return boardCards.get(id) ?? null
    },
    createBoardColumn(record) {
      const existing = boardColumns.get(record.id)
      if (existing) return existing
      const now = Date.now()
      const siblings = columnsOf(record.workspaceID)
      const position = clampMemoryPosition(record.position, siblings.length)
      for (const sibling of siblings) {
        if (sibling.position >= position) {
          boardColumns.set(sibling.id, { ...sibling, position: sibling.position + 1, updatedAt: now })
        }
      }
      const column: BoardColumnRecord = {
        id: record.id,
        workspaceID: record.workspaceID,
        title: record.title,
        position,
        createdAt: now,
        updatedAt: now,
      }
      boardColumns.set(column.id, column)
      reindexMemoryColumns(record.workspaceID, now)
      return boardColumns.get(column.id)!
    },
    updateBoardColumn(id, patch) {
      const current = boardColumns.get(id)
      if (!current) return null
      const now = Date.now()
      let title = current.title
      if (patch.title !== undefined) title = patch.title
      boardColumns.set(id, { ...current, title, updatedAt: now })
      if (patch.position !== undefined && Number.isInteger(patch.position) && patch.position >= 0) {
        const siblings = columnsOf(current.workspaceID).filter((row) => row.id !== id)
        const at = Math.min(patch.position, siblings.length)
        const ordered = [...siblings.slice(0, at), { ...current, title }, ...siblings.slice(at)]
        ordered.forEach((row, index) => {
          const stored = boardColumns.get(row.id)!
          boardColumns.set(row.id, { ...stored, title: row.id === id ? title : stored.title, position: index, updatedAt: now })
        })
      }
      return boardColumns.get(id)!
    },
    deleteBoardColumn(id) {
      const current = boardColumns.get(id)
      if (!current) return
      for (const card of [...boardCards.values()]) {
        if (card.columnID === id) boardCards.delete(card.id)
      }
      boardColumns.delete(id)
      reindexMemoryColumns(current.workspaceID, Date.now())
    },
    createBoardCard(record) {
      const existing = boardCards.get(record.id)
      if (existing) return existing
      if (!boardColumns.get(record.columnID)) return null
      const now = Date.now()
      const siblings = cardsOf(record.columnID)
      const position = clampMemoryPosition(record.position, siblings.length)
      for (const sibling of siblings) {
        if (sibling.position >= position) {
          boardCards.set(sibling.id, { ...sibling, position: sibling.position + 1, updatedAt: now })
        }
      }
      const card: BoardCardRecord = {
        id: record.id,
        columnID: record.columnID,
        title: record.title,
        description: record.description ?? "",
        position,
        createdAt: now,
        updatedAt: now,
      }
      boardCards.set(card.id, card)
      reindexMemoryCards(record.columnID, now)
      return boardCards.get(card.id)!
    },
    updateBoardCard(id, patch) {
      const current = boardCards.get(id)
      if (!current) return null
      const targetColumnID = patch.columnID ?? current.columnID
      const targetColumn = boardColumns.get(targetColumnID)
      if (!targetColumn) return null
      // One board per workspace: a card never leaves its workspace.
      if (targetColumnID !== current.columnID) {
        const sourceColumn = boardColumns.get(current.columnID)
        if (!sourceColumn || sourceColumn.workspaceID !== targetColumn.workspaceID) return null
      }
      const now = Date.now()
      const title = patch.title ?? current.title
      const description = patch.description ?? current.description
      if (targetColumnID === current.columnID) {
        const siblings = cardsOf(current.columnID).filter((row) => row.id !== id)
        const at =
          patch.position !== undefined && Number.isInteger(patch.position) && patch.position >= 0
            ? Math.min(patch.position, siblings.length)
            : Math.min(current.position, siblings.length)
        const ordered = [...siblings.slice(0, at), current, ...siblings.slice(at)]
        ordered.forEach((row, index) => {
          if (row.id === id) {
            boardCards.set(id, { ...current, title, description, position: index, updatedAt: now })
          } else {
            boardCards.set(row.id, { ...row, position: index, updatedAt: now })
          }
        })
      } else {
        const sourceSiblings = cardsOf(current.columnID).filter((row) => row.id !== id)
        sourceSiblings.forEach((row, index) => {
          boardCards.set(row.id, { ...row, position: index, updatedAt: now })
        })
        const targetSiblings = cardsOf(targetColumnID)
        const at =
          patch.position !== undefined && Number.isInteger(patch.position) && patch.position >= 0
            ? Math.min(patch.position, targetSiblings.length)
            : targetSiblings.length
        for (const sibling of targetSiblings) {
          if (sibling.position >= at) {
            boardCards.set(sibling.id, { ...sibling, position: sibling.position + 1, updatedAt: now })
          }
        }
        boardCards.set(id, { ...current, columnID: targetColumnID, title, description, position: at, updatedAt: now })
        reindexMemoryCards(targetColumnID, now)
      }
      return boardCards.get(id)!
    },
    deleteBoardCard(id) {
      const current = boardCards.get(id)
      if (!current) return
      boardCards.delete(id)
      reindexMemoryCards(current.columnID, Date.now())
    },
    createScheduledTask(record) {
      scheduledTasks.set(record.id, record)
    },
    saveScheduledTask(record) {
      scheduledTasks.set(record.id, record)
    },
    getScheduledTask(id) {
      return scheduledTasks.get(id) ?? null
    },
    listScheduledTasks() {
      return [...scheduledTasks.values()].sort(
        (a, b) =>
          (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0) || a.id.localeCompare(b.id),
      )
    },
    deleteScheduledTask(id) {
      scheduledTasks.delete(id)
      for (const run of [...scheduledRuns.values()]) {
        if (run.taskId === id) scheduledRuns.delete(run.id)
      }
    },
    listScheduledRuns(taskId) {
      return [...scheduledRuns.values()]
        .filter((run) => run.taskId === taskId)
        .sort(
          (a, b) =>
            (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0) || b.id.localeCompare(a.id),
        )
    },
    createScheduledRun(record) {
      scheduledRuns.set(record.id, record)
    },
    saveScheduledRun(record) {
      scheduledRuns.set(record.id, record)
    },
    getScheduledRun(id) {
      return scheduledRuns.get(id) ?? null
    },
    getActiveScheduledRun(taskId) {
      const ACTIVE = new Set(["queued", "firing", "running"])
      return (
        [...scheduledRuns.values()]
          .filter((run) => run.taskId === taskId && ACTIVE.has(run.status))
          .sort(
            (a, b) =>
              (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0) || b.id.localeCompare(a.id),
          )[0] ?? null
      )
    },
    listActiveScheduledRuns() {
      const ACTIVE = new Set(["queued", "firing", "running"])
      return [...scheduledRuns.values()]
        .filter((run) => ACTIVE.has(run.status))
        .sort(
          (a, b) =>
            (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0) || b.id.localeCompare(a.id),
        )
    },
    ping() {
      return true
    },
    close() {},
  }
}
