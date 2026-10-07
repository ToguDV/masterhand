import { useCallback, useEffect, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { deliveryMarkerOf } from "./delivery"
import { queryKeys } from "./hooks"
import type { ChatMessage } from "./types"

/**
 * One plain-prompt send awaiting confirmation (#125). `text` is kept so a retry
 * never loses it; `marker` is the per-send delivery marker (#71) and the only
 * thing that can confirm the send.
 */
export interface PendingSend {
  text: string
  marker: string
  status: "sending" | "failed"
}

export interface PendingSendController {
  pending: PendingSend | null
  /** Starts tracking a plain prompt (slash commands keep their button feedback). */
  begin: (text: string, marker: string) => void
  /** Marks the send as failed (the ghost becomes retryable). */
  fail: (marker: string) => void
  /** Drops the ghost without resending. */
  dismiss: () => void
}

/**
 * Pending-send state machine shared by the web and mobile chat containers.
 *
 * The ghost clears only when the live history shows the message carrying this
 * send's marker: a lost response cannot fake a delivery (#71), and the real
 * bubble and the ghost never coexist because both read the same query cache.
 */
export function usePendingSend(sessionID: string): PendingSendController {
  const queryClient = useQueryClient()
  const [pending, setPending] = useState<PendingSend | null>(null)

  const begin = useCallback((text: string, marker: string) => {
    setPending({ text, marker, status: "sending" })
  }, [])

  const fail = useCallback((marker: string) => {
    setPending((current) =>
      current && current.marker === marker ? { ...current, status: "failed" } : current,
    )
  }, [])

  const dismiss = useCallback(() => setPending(null), [])

  // Delivery reconciliation: as soon as the persisted history shows the marker,
  // the ghost disappears in the same render the real bubble appears.
  useEffect(() => {
    if (!pending) return
    const check = (): void => {
      const messages = queryClient.getQueryData<ChatMessage[]>(queryKeys.messages(sessionID))
      if (messages?.some((message) => deliveryMarkerOf(message) === pending.marker)) setPending(null)
    }
    check()
    return queryClient.getQueryCache().subscribe(check)
  }, [pending, queryClient, sessionID])

  return { pending, begin, fail, dismiss }
}
