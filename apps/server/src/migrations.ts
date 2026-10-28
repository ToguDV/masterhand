import type Database from "better-sqlite3"

/** One forward-only schema step, stamped as SQLite's `PRAGMA user_version`. */
export interface Migration {
  /** Strictly increasing, starting at 1. Must never be reused or edited. */
  version: number
  /** Human-readable summary, quoted in boot failures. */
  description: string
  /** SQL executed in order inside the migration's transaction. */
  statements: readonly string[]
}

const RESTORE_POINTER = "restore the last backup and follow docs/runbooks/backups.md"

/**
 * Every schema change ships as a new migration. A shipped migration is
 * immutable: existing installations already recorded its version, so editing
 * it would leave their schema behind. v1 is the baseline captured when the
 * runner was introduced (#186); add v2, v3, … instead.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: "baseline schema",
    statements: [
      `
        CREATE TABLE IF NOT EXISTS devices (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          last_used_at INTEGER NOT NULL
        )
      `,
      `
        CREATE TABLE IF NOT EXISTS workspaces (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          path TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL
        )
      `,
      `
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
      `,
      // Push subscriptions belonged to the pre-re-architecture PWA plan.
      "DROP TABLE IF EXISTS push_subscriptions",
      `
        CREATE TABLE IF NOT EXISTS preview_ports (
          session_id TEXT PRIMARY KEY,
          port INTEGER NOT NULL UNIQUE,
          created_at INTEGER NOT NULL
        )
      `,
      `
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
      `,
      `
        CREATE TABLE IF NOT EXISTS workspace_runs (
          workspace_id TEXT PRIMARY KEY,
          command TEXT NOT NULL,
          args TEXT NOT NULL,
          cwd TEXT,
          source TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `,
      // Goal mode (`/goal`): the adversarial review loop state and its settings.
      `
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
      `,
      `
        CREATE TABLE IF NOT EXISTS goal_settings (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          max_rounds INTEGER NOT NULL,
          critic_model TEXT,
          judge_model TEXT
        )
      `,
      // Kanban board (one board per workspace, issue #164). No FK pragmas:
      // column deletion removes its cards in the same transaction, and
      // workspace deletion drops its board rows there too.
      `
        CREATE TABLE IF NOT EXISTS board_columns (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          title TEXT NOT NULL,
          position INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `,
      "CREATE INDEX IF NOT EXISTS idx_board_columns_workspace ON board_columns (workspace_id, position)",
      `
        CREATE TABLE IF NOT EXISTS board_cards (
          id TEXT PRIMARY KEY,
          column_id TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          position INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `,
      "CREATE INDEX IF NOT EXISTS idx_board_cards_column ON board_cards (column_id, position)",
      // Scheduler (issue #147): durable scheduled tasks and their run history.
      // No FK pragmas: task deletion removes its runs in the same transaction.
      `
        CREATE TABLE IF NOT EXISTS scheduled_tasks (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          prompt TEXT NOT NULL,
          model TEXT NOT NULL,
          schedule TEXT NOT NULL,
          timezone TEXT NOT NULL DEFAULT '',
          directory TEXT NOT NULL,
          paused INTEGER NOT NULL DEFAULT 0,
          last_run_at TEXT,
          next_run_at TEXT,
          created_at TEXT NOT NULL
        )
      `,
      `
        CREATE TABLE IF NOT EXISTS scheduled_runs (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          session_id TEXT,
          status TEXT NOT NULL,
          source TEXT NOT NULL,
          error TEXT,
          started_at TEXT NOT NULL,
          ended_at TEXT
        )
      `,
      "CREATE INDEX IF NOT EXISTS idx_scheduled_runs_task ON scheduled_runs (task_id, started_at)",
      "CREATE INDEX IF NOT EXISTS idx_scheduled_runs_status ON scheduled_runs (status)",
    ],
  },
  {
    version: 2,
    description: "identify devices by install id",
    statements: [
      // A mutable display label is not identity (issue #193): a stable,
      // client-generated install id is. NULL stays allowed for older clients,
      // and SQLite keeps multiple NULLs distinct in a unique index.
      "ALTER TABLE devices ADD COLUMN install_id TEXT",
      "CREATE UNIQUE INDEX idx_devices_install_id ON devices (install_id)",
      // v1 already drops the obsolete table; databases stamped at v1 that still
      // carry it are cleaned here too.
      "DROP TABLE IF EXISTS push_subscriptions",
    ],
  },
  {
    version: 3,
    description: "hot-read indexes: audit timestamp and goal member sessions",
    statements: [
      // #203: the audit route sorts the whole table newest-first behind a
      // display cap, so the timestamp ordering gets its own index.
      "CREATE INDEX IF NOT EXISTS idx_audit_events_at ON audit_events (at DESC, id DESC)",
      // #201: every hub/session event resolves its goal run through the
      // critic/judge member columns. Two single-column indexes, not one
      // composite: SQLite serves a composite only by leftmost prefix, so the
      // judge arm (WHERE judge_session_id = ?) would still scan.
      "CREATE INDEX IF NOT EXISTS idx_goal_runs_critic_session ON goal_runs (critic_session_id)",
      "CREATE INDEX IF NOT EXISTS idx_goal_runs_judge_session ON goal_runs (judge_session_id)",
    ],
  },
]

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce(
  (latest, migration) => Math.max(latest, migration.version),
  0,
)

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Applies pending migrations in order and stamps `PRAGMA user_version` in the
 * same transaction as their statements, so a failure rolls back both and the
 * database keeps its previous version. Reopening skips applied versions.
 *
 * Refuses a database written by a newer build: an older binary cannot know the
 * newer schema, and continuing would read or corrupt it silently.
 */
export function runMigrations(db: Database.Database, migrations: readonly Migration[] = MIGRATIONS): void {
  let previous = 0
  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version < 1) {
      throw new Error(`invalid SQLite migration version ${migration.version} (${migration.description})`)
    }
    if (migration.version <= previous) {
      throw new Error(
        `SQLite migrations must be unique and strictly increasing (${migration.description} repeats version ${migration.version})`,
      )
    }
    previous = migration.version
  }

  const latest = migrations.reduce((max, migration) => Math.max(max, migration.version), 0)
  const current = Number(db.pragma("user_version", { simple: true }))
  if (current > latest) {
    throw new Error(
      `masterhand database schema version ${current} is newer than this build supports (${latest}); ` +
        `upgrade MasterHand, or ${RESTORE_POINTER}`,
    )
  }

  let applied = current
  for (const migration of migrations) {
    if (migration.version <= applied) continue
    const apply = db.transaction(() => {
      for (const statement of migration.statements) db.exec(statement)
      // `user_version` lives in the database header, so SQLite rolls it back
      // with the statements if the transaction fails.
      db.pragma(`user_version = ${migration.version}`)
    })
    try {
      apply()
      applied = migration.version
    } catch (error) {
      throw new Error(
        `masterhand database migration ${migration.version} (${migration.description}) failed: ${errorMessage(error)}. ` +
          `The database is still at schema version ${applied}; fix the cause, or ${RESTORE_POINTER}`,
        { cause: error },
      )
    }
  }
}
