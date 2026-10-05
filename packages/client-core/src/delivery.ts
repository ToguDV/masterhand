import type { JsonValue } from "@opencode/client"
import type { ChatMessage } from "./types"

/**
 * Metadata key opencode persists on the user message created from a prompt.
 * `metadata` is part of the v2 prompt body (`SessionPromptInput`) and comes back
 * on `SessionMessageUser`, so it doubles as a reliable per-send marker: text +
 * time matching cannot tell our message apart from an identical one sent by
 * another device or from a late duplicate.
 */
export const DELIVERY_MARKER_KEY = "masterhand.delivery"

/** Unique token attached to one prompt so only its own message can confirm it. */
export function createDeliveryMarker(): string {
  return `delivery_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

/** Prompt metadata carrying a delivery marker. */
export function deliveryMetadata(marker: string): Record<string, JsonValue> {
  return { [DELIVERY_MARKER_KEY]: marker }
}

/** Reads the delivery marker persisted on a message (user messages only). */
export function deliveryMarkerOf(message: ChatMessage): string | null {
  const value = message.info.metadata?.[DELIVERY_MARKER_KEY]
  return typeof value === "string" && value.length > 0 ? value : null
}
