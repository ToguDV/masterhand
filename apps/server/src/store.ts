import Database from "better-sqlite3"

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
  const db = new Database(source)
  try {
    db.exec(`VACUUM INTO '${destination.replace(/'/g, "''")}'`)
  } finally {
    db.close()
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
  /** True when the database answers a trivial read (readiness/health). */
  ping(): boolean
  close(): void
}

export function createSqliteStore(file: string): Store {
  const db = new Database(file)
  // Single BFF instance over one SQLite file (ARCHITECTURE.md ADR-26). WAL
  // keeps readers non-blocking while a write is in flight, NORMAL avoids an
  // fsync per commit on the audit/touch path, and busy_timeout absorbs a
  // concurrent writer briefly instead of failing with SQLITE_BUSY.
  db.pragma("journal_mode = WAL")
  db.pragma("synchronous = NORMAL")
  db.pragma("busy_timeout = 5000")

  // A corrupt file must fail loudly at boot with a pointer to the restore
  // procedure, not throw opaque errors per request later (issue #80).
  const integrity = db.pragma("quick_check", { simple: true })
  if (integrity !== "ok") {
    db.close()
    throw new Error(
      `masterhand database failed its integrity check (${String(integrity)}); restore it from a backup — see docs/runbooks/backups.md`,
    )
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS isolated_sessions (
      session_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      path TEXT NOT NULL,
      branch TEXT NOT NULL,
      base_ref TEXT NOT NULL,
      pushed INTEGER NOT NULL DEFAULT 0,
      pr_url TEXT,
      created_at INTEGER NOT NULL
    )
  `)
  // Push subscriptions belonged to the pre-re-architecture PWA plan.
  db.exec("DROP TABLE IF EXISTS push_subscriptions")
  db.exec(`
    CREATE TABLE IF NOT EXISTS preview_ports (
      session_id TEXT PRIMARY KEY,
      port INTEGER NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      session_id TEXT,
      workspace_id TEXT,
      kind TEXT NOT NULL,
      command TEXT,
      reason TEXT,
      source TEXT NOT NULL
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_runs (
      workspace_id TEXT PRIMARY KEY,
      command TEXT NOT NULL,
      args TEXT NOT NULL,
      cwd TEXT,
      source TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)

  // Goal mode (`/goal`): the adversarial review loop state and its settings.
  db.exec(`
    CREATE TABLE IF NOT EXISTS goal_runs (
      session_id TEXT PRIMARY KEY,
      run_token TEXT NOT NULL DEFAULT '',
      goal TEXT NOT NULL,
      state TEXT NOT NULL,
      round INTEGER NOT NULL,
      max_rounds INTEGER NOT NULL,
      main_model TEXT,
      critic_model TEXT,
      judge_model TEXT,
      critic_session_id TEXT,
      judge_session_id TEXT,
      last_report TEXT,
      last_critique TEXT,
      last_verdict TEXT,
      history TEXT NOT NULL DEFAULT '[]',
      error TEXT,
      awaiting_kind TEXT,
      awaiting_session_id TEXT,
      awaiting_assistant_id TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      paused_phase TEXT,
      prompt_serial INTEGER NOT NULL DEFAULT 0,
      nudged INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS goal_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      max_rounds INTEGER NOT NULL,
      critic_model TEXT,
      judge_model TEXT
    )
  `)

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
      removeWorkspaceStatement.run(id)
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
    ping() {
      return true
    },
    close() {},
  }
}
