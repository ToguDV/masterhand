import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Database from "better-sqlite3"
import { describe, expect, it } from "vitest"
import { LATEST_SCHEMA_VERSION, MIGRATIONS, runMigrations } from "../src/migrations.js"
import type { Migration } from "../src/migrations.js"
import { backupDatabase, createSqliteStore, ensureDataDir } from "../src/store.js"
import { DATA_DIR_LOCK_FILE, acquireDataDirLock } from "../src/store.js"
import type { GoalRunRecord, ScheduledRun, ScheduledTask, Store } from "../src/store.js"

describe("sqlite device store", () => {
  it("persists, touches and removes devices", () => {
    const dir = mkdtempSync(join(tmpdir(), "masterhand-store-"))
    const store = createSqliteStore(join(dir, "test.sqlite"))
    try {
      const device = { id: "dev_1", name: "Laptop", installID: null, createdAt: 1, lastUsedAt: 1 }
      store.create(device)
      expect(store.get("dev_1")).toMatchObject({ name: "Laptop", installID: null })
      expect(store.list()).toHaveLength(1)

      store.touch("dev_1", 99)
      expect(store.get("dev_1")?.lastUsedAt).toBe(99)

      store.remove("dev_1")
      expect(store.get("dev_1")).toBeNull()
      expect(store.list()).toHaveLength(0)
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("looks devices up by install id and rejects a duplicate", () => {
    const dir = mkdtempSync(join(tmpdir(), "masterhand-store-"))
    const store = createSqliteStore(join(dir, "test.sqlite"))
    try {
      store.create({ id: "dev_1", name: "Phone", installID: "install-1", createdAt: 1, lastUsedAt: 1 })
      expect(store.getByInstallID("install-1")).toMatchObject({ id: "dev_1" })
      expect(store.getByInstallID("missing")).toBeNull()
      // Multiple legacy rows may have no install id; NULLs stay distinct.
      store.create({ id: "dev_2", name: "Tablet", installID: null, createdAt: 2, lastUsedAt: 2 })
      store.create({ id: "dev_3", name: "Laptop", installID: null, createdAt: 3, lastUsedAt: 3 })

      expect(() =>
        store.create({ id: "dev_4", name: "Clone", installID: "install-1", createdAt: 4, lastUsedAt: 4 }),
      ).toThrow(/UNIQUE/)
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("returns copies: mutating a fetched record without saving changes nothing", () => {
    // Regression test for #207: the deleted in-memory duplicate returned the
    // same object references it held, so `const x = getX(); mutate(x)` passed
    // in tests and lost data in production. SQLite returns copies — a caller
    // that forgets to save must see no change on the next read.
    const store = createSqliteStore(":memory:")
    try {
      store.create({ id: "dev_1", name: "Laptop", installID: null, createdAt: 1, lastUsedAt: 1 })
      const device = store.get("dev_1")!
      device.name = "Mutated without save"
      expect(store.get("dev_1")?.name).toBe("Laptop")

      store.saveGoalRun({
        sessionID: "ses_goal",
        runToken: "token_1",
        goal: "Ship it",
        state: "running",
        round: 1,
        maxRounds: 5,
        mainModel: "test/model",
        criticModel: null,
        judgeModel: null,
        criticSessionID: null,
        judgeSessionID: null,
        lastReport: null,
        lastCritique: null,
        lastVerdict: null,
        history: [],
        error: null,
        awaitingKind: null,
        awaitingSessionID: null,
        awaitingAssistantID: null,
        attempt: 0,
        nudged: false,
        lastError: null,
        pausedPhase: null,
        promptSerial: 0,
        createdAt: 1,
        updatedAt: 1,
      })
      const run = store.getGoalRun("ses_goal")!
      run.goal = "Mutated without save"
      run.history.push({ round: 99, critique: null, verdict: null })
      const reread = store.getGoalRun("ses_goal")!
      expect(reread.goal).toBe("Ship it")
      expect(reread.history).toEqual([])
    } finally {
      store.close()
    }
  })
})

describe("private data permissions", () => {
  const modeOf = (path: string): number => statSync(path).mode & 0o777

  it("creates the data directory as 0700 and tightens an existing one", () => {
    const parent = mkdtempSync(join(tmpdir(), "masterhand-modes-"))
    try {
      const dir = join(parent, "data")
      ensureDataDir(dir)
      expect(modeOf(dir)).toBe(0o700)

      chmodSync(dir, 0o755)
      ensureDataDir(dir)
      expect(modeOf(dir)).toBe(0o700)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it("boots a native data dir with a 0600 database and backup", () => {
    const parent = mkdtempSync(join(tmpdir(), "masterhand-modes-"))
    const dir = join(parent, "data")
    const source = join(dir, "masterhand.sqlite")
    const destination = join(dir, "backup.sqlite")
    try {
      ensureDataDir(dir)
      const store = createSqliteStore(source)
      try {
        store.create({ id: "dev_1", name: "Laptop", installID: null, createdAt: 1, lastUsedAt: 1 })
        backupDatabase(source, destination)
        expect(modeOf(source)).toBe(0o600)
        expect(modeOf(`${source}-wal`)).toBe(0o600)
        expect(modeOf(`${source}-shm`)).toBe(0o600)
      } finally {
        store.close()
      }
      expect(modeOf(dir)).toBe(0o700)
      expect(modeOf(destination)).toBe(0o600)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it("tightens a database created earlier with a permissive mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "masterhand-modes-"))
    const source = join(dir, "legacy.sqlite")
    try {
      const legacy = new Database(source)
      legacy.exec("CREATE TABLE legacy (id INTEGER)")
      legacy.close()
      chmodSync(source, 0o644)

      const store = createSqliteStore(source)
      try {
        store.create({ id: "dev_1", name: "Laptop", installID: null, createdAt: 1, lastUsedAt: 1 })
        expect(modeOf(source)).toBe(0o600)
        expect(modeOf(`${source}-wal`)).toBe(0o600)
        expect(modeOf(`${source}-shm`)).toBe(0o600)
      } finally {
        store.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("sqlite integrity and backup", () => {
  it("reports readiness and backs up a live database", () => {
    const dir = mkdtempSync(join(tmpdir(), "masterhand-store-"))
    const source = join(dir, "test.sqlite")
    const store = createSqliteStore(source)
    try {
      expect(store.ping()).toBe(true)
      store.create({ id: "dev_1", name: "Laptop", installID: null, createdAt: 1, lastUsedAt: 1 })

      const destination = join(dir, "backup.sqlite")
      backupDatabase(source, destination)

      const restored = createSqliteStore(destination)
      try {
        expect(restored.get("dev_1")).toMatchObject({ name: "Laptop" })
      } finally {
        restored.close()
      }
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("fails loudly at boot when the file is not a database", () => {
    const dir = mkdtempSync(join(tmpdir(), "masterhand-store-"))
    try {
      const corrupt = join(dir, "corrupt.sqlite")
      writeFileSync(corrupt, "this is not a sqlite database")
      let error: unknown
      try {
        createSqliteStore(corrupt)
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toMatch(/failed its integrity check/)
      expect((error as Error).message).toContain("docs/runbooks/backups.md")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("sqlite schema migrations", () => {
  const tempDir = (): string => mkdtempSync(join(tmpdir(), "masterhand-migrations-"))

  it("stamps a fresh database with the latest schema version", () => {
    const dir = tempDir()
    const file = join(dir, "test.sqlite")
    try {
      const store = createSqliteStore(file)
      store.close()

      const db = new Database(file)
      try {
        expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION)
      } finally {
        db.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("adopts a pre-versioning database without losing its data", () => {
    const dir = tempDir()
    const file = join(dir, "legacy.sqlite")
    try {
      // A database created before versioning existed: no user_version, but a
      // populated table and the obsolete push_subscriptions one.
      const legacy = new Database(file)
      legacy.exec(`
        CREATE TABLE devices (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          last_used_at INTEGER NOT NULL
        )
      `)
      legacy.exec("CREATE TABLE push_subscriptions (id INTEGER PRIMARY KEY)")
      legacy.exec("INSERT INTO devices (id, name, created_at, last_used_at) VALUES ('dev_1', 'Laptop', 1, 1)")
      expect(legacy.pragma("user_version", { simple: true })).toBe(0)
      legacy.close()

      const store = createSqliteStore(file)
      try {
        expect(store.get("dev_1")).toMatchObject({ name: "Laptop" })
      } finally {
        store.close()
      }

      const db = new Database(file)
      try {
        expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION)
        expect(
          db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'push_subscriptions'").get(),
        ).toBeUndefined()
      } finally {
        db.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("upgrades a v1 database to the install id schema without losing data", () => {
    const dir = tempDir()
    const file = join(dir, "v1.sqlite")
    try {
      // A real v1 database: every baseline statement already applied and the
      // version stamped. The obsolete table is re-created on top to prove the
      // upgrade cleans it instead of trusting the old baseline's drop.
      const v1 = new Database(file)
      try {
        for (const statement of MIGRATIONS[0]!.statements) v1.exec(statement)
        v1.exec("CREATE TABLE push_subscriptions (id INTEGER PRIMARY KEY)")
        v1.exec("INSERT INTO devices (id, name, created_at, last_used_at) VALUES ('dev_1', 'Laptop', 1, 1)")
        v1.exec(
          "INSERT INTO workspaces (id, name, path, created_at) VALUES ('ws_1', 'App', '/workspace/app', 1)",
        )
        v1.pragma("user_version = 1")
      } finally {
        v1.close()
      }

      const store = createSqliteStore(file)
      try {
        expect(store.get("dev_1")).toMatchObject({ name: "Laptop", installID: null })
        expect(store.getWorkspace("ws_1")).toMatchObject({ name: "App", path: "/workspace/app" })
      } finally {
        store.close()
      }

      const db = new Database(file)
      try {
        expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION)
        const columns = db.pragma("table_info(devices)") as { name: string }[]
        expect(columns.map((column) => column.name)).toContain("install_id")
        expect(
          db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'push_subscriptions'").get(),
        ).toBeUndefined()
        const index = db
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_devices_install_id'")
          .get() as { sql: string } | undefined
        expect(index?.sql).toMatch(/UNIQUE/i)
      } finally {
        db.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("upgrades a v2 database to the v3 data indexes without losing data", () => {
    const dir = mkdtempSync(join(tmpdir(), "masterhand-store-"))
    const file = join(dir, "v2.sqlite")
    try {
      // A real v2 database: baseline + install-id statements applied and the
      // version stamped, then populated on both tables v3 indexes.
      const v2 = new Database(file)
      try {
        for (const statement of MIGRATIONS[0]!.statements) v2.exec(statement)
        for (const statement of MIGRATIONS[1]!.statements) v2.exec(statement)
        v2.exec("INSERT INTO devices (id, name, created_at, last_used_at) VALUES ('dev_1', 'Laptop', 1, 1)")
        v2.exec(
          "INSERT INTO audit_events (at, session_id, workspace_id, kind, command, reason, source) " +
            `VALUES (${Date.now()}, 'ses_1', NULL, 'permission_denied', 'pkill -f node', 'denied', 'opencode')`,
        )
        v2.exec(
          "INSERT INTO goal_runs (session_id, goal, state, round, max_rounds, critic_session_id, judge_session_id, history, created_at, updated_at) " +
            "VALUES ('ses_goal', 'ship it', 'running', 1, 3, 'ses_critic', 'ses_judge', '[]', 1, 2)",
        )
        v2.pragma("user_version = 2")
      } finally {
        v2.close()
      }

      const store = createSqliteStore(file)
      try {
        expect(store.get("dev_1")).toMatchObject({ name: "Laptop" })
        expect(store.listAudit(10).map((entry) => entry.command)).toEqual(["pkill -f node"])
        expect(store.getGoalRun("ses_goal")).toMatchObject({
          criticSessionID: "ses_critic",
          judgeSessionID: "ses_judge",
        })
      } finally {
        store.close()
      }

      const db = new Database(file)
      try {
        expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION)
        for (const name of ["idx_audit_events_at", "idx_goal_runs_critic_session", "idx_goal_runs_judge_session"]) {
          expect(
            db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(name),
            `missing index ${name}`,
          ).toBeDefined()
        }
      } finally {
        db.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("does not re-run migrations that were already applied", () => {
    const dir = tempDir()
    const file = join(dir, "test.sqlite")
    const applied: Migration[] = [
      {
        version: 1,
        description: "create the counter table",
        statements: ["CREATE TABLE counter (value INTEGER NOT NULL)", "INSERT INTO counter (value) VALUES (1)"],
      },
    ]
    // If reopening replayed the applied version, this statement would throw:
    // there is no missing_table.
    const replay: Migration[] = [
      {
        version: 1,
        description: "must never run twice",
        statements: ["INSERT INTO missing_table (value) VALUES (1)"],
      },
    ]
    try {
      const first = new Database(file)
      runMigrations(first, applied)
      expect(first.pragma("user_version", { simple: true })).toBe(1)
      first.close()

      const reopened = new Database(file)
      try {
        expect(() => runMigrations(reopened, replay)).not.toThrow()
        expect(reopened.prepare("SELECT value FROM counter").pluck().get()).toBe(1)
      } finally {
        reopened.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("refuses a database written by a newer schema with the restore pointer", () => {
    const dir = tempDir()
    const file = join(dir, "future.sqlite")
    const newer = LATEST_SCHEMA_VERSION + 1
    try {
      const future = new Database(file)
      future.pragma(`user_version = ${newer}`)
      future.close()

      let error: unknown
      try {
        createSqliteStore(file)
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toMatch(new RegExp(`schema version ${newer} is newer`))
      expect((error as Error).message).toContain("docs/runbooks/backups.md")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rolls back a failed migration and keeps the previous version", () => {
    const dir = tempDir()
    const file = join(dir, "test.sqlite")
    const migrations: Migration[] = [
      { version: 1, description: "baseline", statements: ["CREATE TABLE applied (id INTEGER)"] },
      {
        version: 2,
        description: "broken",
        statements: [
          "CREATE TABLE partial (id INTEGER)",
          "ALTER TABLE applied ADD COLUMN extra TEXT",
          "INSERT INTO missing_table (id) VALUES (1)",
        ],
      },
    ]
    try {
      const db = new Database(file)
      try {
        let error: unknown
        try {
          runMigrations(db, migrations)
        } catch (caught) {
          error = caught
        }
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toMatch(/migration 2/)
        expect((error as Error).message).toContain("docs/runbooks/backups.md")

        expect(db.pragma("user_version", { simple: true })).toBe(1)
        expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'partial'").get()).toBeUndefined()
        expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'applied'").get()).toBeDefined()
        const columns = db.pragma("table_info(applied)") as { name: string }[]
        expect(columns.map((column) => column.name)).not.toContain("extra")
      } finally {
        db.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("exposes ordered, unique migration versions up to the latest", () => {
    expect(MIGRATIONS.length).toBeGreaterThan(0)
    expect(MIGRATIONS.map((migration) => migration.version)).toEqual(
      Array.from({ length: LATEST_SCHEMA_VERSION }, (_, index) => index + 1),
    )
  })
})

describe("sqlite workspace store", () => {
  it("persists, looks up and removes workspaces", () => {
    const dir = mkdtempSync(join(tmpdir(), "masterhand-store-"))
    const store = createSqliteStore(join(dir, "test.sqlite"))
    try {
      store.createWorkspace({ id: "ws_1", name: "App", path: "/workspace/app", createdAt: 1 })
      store.createWorkspace({ id: "ws_2", name: "Lib", path: "/workspace/lib", createdAt: 2 })
      store.saveWorkspaceRun({
        workspaceID: "ws_1",
        command: "npm",
        args: ["run", "dev"],
        cwd: null,
        source: "user",
        updatedAt: 1,
      })

      expect(store.listWorkspaces().map((workspace) => workspace.id)).toEqual(["ws_1", "ws_2"])
      expect(store.getWorkspace("ws_1")).toMatchObject({ name: "App" })
      expect(store.getWorkspaceByPath("/workspace/app")?.id).toBe("ws_1")
      expect(store.getWorkspaceByPath("/workspace/missing")).toBeNull()

      store.removeWorkspace("ws_1")
      expect(store.getWorkspace("ws_1")).toBeNull()
      expect(store.getWorkspaceRun("ws_1")).toBeNull()
      expect(store.listWorkspaces()).toHaveLength(1)
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("isolated session store", () => {
  function isolatedSessionScenario(store: Store): void {
    store.createIsolatedSession({
      sessionID: "ses_1",
      workspaceID: "ws_1",
      path: "/workspace/.worktrees/app/abc",
      branch: "masterhand/app-abc",
      baseRef: "main",
      pushed: false,
      // A row written by an older build: a compare URL was stored as the PR.
      prUrl: "https://github.com/org/repo/compare/main...masterhand%2Fapp-abc?expand=1",
      createdAt: 1,
    })

    // First successful finish replaces the non-authoritative URL and sets pushed.
    store.updateIsolatedSession("ses_1", {
      pushed: true,
      prUrl: "https://github.com/org/repo/pull/1",
      replacePrUrl: true,
    })
    expect(store.getIsolatedSession("ses_1")).toMatchObject({
      pushed: true,
      prUrl: "https://github.com/org/repo/pull/1",
    })

    // A later attempt cannot downgrade the push or overwrite the real PR URL.
    store.updateIsolatedSession("ses_1", {
      pushed: false,
      prUrl: "https://github.com/org/repo/pull/2",
    })
    expect(store.getIsolatedSession("ses_1")).toMatchObject({
      pushed: true,
      prUrl: "https://github.com/org/repo/pull/1",
    })
  }

  it("keeps the first real PR URL and never downgrades pushed in sqlite", () => {
    const dir = mkdtempSync(join(tmpdir(), "masterhand-store-"))
    const store = createSqliteStore(join(dir, "test.sqlite"))
    try {
      isolatedSessionScenario(store)
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("audit store", () => {
  const event = {
    at: 1,
    sessionID: "ses_1",
    workspaceID: null,
    kind: "permission_denied" as const,
    command: "pkill -f node",
    reason: "Permission denied: shell",
    source: "opencode" as const,
  }

  it("records, lists newest-first and clears in sqlite", () => {
    const dir = mkdtempSync(join(tmpdir(), "masterhand-store-"))
    const store = createSqliteStore(join(dir, "test.sqlite"))
    try {
      // Fresh timestamps: the 30-day retention prunes ancient rows on write.
      const now = Date.now()
      store.recordAudit({ ...event, at: now, command: "first" })
      store.recordAudit({ ...event, at: now, command: "second" })

      expect(store.listAudit().map((entry) => entry.command)).toEqual(["second", "first"])
      expect(store.listAudit(1)).toHaveLength(1)
      expect(store.listAudit()[0]?.id).toBeGreaterThan(store.listAudit()[1]?.id ?? 0)

      store.clearAudit()
      expect(store.listAudit()).toHaveLength(0)
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("serves the newest-first audit list through the timestamp index", () => {
    const dir = mkdtempSync(join(tmpdir(), "masterhand-store-"))
    const file = join(dir, "test.sqlite")
    const store = createSqliteStore(file)
    try {
      store.recordAudit({ ...event, at: Date.now() })
    } finally {
      store.close()
    }
    const db = new Database(file)
    try {
      const plan = (
        db
          .prepare("EXPLAIN QUERY PLAN SELECT id FROM audit_events ORDER BY at DESC, id DESC LIMIT ?")
          .all(100) as { detail: string }[]
      )
        .map((row) => row.detail)
        .join("\n")
      expect(plan).toContain("idx_audit_events_at")
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("retains only the newest 10000 audit rows on write", () => {
    const dir = mkdtempSync(join(tmpdir(), "masterhand-store-"))
    const store = createSqliteStore(join(dir, "test.sqlite"))
    try {
      const now = Date.now()
      for (let index = 0; index < 10_050; index += 1) {
        store.recordAudit({ ...event, at: now - 10_050 + index, command: `command-${index}` })
      }
      const rows = store.listAudit(20_000)
      expect(rows).toHaveLength(10_000)
      expect(rows[0]?.command).toBe("command-10049")
      expect(rows[rows.length - 1]?.command).toBe("command-50")
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("prunes audit rows older than 30 days on write", () => {
    const dir = mkdtempSync(join(tmpdir(), "masterhand-store-"))
    const store = createSqliteStore(join(dir, "test.sqlite"))
    const DAY_MS = 24 * 60 * 60 * 1000
    try {
      const now = Date.now()
      store.recordAudit({ ...event, at: now - 31 * DAY_MS, command: "ancient" })
      store.recordAudit({ ...event, at: now, command: "fresh" })
      expect(store.listAudit(100).map((entry) => entry.command)).toEqual(["fresh"])
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("workspace run store", () => {
  const run = {
    workspaceID: "ws_1",
    command: "npm",
    args: ["run", "dev"],
    cwd: null,
    source: "user" as const,
    updatedAt: 1,
  }

  it("persists, reads and removes a run config in sqlite", () => {
    const dir = mkdtempSync(join(tmpdir(), "masterhand-store-"))
    const store = createSqliteStore(join(dir, "test.sqlite"))
    try {
      store.saveWorkspaceRun(run)
      expect(store.getWorkspaceRun("ws_1")).toEqual(run)
      store.removeWorkspaceRun("ws_1")
      expect(store.getWorkspaceRun("ws_1")).toBeNull()
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reads a corrupt args column as an empty list", () => {
    const dir = mkdtempSync(join(tmpdir(), "masterhand-store-"))
    const file = join(dir, "test.sqlite")
    const store = createSqliteStore(file)
    store.saveWorkspaceRun(run)
    store.close()

    const raw = new Database(file)
    raw.prepare("UPDATE workspace_runs SET args = ? WHERE workspace_id = ?").run("{not json", "ws_1")
    raw.close()

    const reopened = createSqliteStore(file)
    try {
      expect(reopened.getWorkspaceRun("ws_1")?.args).toEqual([])
    } finally {
      reopened.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("preview port store", () => {
  it("persists reserved preview ports in sqlite", () => {
    const dir = mkdtempSync(join(tmpdir(), "masterhand-store-"))
    const store = createSqliteStore(join(dir, "test.sqlite"))
    try {
      store.assignPreviewPort({ sessionID: "ses_1", port: 3200, createdAt: 1 })
      store.assignPreviewPort({ sessionID: "ses_2", port: 3201, createdAt: 2 })

      expect(store.getPreviewPort("ses_1")).toBe(3200)
      expect(store.listPreviewPorts().map((record) => record.sessionID)).toEqual(["ses_1", "ses_2"])

      store.removePreviewPort("ses_1")
      expect(store.getPreviewPort("ses_1")).toBeNull()
      expect(store.listPreviewPorts()).toHaveLength(1)
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects a port reserved by another session and keeps the first row (sqlite)", () => {
    const dir = mkdtempSync(join(tmpdir(), "masterhand-store-"))
    const store = createSqliteStore(join(dir, "test.sqlite"))
    try {
      const first = { sessionID: "ses_1", port: 3200, createdAt: 1 }
      store.assignPreviewPort(first)

      expect(() =>
        store.assignPreviewPort({ sessionID: "ses_2", port: 3200, createdAt: 2 }),
      ).toThrow(/UNIQUE/i)

      expect(store.getPreviewPort("ses_1")).toBe(3200)
      expect(store.getPreviewPort("ses_2")).toBeNull()
      expect(store.listPreviewPorts()).toEqual([first])
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("keeps the original reservation for a repeated same-session assignment (sqlite)", () => {
    const dir = mkdtempSync(join(tmpdir(), "masterhand-store-"))
    const store = createSqliteStore(join(dir, "test.sqlite"))
    try {
      const first = { sessionID: "ses_1", port: 3200, createdAt: 1 }
      store.assignPreviewPort(first)

      // A replay must not move the session to another port or refresh created_at.
      expect(store.assignPreviewPort({ sessionID: "ses_1", port: 3201, createdAt: 2 })).toEqual(first)
      expect(store.getPreviewPort("ses_1")).toBe(3200)
      expect(store.listPreviewPorts()).toEqual([first])
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Scheduled tasks and their runs
// ---------------------------------------------------------------------------

function scheduledTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "task_1",
    name: "Nightly check",
    prompt: "check the build",
    model: { providerID: "prov", id: "model-a", variant: "low" },
    schedule: { kind: "cron", cron: "0 9 * * *" },
    timezone: "Europe/Madrid",
    directory: "/workspace/app",
    paused: false,
    lastRunAt: null,
    nextRunAt: "2026-06-01T21:00:00.000Z",
    createdAt: "2026-06-01T06:00:00.000Z",
    ...overrides,
  }
}

function scheduledRun(overrides: Partial<ScheduledRun> = {}): ScheduledRun {
  return {
    id: "run_1",
    taskId: "task_1",
    sessionID: "ses_1",
    status: "completed",
    source: "schedule",
    error: null,
    startedAt: "2026-06-01T08:00:00.000Z",
    endedAt: "2026-06-01T08:01:00.000Z",
    ...overrides,
  }
}

/** The round-trip, ordering, active-run and cascade contract, store-agnostic. */
function scheduledStoreScenario(store: Store): void {
  // Create + read back with full fidelity for both task shapes.
  store.createScheduledTask(scheduledTask({ id: "task_a", schedule: { kind: "interval", intervalMinutes: 30 } }))
  store.createScheduledTask(scheduledTask({ id: "task_b" }))
  expect(store.getScheduledTask("task_a")).toEqual(
    scheduledTask({ id: "task_a", schedule: { kind: "interval", intervalMinutes: 30 } }),
  )
  expect(store.getScheduledTask("task_b")).toEqual(scheduledTask({ id: "task_b" }))
  expect(store.getScheduledTask("nope")).toBeNull()

  // Listing is chronological by creation; save upserts the whole record.
  expect(store.listScheduledTasks().map((task) => task.id)).toEqual(["task_a", "task_b"])
  store.saveScheduledTask(scheduledTask({ id: "task_b", paused: true }))
  expect(store.getScheduledTask("task_b")?.paused).toBe(true)

  // Runs: insert out of order, read newest-first; the task filter applies.
  store.createScheduledRun(
    scheduledRun({ id: "run_old", taskId: "task_b", startedAt: "2026-06-01T07:00:00.000Z" }),
  )
  store.createScheduledRun(
    scheduledRun({
      id: "run_new",
      taskId: "task_b",
      startedAt: "2026-06-01T09:00:00.000Z",
      status: "running",
    }),
  )
  expect(store.listScheduledRuns("task_b").map((run) => run.id)).toEqual(["run_new", "run_old"])
  expect(store.listScheduledRuns("task_missing")).toEqual([])
  expect(store.getScheduledRun("run_new")).toMatchObject({ id: "run_new", status: "running" })
  expect(store.getScheduledRun("nope")).toBeNull()

  // Active-run lookups ignore terminal statuses and keep the newest one.
  expect(store.getActiveScheduledRun("task_b")).toMatchObject({ id: "run_new", status: "running" })
  store.saveScheduledRun(scheduledRun({ id: "run_new", taskId: "task_b" }))
  expect(store.getActiveScheduledRun("task_b")).toBeNull()
  store.createScheduledRun(
    scheduledRun({
      id: "run_queued",
      taskId: "task_b",
      startedAt: "2026-06-01T09:30:00.000Z",
      status: "queued",
      sessionID: null,
      endedAt: null,
    }),
  )
  expect(store.getActiveScheduledRun("task_b")).toMatchObject({ id: "run_queued" })
  expect(store.getActiveScheduledRun("task_a")).toBeNull()
  expect(store.listActiveScheduledRuns().map((run) => run.id)).toEqual(["run_queued"])

  // Deleting a task takes its runs with it (cascade).
  store.deleteScheduledTask("task_b")
  expect(store.getScheduledTask("task_b")).toBeNull()
  expect(store.getScheduledRun("run_queued")).toBeNull()
  expect(store.listScheduledRuns("task_b")).toEqual([])
}

describe("goal member projections", () => {
  function bigRun(sessionID: string): GoalRunRecord {
    const filler = (prefix: string): string => Array.from({ length: 50 }, (_, index) => `${prefix}-${index}`).join(",")
    return {
      sessionID,
      runToken: `token_${sessionID}`,
      goal: "Make the suite green",
      state: "critiquing",
      round: 2,
      maxRounds: 5,
      mainModel: "test/test-model",
      criticModel: "test/critic-model",
      judgeModel: "test/judge-model",
      criticSessionID: "ses_critic",
      judgeSessionID: "ses_judge",
      lastReport: { summary: filler("report") } as unknown as GoalRunRecord["lastReport"],
      lastCritique: { summary: filler("critique") } as unknown as GoalRunRecord["lastCritique"],
      lastVerdict: { approved: false, reasoning: filler("verdict") } as unknown as GoalRunRecord["lastVerdict"],
      history: Array.from({ length: 200 }, (_, index) => ({
        round: index,
        critique: { summary: filler(`history-${index}`) },
        verdict: { approved: false, reasoning: "because" },
      })) as unknown as GoalRunRecord["history"],
      error: null,
      awaitingKind: "critic",
      awaitingSessionID: "ses_critic",
      awaitingAssistantID: "msg_1",
      attempt: 0,
      nudged: false,
      lastError: null,
      pausedPhase: null,
      promptSerial: 3,
      createdAt: 1,
      updatedAt: 2,
    }
  }

  function memberScenario(store: Store): void {
    store.saveGoalRun(bigRun("ses_main"))
    // Narrow member hits resolve without blobs or JSON parsing.
    expect(store.findGoalRunByMemberSession("ses_critic")).toEqual({
      sessionID: "ses_main",
      criticSessionID: "ses_critic",
      judgeSessionID: "ses_judge",
    })
    expect(store.findGoalRunByMemberSession("ses_judge")).toEqual({
      sessionID: "ses_main",
      criticSessionID: "ses_critic",
      judgeSessionID: "ses_judge",
    })
    expect(store.findGoalRunByMemberSession("ses_main")).toBeNull()
    expect(store.findGoalRunByMemberSession("ses_unknown")).toBeNull()
    expect(store.listGoalRunMembers()).toEqual([
      { sessionID: "ses_main", criticSessionID: "ses_critic", judgeSessionID: "ses_judge" },
    ])
  }

  it("resolves members through narrow projections in sqlite", () => {
    const dir = mkdtempSync(join(tmpdir(), "masterhand-store-"))
    const store = createSqliteStore(join(dir, "test.sqlite"))
    try {
      memberScenario(store)
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("scheduled run history limits", () => {
  function seedRuns(store: Store, taskId: string, count: number): void {
    for (let index = 0; index < count; index += 1) {
      store.createScheduledRun(
        scheduledRun({
          id: `run_${index}`,
          taskId,
          startedAt: new Date(Date.UTC(2026, 5, 1, 0, 0, index)).toISOString(),
        }),
      )
    }
  }

  function historyScenario(store: Store): void {
    seedRuns(store, "task_h", 5)
    // SQL-level pagination: newest first, limit then offset.
    expect(store.listScheduledRuns("task_h", { limit: 2 }).map((run) => run.id)).toEqual(["run_4", "run_3"])
    expect(store.listScheduledRuns("task_h", { limit: 2, offset: 2 }).map((run) => run.id)).toEqual([
      "run_2",
      "run_1",
    ])
    expect(store.listScheduledRuns("task_h", { limit: 2, offset: 4 }).map((run) => run.id)).toEqual(["run_0"])
    // The default keeps today's visible behavior: newest 50.
    expect(store.listScheduledRuns("task_h").map((run) => run.id)).toEqual([
      "run_4",
      "run_3",
      "run_2",
      "run_1",
      "run_0",
    ])
  }

  it("pages run history with limit/offset in sqlite", () => {
    const dir = mkdtempSync(join(tmpdir(), "masterhand-store-"))
    const store = createSqliteStore(join(dir, "test.sqlite"))
    try {
      historyScenario(store)
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function retentionScenario(store: Store): void {
    seedRuns(store, "task_r", 205)
    const rows = store.listScheduledRuns("task_r", { limit: 1000 })
    expect(rows).toHaveLength(200)
    expect(rows[0]?.id).toBe("run_204")
    expect(rows[rows.length - 1]?.id).toBe("run_5")
  }

  it("retains only the newest 200 runs per task in sqlite", () => {
    const dir = mkdtempSync(join(tmpdir(), "masterhand-store-"))
    const store = createSqliteStore(join(dir, "test.sqlite"))
    try {
      retentionScenario(store)
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("prunes run rows on status-update saves too", () => {
    // The fire path persists its firing row through saveScheduledRun, not
    // createScheduledRun: without a prune there the history grows past the
    // keep-N policy on every fire.
    const dir = mkdtempSync(join(tmpdir(), "masterhand-store-"))
    const store = createSqliteStore(join(dir, "test.sqlite"))
    try {
      for (let index = 0; index < 200; index += 1) {
        store.createScheduledRun(
          scheduledRun({
            id: `run_${index}`,
            taskId: "task_s",
            startedAt: new Date(Date.UTC(2026, 5, 1, 0, 0, index)).toISOString(),
          }),
        )
      }
      store.saveScheduledRun(
        scheduledRun({
          id: "run_firing",
          taskId: "task_s",
          status: "firing",
          startedAt: new Date(Date.UTC(2026, 5, 2)).toISOString(),
        }),
      )
      const rows = store.listScheduledRuns("task_s", { limit: 1000 })
      expect(rows).toHaveLength(200)
      expect(rows[0]?.id).toBe("run_firing")
      // A 201st row would hide behind the 200-page cap: the second page tells
      // whether the save pruned (empty) or not ([run_0]).
      expect(store.listScheduledRuns("task_s", { limit: 200, offset: 200 })).toEqual([])
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("scheduled task store", () => {
  it("persists scheduled tasks and runs in sqlite", () => {
    const dir = mkdtempSync(join(tmpdir(), "masterhand-store-"))
    const store = createSqliteStore(join(dir, "test.sqlite"))
    try {
      scheduledStoreScenario(store)
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reads corrupt scheduled rows inertly", () => {
    const dir = mkdtempSync(join(tmpdir(), "masterhand-store-"))
    const file = join(dir, "test.sqlite")
    const store = createSqliteStore(file)
    try {
      store.createScheduledTask(scheduledTask({ id: "task_x" }))
      store.createScheduledRun(scheduledRun({ id: "run_x", taskId: "task_x" }))
      store.createScheduledRun(
        scheduledRun({ id: "run_y", taskId: "task_x", startedAt: "2026-06-02T09:00:00.000Z" }),
      )
    } finally {
      store.close()
    }

    // Sabotage the JSON columns and status values with raw SQL, the way a
    // partially-written or hand-edited database would look.
    const db = new Database(file)
    try {
      db.exec(`UPDATE scheduled_tasks SET
                 model = 'not json',
                 schedule = '{broken',
                 paused = 1,
                 name = 42
               WHERE id = 'task_x'`)
      db.exec(`UPDATE scheduled_runs SET
                 session_id = NULL,
                 error = 42,
                 status = 'weird'
               WHERE id = 'run_x'`)
      db.exec(`INSERT INTO scheduled_runs (id, task_id, session_id, status, source, error, started_at, ended_at)
               VALUES ('run_garbage', 'task_x', 'ses_9', 'weird', 'schedule', NULL, 42, NULL)`)
    } finally {
      db.close()
    }

    const reopened = createSqliteStore(file)
    try {
      // Tolerant normalization: garbage degrades to inert defaults, never throws.
      const task = reopened.getScheduledTask("task_x")
      expect(task).toEqual(
        scheduledTask({
          id: "task_x",
          // TEXT affinity stringified the sabotage value; it reads back.
          name: "42",
          schedule: { kind: "interval", intervalMinutes: 0 },
          model: { providerID: "", id: "" },
          paused: true,
        }),
      )
      const weird = reopened.getScheduledRun("run_x")!
      expect(weird).toMatchObject({ id: "run_x", sessionID: null, error: "42", status: "weird" })
      const garbage = reopened.getScheduledRun("run_garbage")!
      expect(garbage).toMatchObject({ id: "run_garbage", startedAt: "42", endedAt: null, status: "weird" })

      // Unknown statuses are inert for liveness SQL: they never block new fires.
      expect(reopened.getActiveScheduledRun("task_x")).toBeNull()
      expect(reopened.listActiveScheduledRuns()).toEqual([])
    } finally {
      reopened.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("data directory lock (issue #208)", () => {
  it("refuses a second holder while the first is live", async () => {
    const dir = mkdtempSync(join(tmpdir(), "masterhand-lock-"))
    try {
      const first = await acquireDataDirLock(dir)
      try {
        await expect(acquireDataDirLock(dir)).rejects.toThrow(
          new RegExp(`another instance owns ${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
        )
      } finally {
        await first.release()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("re-acquires after release", async () => {
    const dir = mkdtempSync(join(tmpdir(), "masterhand-lock-"))
    try {
      const first = await acquireDataDirLock(dir)
      await first.release()
      const second = await acquireDataDirLock(dir)
      try {
        await expect(acquireDataDirLock(dir)).rejects.toThrow(/another instance owns/)
      } finally {
        await second.release()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reclaims a stale rendezvous left by a crash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "masterhand-lock-"))
    try {
      // No listener behind it, like a lock file surviving SIGKILL.
      writeFileSync(join(dir, DATA_DIR_LOCK_FILE), "stale\n")
      const lock = await acquireDataDirLock(dir)
      try {
        await expect(acquireDataDirLock(dir)).rejects.toThrow(/another instance owns/)
      } finally {
        await lock.release()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("keeps the rendezvous owner-only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "masterhand-lock-"))
    try {
      const lock = await acquireDataDirLock(dir)
      try {
        const mode = statSync(join(dir, DATA_DIR_LOCK_FILE)).mode & 0o777
        expect(mode & 0o077).toBe(0)
      } finally {
        await lock.release()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("online backup", () => {
  it("writes a restorable 0600 snapshot without closing the live store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "masterhand-backup-"))
    const store = createSqliteStore(join(dir, "live.sqlite"))
    try {
      store.createWorkspace({ id: "ws_1", name: "App", path: join(dir, "app"), createdAt: 1 })
      const destination = join(dir, "backups", "pre-update.sqlite")
      await store.backup(destination)

      expect(statSync(destination).mode & 0o777).toBe(0o600)
      const restored = createSqliteStore(destination)
      try {
        expect(restored.listWorkspaces()).toMatchObject([{ id: "ws_1", name: "App" }])
      } finally {
        restored.close()
      }
      // The live store remains usable after the online backup.
      expect(store.listWorkspaces()).toHaveLength(1)
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
