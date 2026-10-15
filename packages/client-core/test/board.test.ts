import { describe, expect, it } from "vitest"
import {
  boardPayloadOf,
  dropIndexFor,
  normalizeBoardCard,
  normalizeBoardColumn,
  normalizeBoardSnapshot,
  reorderIDs,
  type BoardCard,
} from "../src/board"

function card(id: string, position: number): BoardCard {
  return { id, columnID: "col_a", title: id, description: "", position, createdAt: 1, updatedAt: 1 }
}

describe("board normalizers", () => {
  it("normalizes snapshots, columns and cards tolerantly", () => {
    expect(normalizeBoardSnapshot(null)).toBeNull()
    expect(normalizeBoardSnapshot({})).toBeNull()
    expect(normalizeBoardCard({ id: "c" })).toBeNull()
    expect(normalizeBoardColumn({ id: "c", workspaceID: "w" })).toBeNull()

    const snapshot = normalizeBoardSnapshot({
      workspaceID: "ws_1",
      columns: [
        { id: "col_b", workspaceID: "ws_1", title: "B", position: 1, cards: [{ id: "card_2", columnID: "col_b", title: "Two", position: 1 }] },
        { id: "col_a", workspaceID: "ws_1", title: "A", position: 0, cards: "nope" },
        "junk",
      ],
    })
    expect(snapshot?.columns.map((column) => column.id)).toEqual(["col_a", "col_b"])
    expect(snapshot?.columns[1]?.cards.map((entry) => entry.id)).toEqual(["card_2"])
    expect(normalizeBoardCard({ id: "c1", columnID: "col_a", title: "T", description: 42 })).toMatchObject({
      id: "c1",
      description: "",
    })
  })

  it("parses board.updated frames and rejects anything else", () => {
    const board = { workspaceID: "ws_1", columns: [] }
    expect(boardPayloadOf({ type: "board.updated", data: { workspaceID: "ws_1", board } })).toEqual({
      workspaceID: "ws_1",
      board,
    })
    expect(boardPayloadOf({ type: "goal.updated", data: {} })).toBeNull()
    expect(boardPayloadOf({ type: "board.updated", data: { workspaceID: "", board } })).toBeNull()
    expect(boardPayloadOf({ type: "board.updated", data: { workspaceID: "ws_1" } })).toBeNull()
    expect(boardPayloadOf(null)).toBeNull()
  })
})

describe("board reorder helpers", () => {
  it("moves an id to the position of another id", () => {
    expect(reorderIDs(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"])
    expect(reorderIDs(["a", "b"], "a", "a")).toBeNull()
    expect(reorderIDs(["a", "b"], "missing", "a")).toBeNull()
    expect(reorderIDs(["a", "b"], "a", "missing")).toBeNull()
  })

  it("resolves a drop index within a column", () => {
    const cards = [card("card_1", 0), card("card_2", 1)]
    expect(dropIndexFor(cards, "card_2")).toBe(1)
    expect(dropIndexFor(cards, null)).toBe(2)
    expect(dropIndexFor(cards, "missing")).toBe(2)
  })
})

describe("board client", () => {
  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  }

  it("targets the board routes and unwraps snapshots", async () => {
    const { createClient } = await import("../src/client")
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      const target = String(url)
      if (target.includes("/api/board?workspace=")) return jsonResponse({ board: { workspaceID: "ws_1", columns: [] } })
      if (target.endsWith("/api/board/columns")) {
        const body = JSON.parse(String(init?.body))
        return jsonResponse({ column: { id: body.id, workspaceID: body.workspaceID, title: body.title, position: 0, cards: [] } }, 201)
      }
      if (target.includes("/api/board/columns/")) return jsonResponse({ column: { id: "col_a", workspaceID: "ws_1", title: "Renamed", position: 0, cards: [] } })
      if (target.endsWith("/api/board/cards")) {
        const body = JSON.parse(String(init?.body))
        return jsonResponse({ card: { id: body.id, columnID: body.columnID, title: body.title, description: "", position: 0 } }, 201)
      }
      if (target.includes("/api/board/cards/")) return jsonResponse({ card: { id: "card_1", columnID: "col_a", title: "Edited", description: "", position: 0 } })
      return new Response(null, { status: 204 })
    }) as typeof fetch
    const client = createClient({ baseUrl: "", fetchImpl })

    expect(await client.api.board.get("ws_1")).toEqual({ workspaceID: "ws_1", columns: [] })
    expect((await client.api.board.createColumn("ws_1", { id: "col_a", title: "A" })).id).toBe("col_a")
    expect((await client.api.board.updateColumn("col_a", { title: "Renamed" })).title).toBe("Renamed")
    await client.api.board.deleteColumn("col_a")
    expect((await client.api.board.createCard({ id: "card_1", columnID: "col_a", title: "T" })).id).toBe("card_1")
    expect((await client.api.board.updateCard("card_1", { title: "Edited" })).title).toBe("Edited")
    await client.api.board.deleteCard("card_1")

    expect(calls.map((call) => `${call.init?.method ?? "GET"} ${call.url}`)).toEqual([
      "GET /api/board?workspace=ws_1",
      "POST /api/board/columns",
      "PATCH /api/board/columns/col_a",
      "DELETE /api/board/columns/col_a",
      "POST /api/board/cards",
      "PATCH /api/board/cards/card_1",
      "DELETE /api/board/cards/card_1",
    ])
  })

  it("fails when the BFF returns a board that cannot be normalized", async () => {
    const { createClient } = await import("../src/client")
    const fetchImpl = (async () => jsonResponse({ board: { nope: true } })) as typeof fetch
    const client = createClient({ baseUrl: "", fetchImpl })
    await expect(client.api.board.get("ws_1")).rejects.toMatchObject({ status: 502 })
  })
})
