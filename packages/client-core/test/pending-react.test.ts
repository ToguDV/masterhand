/**
 * @vitest-environment jsdom
 */
import { createElement, type ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { deliveryMetadata } from "../src/delivery"
import { queryKeys } from "../src/hooks"
import { usePendingSend } from "../src/pending"
import type { ChatMessage } from "../src/types"

afterEach(cleanup)

function newQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

function wrapper(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children)
}

function userMessage(marker: string): ChatMessage {
  return {
    info: {
      id: "msg_1",
      sessionID: "ses_1",
      role: "user",
      time: { created: 1 },
      metadata: deliveryMetadata(marker),
    },
    parts: [],
  }
}

describe("usePendingSend (#125)", () => {
  it("tracks a plain prompt as sending", () => {
    const qc = newQueryClient()
    const { result } = renderHook(() => usePendingSend("ses_1"), { wrapper: wrapper(qc) })

    act(() => result.current.begin("hello agent", "delivery_a"))

    expect(result.current.pending).toEqual({ text: "hello agent", marker: "delivery_a", status: "sending" })
  })

  it("clears only when the history shows the message with this send's marker", async () => {
    const qc = newQueryClient()
    const { result } = renderHook(() => usePendingSend("ses_1"), { wrapper: wrapper(qc) })
    act(() => result.current.begin("hello agent", "delivery_a"))

    // An identical message created elsewhere (another device) must not confirm it.
    act(() => qc.setQueryData(queryKeys.messages("ses_1"), [userMessage("delivery_b")]))
    await waitFor(() => expect(result.current.pending).not.toBeNull())

    act(() => qc.setQueryData(queryKeys.messages("ses_1"), [userMessage("delivery_a")]))
    await waitFor(() => expect(result.current.pending).toBeNull())
  })

  it("confirms from a cache update that arrives after the send", async () => {
    const qc = newQueryClient()
    const { result } = renderHook(() => usePendingSend("ses_1"), { wrapper: wrapper(qc) })
    act(() => result.current.begin("hello agent", "delivery_a"))

    act(() => qc.setQueryData(queryKeys.messages("ses_1"), []))
    await waitFor(() => expect(result.current.pending).not.toBeNull())

    act(() => qc.setQueryData(queryKeys.messages("ses_1"), [userMessage("delivery_a")]))
    await waitFor(() => expect(result.current.pending).toBeNull())
  })

  it("marks the send as failed and keeps the text for a retry", () => {
    const qc = newQueryClient()
    const { result } = renderHook(() => usePendingSend("ses_1"), { wrapper: wrapper(qc) })
    act(() => result.current.begin("hello agent", "delivery_a"))

    act(() => result.current.fail("delivery_a"))
    expect(result.current.pending).toEqual({ text: "hello agent", marker: "delivery_a", status: "failed" })

    // A stale failure for another send must not touch this one.
    act(() => result.current.fail("delivery_other"))
    expect(result.current.pending?.status).toBe("failed")
  })

  it("dismisses the ghost without resending", () => {
    const qc = newQueryClient()
    const { result } = renderHook(() => usePendingSend("ses_1"), { wrapper: wrapper(qc) })
    act(() => result.current.begin("hello agent", "delivery_a"))

    act(() => result.current.dismiss())
    expect(result.current.pending).toBeNull()
  })
})
