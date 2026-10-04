import Database from "better-sqlite3"

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
  close(): void
}

export function createSqliteStore(file: string): Store {
  const db = new Database(file)
  db.pragma("journal_mode = WAL")
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

  /**
   * SQLite has no boolean type; rows come back with `pushed` as 0/1. The
   * queries above alias the columns, so normalize here.
   */
  function normalizeIsolatedSession(row: Record<string, unknown>): IsolatedSessionRecord {
    return { ...(row as unknown as IsolatedSessionRecord), pushed: row.pushed === 1 }
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
    close() {},
  }
}
