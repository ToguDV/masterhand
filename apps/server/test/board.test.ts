import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { createSqliteStore, type Store } from "../src/store.js"

/**
 * Counts executions of the column-scoped card SELECTs (#211): the snapshot
 * used to run one card query per column (N+1) and must now run exactly one.
 * The mock subclasses the real Database, so every other test in this file
 * keeps exercising the true engine.
 */
const boardCardReads = (): number =>
  (globalThis as { __boardCardReads?: number }).__boardCardReads ?? 0
const resetBoardCardReads = (): void => {
  ;(globalThis as { __boardCardReads?: number }).__boardCardReads = 0
}

vi.mock("better-sqlite3", async (importOriginal) => {
  const mod = (await importOriginal()) as unknown as {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    default: new (...args: never[]) => { prepare(source: string): any }
  }
  const Actual = mod.default
  class CountingDatabase extends Actual {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    override prepare(source: string): any {
      const statement = super.prepare(source)
      if (/FROM\s+board_cards/i.test(source) && /column_id/i.test(source)) {
        for (const method of ["get", "all", "run"] as const) {
          const original = statement[method].bind(statement)
          statement[method] = (...args: unknown[]) => {
            const state = globalThis as { __boardCardReads?: number }
            state.__boardCardReads = (state.__boardCardReads ?? 0) + 1
            return original(...args)
          }
        }
      }
      return statement
    }
  }
  return { ...mod, default: CountingDatabase }
})

function stores(): Array<{ name: string; make: () => Store; close: (store: Store) => void }> {
  return [
    {
      // In-memory SQLite: same engine as production, no filesystem involved.
      name: "sqlite-memory",
      make: () => createSqliteStore(":memory:"),
      close: (store) => store.close(),
    },
    {
      name: "sqlite-file",
      make: () => {
        const dir = mkdtempSync(join(tmpdir(), "masterhand-board-"))
        const store = createSqliteStore(join(dir, "test.sqlite"))
        // @ts-expect-error test cleanup hook
        store.__dir = dir
        return store
      },
      close: (store) => {
        store.close()
        // @ts-expect-error test cleanup hook
        rmSync(store.__dir, { recursive: true, force: true })
      },
    },
  ]
}

describe.each(stores())("board store ($name)", ({ make, close }) => {
  it("reindexes columns sequentially on create/move/delete", () => {
    const store = make()
    try {
      store.createWorkspace({ id: "ws_1", name: "App", path: "/w/app", createdAt: 1 })
      store.createBoardColumn({ id: "col_a", workspaceID: "ws_1", title: "A" })
      store.createBoardColumn({ id: "col_b", workspaceID: "ws_1", title: "B" })
      store.createBoardColumn({ id: "col_c", workspaceID: "ws_1", title: "C", position: 0 })

      expect(store.getBoard("ws_1").columns.map((column) => column.id)).toEqual(["col_c", "col_a", "col_b"])
      expect(store.getBoard("ws_1").columns.map((column) => column.position)).toEqual([0, 1, 2])

      store.updateBoardColumn("col_c", { position: 2 })
      expect(store.getBoard("ws_1").columns.map((column) => column.id)).toEqual(["col_a", "col_b", "col_c"])

      store.deleteBoardColumn("col_a")
      expect(store.getBoard("ws_1").columns.map((column) => column.id)).toEqual(["col_b", "col_c"])
      expect(store.getBoard("ws_1").columns.map((column) => column.position)).toEqual([0, 1])
    } finally {
      close(store)
    }
  })

  it("creates are idempotent by client-generated id", () => {
    const store = make()
    try {
      store.createWorkspace({ id: "ws_1", name: "App", path: "/w/app", createdAt: 1 })
      const first = store.createBoardColumn({ id: "col_a", workspaceID: "ws_1", title: "A" })
      store.updateBoardColumn("col_a", { title: "Edited meanwhile" })
      const replayed = store.createBoardColumn({ id: "col_a", workspaceID: "ws_1", title: "A" })
      expect(replayed.title).toBe("Edited meanwhile")
      expect(store.getBoard("ws_1").columns).toHaveLength(1)
      expect(first.id).toBe("col_a")

      const card = store.createBoardCard({ id: "card_1", columnID: "col_a", title: "Task" })
      expect(card?.title).toBe("Task")
      store.updateBoardCard("card_1", { title: "Edited" })
      const replayedCard = store.createBoardCard({ id: "card_1", columnID: "col_a", title: "Task" })
      expect(replayedCard?.title).toBe("Edited")
      expect(store.getBoard("ws_1").columns[0]?.cards).toHaveLength(1)
    } finally {
      close(store)
    }
  })

  it("moves cards within and between columns with sequential positions", () => {
    const store = make()
    try {
      store.createWorkspace({ id: "ws_1", name: "App", path: "/w/app", createdAt: 1 })
      store.createBoardColumn({ id: "col_a", workspaceID: "ws_1", title: "A" })
      store.createBoardColumn({ id: "col_b", workspaceID: "ws_1", title: "B" })
      store.createBoardCard({ id: "card_1", columnID: "col_a", title: "One" })
      store.createBoardCard({ id: "card_2", columnID: "col_a", title: "Two" })
      store.createBoardCard({ id: "card_3", columnID: "col_a", title: "Three" })

      store.updateBoardCard("card_3", { position: 0 })
      expect(store.getBoard("ws_1").columns[0]?.cards.map((card) => card.id)).toEqual(["card_3", "card_1", "card_2"])

      store.updateBoardCard("card_1", { columnID: "col_b", position: 0 })
      const snapshot = store.getBoard("ws_1")
      expect(snapshot.columns[0]?.cards.map((card) => card.id)).toEqual(["card_3", "card_2"])
      expect(snapshot.columns[1]?.cards.map((card) => card.id)).toEqual(["card_1"])
      expect(snapshot.columns[0]?.cards.map((card) => card.position)).toEqual([0, 1])
      expect(snapshot.columns[1]?.cards.map((card) => card.position)).toEqual([0])
    } finally {
      close(store)
    }
  })

  it("deleting a column removes its cards and workspace deletion drops the board", () => {
    const store = make()
    try {
      store.createWorkspace({ id: "ws_1", name: "App", path: "/w/app", createdAt: 1 })
      store.createWorkspace({ id: "ws_2", name: "Lib", path: "/w/lib", createdAt: 2 })
      store.createBoardColumn({ id: "col_a", workspaceID: "ws_1", title: "A" })
      store.createBoardCard({ id: "card_1", columnID: "col_a", title: "Task" })
      store.createBoardColumn({ id: "col_b", workspaceID: "ws_2", title: "B" })

      store.deleteBoardColumn("col_a")
      expect(store.getBoard("ws_1").columns).toHaveLength(0)
      store.deleteBoardCard("missing")
      store.deleteBoardColumn("missing")

      store.createBoardColumn({ id: "col_c", workspaceID: "ws_1", title: "C" })
      store.createBoardCard({ id: "card_2", columnID: "col_c", title: "Keep" })
      store.removeWorkspace("ws_1")
      expect(store.getBoard("ws_1").columns).toHaveLength(0)
      expect(store.getBoard("ws_2").columns.map((column) => column.id)).toEqual(["col_b"])
    } finally {
      close(store)
    }
  })

  it("rejects cards for unknown columns", () => {
    const store = make()
    try {
      expect(store.createBoardCard({ id: "card_x", columnID: "col_missing", title: "T" })).toBeNull()
      store.createWorkspace({ id: "ws_1", name: "App", path: "/w/app", createdAt: 1 })
      store.createBoardColumn({ id: "col_a", workspaceID: "ws_1", title: "A" })
      store.createBoardCard({ id: "card_1", columnID: "col_a", title: "T" })
      expect(store.updateBoardCard("card_1", { columnID: "col_missing" })).toBeNull()
      expect(store.updateBoardCard("missing", { title: "T" })).toBeNull()
      expect(store.updateBoardColumn("missing", { title: "T" })).toBeNull()
    } finally {
      close(store)
    }
  })

  it("resolves columns and cards without scanning and rejects cross-workspace moves", () => {
    const store = make()
    try {
      store.createWorkspace({ id: "ws_1", name: "App", path: "/w/app", createdAt: 1 })
      store.createWorkspace({ id: "ws_2", name: "Lib", path: "/w/lib", createdAt: 2 })
      store.createBoardColumn({ id: "col_a", workspaceID: "ws_1", title: "A" })
      store.createBoardColumn({ id: "col_b", workspaceID: "ws_2", title: "B" })
      store.createBoardCard({ id: "card_1", columnID: "col_a", title: "T" })

      expect(store.getBoardColumn("col_a")?.workspaceID).toBe("ws_1")
      expect(store.getBoardColumn("missing")).toBeNull()
      expect(store.getBoardCard("card_1")?.columnID).toBe("col_a")
      expect(store.getBoardCard("missing")).toBeNull()

      // A card never leaves its workspace, even when the target column exists.
      expect(store.updateBoardCard("card_1", { columnID: "col_b", position: 0 })).toBeNull()
      expect(store.getBoard("ws_1").columns[0]?.cards.map((card) => card.id)).toEqual(["card_1"])
      expect(store.getBoard("ws_2").columns[0]?.cards).toHaveLength(0)
    } finally {
      close(store)
    }
  })
})

describe("board snapshot queries", () => {
  it("reads the snapshot with one column query plus one card query", () => {
    // Four columns of three described cards: the old path ran one card query
    // per column (N+1) on every GET and every board.updated frame; the snapshot
    // now lists columns once and cards once (WHERE column_id IN ...), grouped
    // in JS. Step 2 (per-card frames) is deliberately out of scope.
    const dir = mkdtempSync(join(tmpdir(), "masterhand-board-"))
    const store = createSqliteStore(join(dir, "test.sqlite"))
    try {
      store.createWorkspace({ id: "ws_1", name: "App", path: "/w/app", createdAt: 1 })
      for (const column of ["a", "b", "c", "d"]) {
        store.createBoardColumn({ id: `col_${column}`, workspaceID: "ws_1", title: column.toUpperCase() })
        for (let card = 0; card < 3; card += 1) {
          store.createBoardCard({
            id: `card_${column}_${card}`,
            columnID: `col_${column}`,
            title: `T${card}`,
            description: `long description ${column} ${card}`,
          })
        }
      }

      resetBoardCardReads()
      const snapshot = store.getBoard("ws_1")
      expect(boardCardReads()).toBe(1)
      expect(snapshot.columns).toHaveLength(4)
      for (const column of snapshot.columns) {
        expect(column.cards).toHaveLength(3)
        expect(column.cards.map((card) => card.id)).toEqual(
          [0, 1, 2].map((card) => `card_${column.id.slice("col_".length)}_${card}`),
        )
        expect(column.cards.map((card) => card.columnID)).toEqual([column.id, column.id, column.id])
      }
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
