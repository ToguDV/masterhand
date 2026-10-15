/**
 * @vitest-environment jsdom
 */
import { createElement, type ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Client } from "../src/client"
import { createEventHandler, queryKeys, useBoard } from "../src/hooks"

afterEach(cleanup)

function boardSnapshot() {
  return { workspaceID: "ws_1", columns: [{ id: "col_a", workspaceID: "ws_1", title: "A", position: 0, cards: [] }] }
}

function makeBoardClient() {
  const board = {
    get: vi.fn(async () => boardSnapshot()),
    createColumn: vi.fn(),
    updateColumn: vi.fn(),
    deleteColumn: vi.fn(),
    createCard: vi.fn(),
    updateCard: vi.fn(),
    deleteCard: vi.fn(),
  }
  const client = { baseUrl: "", api: { board } } as unknown as Client
  return { client, board }
}

function wrapper(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children)
}

function newQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

describe("useBoard", () => {
  it("stays disabled without a workspace and fetches with one", async () => {
    const qc = newQueryClient()
    const { client, board } = makeBoardClient()

    const disabled = renderHook(() => useBoard(client, null), { wrapper: wrapper(qc) })
    expect(disabled.result.current.fetchStatus).toBe("idle")
    expect(board.get).not.toHaveBeenCalled()

    const enabled = renderHook(() => useBoard(client, "ws_1"), { wrapper: wrapper(qc) })
    await waitFor(() => expect(enabled.result.current.isSuccess).toBe(true))
    expect(board.get).toHaveBeenCalledWith("ws_1")
  })

  it("writes board.updated frames straight into the cache", async () => {
    const qc = newQueryClient()
    const { client } = makeBoardClient()
    const hook = renderHook(() => useBoard(client, "ws_1"), { wrapper: wrapper(qc) })
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true))

    createEventHandler(qc)({
      type: "board.updated",
      data: {
        workspaceID: "ws_1",
        board: {
          workspaceID: "ws_1",
          columns: [{ id: "col_b", workspaceID: "ws_1", title: "B", position: 0, cards: [] }],
        },
      },
    })
    expect(qc.getQueryData(queryKeys.board("ws_1"))).toMatchObject({
      columns: [{ id: "col_b", title: "B" }],
    })
  })

  it("lets an event frame beat an in-flight snapshot", async () => {
    const qc = newQueryClient()
    const { client, board } = makeBoardClient()
    let resolveGet!: (value: unknown) => void
    board.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveGet = resolve as (value: unknown) => void
        }),
    )
    const hook = renderHook(() => useBoard(client, "ws_1"), { wrapper: wrapper(qc) })
    createEventHandler(qc)({
      type: "board.updated",
      data: {
        workspaceID: "ws_1",
        board: {
          workspaceID: "ws_1",
          columns: [{ id: "col_live", workspaceID: "ws_1", title: "Live", position: 0, cards: [] }],
        },
      },
    })
    resolveGet(boardSnapshot())
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true))
    expect(hook.result.current.data).toMatchObject({ columns: [{ id: "col_live" }] })
  })

  it("reconciles boards on reconnect", () => {
    const qc = newQueryClient()
    const invalidate = vi.spyOn(qc, "invalidateQueries")
    createEventHandler(qc)({ type: "server.connected", data: {} })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["board"] })
  })
})
