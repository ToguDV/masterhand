import { afterEach, describe, expect, it } from "vitest"
import { login, readUntil, startTestApp, type TestApp } from "./helpers.js"

let app: TestApp | null = null

afterEach(async () => {
  await app?.close()
  app = null
})

describe("board routes", () => {
  it("requires a workspace and returns an empty board", async () => {
    app = await startTestApp()
    const cookie = await login(app.url)

    const missing = await fetch(`${app.url}/api/board`, { headers: { cookie } })
    expect(missing.status).toBe(400)

    const unknown = await fetch(`${app.url}/api/board?workspace=ws_missing`, { headers: { cookie } })
    expect(unknown.status).toBe(404)

    app.store.createWorkspace({ id: "ws_1", name: "App", path: "/w/app", createdAt: 1 })
    const empty = await fetch(`${app.url}/api/board?workspace=ws_1`, { headers: { cookie } })
    expect(await empty.json()).toEqual({ board: { workspaceID: "ws_1", columns: [] } })
  })

  it("validates column and card bodies", async () => {
    app = await startTestApp()
    const cookie = await login(app.url)
    app.store.createWorkspace({ id: "ws_1", name: "App", path: "/w/app", createdAt: 1 })

    const noTitle = await fetch(`${app.url}/api/board/columns`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ id: "col_a", workspaceID: "ws_1", title: "  " }),
    })
    expect(noTitle.status).toBe(400)
    expect(await noTitle.json()).toEqual({ error: "invalid_title" })

    const badPosition = await fetch(`${app.url}/api/board/columns`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ id: "col_a", workspaceID: "ws_1", title: "A", position: -1 }),
    })
    expect(badPosition.status).toBe(400)

    const unknownWorkspace = await fetch(`${app.url}/api/board/columns`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ id: "col_a", workspaceID: "ws_missing", title: "A" }),
    })
    expect(unknownWorkspace.status).toBe(404)

    const column = await fetch(`${app.url}/api/board/columns`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ id: "col_a", workspaceID: "ws_1", title: "A" }),
    })
    expect(column.status).toBe(201)

    const unknownColumn = await fetch(`${app.url}/api/board/cards`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ id: "card_1", columnID: "col_missing", title: "T" }),
    })
    expect(unknownColumn.status).toBe(404)
    expect(await unknownColumn.json()).toEqual({ error: "column_not_found" })

    const badCard = await fetch(`${app.url}/api/board/cards`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ id: "card_1", columnID: "col_a", title: "" }),
    })
    expect(badCard.status).toBe(400)

    const missingPatch = await fetch(`${app.url}/api/board/columns/col_missing`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "B" }),
    })
    expect(missingPatch.status).toBe(404)
    expect(await missingPatch.json()).toEqual({ error: "column_not_found" })

    const missingCard = await fetch(`${app.url}/api/board/cards/card_missing`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "B" }),
    })
    expect(missingCard.status).toBe(404)
    expect(await missingCard.json()).toEqual({ error: "card_not_found" })
  })

  it("creates, moves and deletes through the full flow with a board.updated frame", async () => {
    app = await startTestApp()
    const testApp = app
    const cookie = await login(testApp.url)
    testApp.store.createWorkspace({ id: "ws_1", name: "App", path: "/w/app", createdAt: 1 })

    const events = await fetch(`${testApp.url}/api/events`, { headers: { cookie } })
    const reader = events.body!.getReader()

    async function createColumn(id: string, title: string) {
      const response = await fetch(`${testApp.url}/api/board/columns`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ id, workspaceID: "ws_1", title }),
      })
      expect(response.status).toBe(201)
      return (await response.json()) as { column: { id: string } }
    }

    await createColumn("col_a", "To do")
    await createColumn("col_b", "Done")

    const cardResponse = await fetch(`${testApp.url}/api/board/cards`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ id: "card_1", columnID: "col_a", title: "Task", description: "Details" }),
    })
    expect(cardResponse.status).toBe(201)

    const moved = await fetch(`${testApp.url}/api/board/cards/card_1`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ columnID: "col_b", position: 0 }),
    })
    expect(moved.status).toBe(200)
    expect(await moved.json()).toMatchObject({ card: { id: "card_1", columnID: "col_b", position: 0 } })

    const renamed = await fetch(`${testApp.url}/api/board/columns/col_b`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "Shipped" }),
    })
    expect(await renamed.json()).toMatchObject({ column: { id: "col_b", title: "Shipped" } })

    const board = await (await fetch(`${testApp.url}/api/board?workspace=ws_1`, { headers: { cookie } })).json()
    expect(board.board.columns.map((column: { id: string }) => column.id)).toEqual(["col_a", "col_b"])
    expect(board.board.columns[1].cards.map((card: { id: string }) => card.id)).toEqual(["card_1"])

    const deleted = await fetch(`${testApp.url}/api/board/columns/col_a`, { method: "DELETE", headers: { cookie } })
    expect(await deleted.json()).toEqual({ ok: true })

    const frame = await readUntil(reader, "board.updated")
    expect(frame).toContain("board.updated")
    expect(frame).toContain("ws_1")
    await reader.cancel().catch(() => {})
  })

  it("deletes are idempotent and column deletion drops its cards", async () => {
    app = await startTestApp()
    const cookie = await login(app.url)
    app.store.createWorkspace({ id: "ws_1", name: "App", path: "/w/app", createdAt: 1 })
    app.store.createBoardColumn({ id: "col_a", workspaceID: "ws_1", title: "A" })
    app.store.createBoardCard({ id: "card_1", columnID: "col_a", title: "T" })

    expect((await fetch(`${app.url}/api/board/cards/card_1`, { method: "DELETE", headers: { cookie } })).status).toBe(200)
    expect((await fetch(`${app.url}/api/board/cards/card_1`, { method: "DELETE", headers: { cookie } })).status).toBe(200)

    app.store.createBoardCard({ id: "card_2", columnID: "col_a", title: "T2" })
    expect((await fetch(`${app.url}/api/board/columns/col_a`, { method: "DELETE", headers: { cookie } })).status).toBe(200)
    expect((await fetch(`${app.url}/api/board/columns/col_a`, { method: "DELETE", headers: { cookie } })).status).toBe(200)
    expect(app.store.getBoard("ws_1").columns).toHaveLength(0)
  })

  it("rejects moves into another workspace's column with 409", async () => {
    app = await startTestApp()
    const cookie = await login(app.url)
    app.store.createWorkspace({ id: "ws_1", name: "App", path: "/w/app", createdAt: 1 })
    app.store.createWorkspace({ id: "ws_2", name: "Lib", path: "/w/lib", createdAt: 2 })
    app.store.createBoardColumn({ id: "col_a", workspaceID: "ws_1", title: "A" })
    app.store.createBoardColumn({ id: "col_b", workspaceID: "ws_2", title: "B" })
    app.store.createBoardCard({ id: "card_1", columnID: "col_a", title: "T" })

    const moved = await fetch(`${app.url}/api/board/cards/card_1`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ columnID: "col_b", position: 0 }),
    })
    expect(moved.status).toBe(409)
    expect(await moved.json()).toEqual({ error: "column_workspace_mismatch" })
    // The source board keeps the card: no silent loss.
    expect(app.store.getBoard("ws_1").columns[0]?.cards.map((card) => card.id)).toEqual(["card_1"])
    expect(app.store.getBoard("ws_2").columns[0]?.cards).toHaveLength(0)

    // An id that already lives in another workspace is a conflict, not a move.
    const collision = await fetch(`${app.url}/api/board/columns`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ id: "col_a", workspaceID: "ws_2", title: "A" }),
    })
    expect(collision.status).toBe(409)
    expect(await collision.json()).toEqual({ error: "column_workspace_mismatch" })
  })
})
