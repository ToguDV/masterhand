import { describe, expect, it } from "vitest"
import { DELIVERY_MARKER_KEY, createDeliveryMarker, deliveryMarkerOf, deliveryMetadata } from "../src/delivery"
import type { ChatMessage } from "../src/types"

function userMessage(metadata?: Record<string, unknown>): ChatMessage {
  return {
    info: {
      id: "msg_1",
      sessionID: "ses_1",
      role: "user",
      time: { created: 1 },
      ...(metadata ? { metadata } : {}),
    },
    parts: [],
  }
}

describe("delivery markers", () => {
  it("pins the wire literal shared with the BFF", () => {
    // Must match DELIVERY_MARKER_KEY in apps/server/src/proxy.ts: a typo on
    // either side breaks prompt reconciliation (see goal-contract.test.ts).
    expect(DELIVERY_MARKER_KEY).toBe("masterhand.delivery")
  })

  it("round-trips the marker through prompt metadata and the message info", () => {
    const marker = createDeliveryMarker()
    expect(deliveryMarkerOf(userMessage(deliveryMetadata(marker)))).toBe(marker)
  })

  it("generates a fresh marker per send", () => {
    expect(createDeliveryMarker()).not.toBe(createDeliveryMarker())
  })

  it("returns null when the message carries no usable marker", () => {
    expect(deliveryMarkerOf(userMessage())).toBeNull()
    expect(deliveryMarkerOf(userMessage({ other: "value" }))).toBeNull()
    expect(deliveryMarkerOf(userMessage({ [DELIVERY_MARKER_KEY]: 42 }))).toBeNull()
    expect(deliveryMarkerOf(userMessage({ [DELIVERY_MARKER_KEY]: "" }))).toBeNull()
  })
})
