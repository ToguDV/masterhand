import { describe, expect, it } from "vitest"
import { ApiError, RequestTimeoutError } from "../src/client"
import {
  composerErrorMessage,
  conversationErrorMessage,
  isAmbiguousError,
  opencodeErrorMessage,
  previewErrorMessage,
} from "../src/errors"
import type { SessionStructuredError } from "../src/types"

describe("isAmbiguousError", () => {
  it("treats a deadline and a 504 as possibly applied", () => {
    expect(isAmbiguousError(new RequestTimeoutError())).toBe(true)
    expect(isAmbiguousError(new ApiError(504, "opencode_timeout"))).toBe(true)
  })

  it("treats real failures as definite", () => {
    expect(isAmbiguousError(new ApiError(500, "boom"))).toBe(false)
    expect(isAmbiguousError(new ApiError(409, "conflict"))).toBe(false)
    expect(isAmbiguousError(new Error("offline"))).toBe(false)
    expect(isAmbiguousError(null)).toBe(false)
  })
})

describe("opencodeErrorMessage", () => {
  it("returns the first line of the error message", () => {
    expect(
      opencodeErrorMessage({ type: "UnknownError", message: "PlatformError: NotFound\n    at foo" }),
    ).toBe("PlatformError: NotFound")
  })

  it("returns null for aborted turns", () => {
    expect(opencodeErrorMessage({ type: "MessageAbortedError", message: "aborted" })).toBeNull()
  })

  it("returns null for every abort shape", () => {
    expect(opencodeErrorMessage({ type: "MessageAbortedError", message: "" })).toBeNull()
    expect(opencodeErrorMessage({ type: "MessageAbortedError", message: "multi\nline" })).toBeNull()
  })

  it("falls back when the message is missing or blank", () => {
    expect(opencodeErrorMessage(undefined)).toBe("The agent reported an error")
    expect(opencodeErrorMessage(null)).toBe("The agent reported an error")
    expect(opencodeErrorMessage("nope" as unknown as SessionStructuredError)).toBe("The agent reported an error")
    expect(opencodeErrorMessage({} as SessionStructuredError)).toBe("The agent reported an error")
    expect(opencodeErrorMessage({ type: "UnknownError", message: "   " })).toBe("The agent reported an error")
    expect(opencodeErrorMessage({ type: "UnknownError", message: "\nsecond line" })).toBe(
      "The agent reported an error",
    )
  })

  it("keeps the original status available on the error payload", () => {
    const error: SessionStructuredError = { type: "ProviderError", message: "boom", status: 503 }
    expect(opencodeErrorMessage(error)).toBe("boom")
  })
})

describe("conversationErrorMessage", () => {
  it("explains the opencode credential mismatch", () => {
    const message = conversationErrorMessage(new ApiError(502, JSON.stringify({ error: "opencode_unauthorized" })))
    expect(message).toContain("OPENCODE_SERVER_PASSWORD")
    expect(message).toContain("restart both")
  })

  it("explains an unreachable opencode", () => {
    expect(conversationErrorMessage(new ApiError(502, JSON.stringify({ error: "opencode_unreachable" })))).toContain(
      "not reachable",
    )
  })

  it("surfaces the server message for other API errors", () => {
    expect(conversationErrorMessage(new ApiError(500, "boom"))).toBe("boom")
    expect(conversationErrorMessage(new ApiError(500, JSON.stringify({ error: "boom" })))).toBe(
      "Could not load the conversation",
    )
    expect(conversationErrorMessage(new Error("boom"))).toBe("Could not load the conversation")
    expect(conversationErrorMessage("nope")).toBe("Could not load the conversation")
  })
})

describe("previewErrorMessage", () => {
  function apiError(status: number, body: unknown): ApiError {
    return new ApiError(status, JSON.stringify(body))
  }

  it("explains every known preview failure", () => {
    expect(previewErrorMessage(apiError(409, { error: "preview_not_running" }))).toContain("has not started")
    expect(previewErrorMessage(apiError(503, { error: "preview_unavailable" }))).toContain("cloudflared")
    expect(previewErrorMessage(apiError(503, { error: "preview_ports_exhausted" }))).toContain("preview ports")
    expect(previewErrorMessage(apiError(502, { error: "preview_tunnel_unreachable" }))).toContain("never became")
    expect(previewErrorMessage(apiError(502, { error: "preview_tunnel_timeout" }))).toContain("could not establish")
    expect(previewErrorMessage(apiError(502, { error: "preview_tunnel_exited" }))).toContain("could not establish")
  })

  it("falls back for unknown or non-API errors", () => {
    expect(previewErrorMessage(apiError(500, { error: "weird" }))).toBe("Could not start the preview")
    expect(previewErrorMessage(apiError(500, { error: "weird" }))).not.toContain("{")
    expect(previewErrorMessage(new Error("boom"))).toBe("Could not start the preview")
    expect(previewErrorMessage("nope")).toBe("Could not start the preview")
  })

  it("tolerates an ApiError whose message is not JSON", () => {
    expect(previewErrorMessage(new ApiError(500, "not-json"))).toBe("Could not start the preview")
  })
})

describe("composerErrorMessage", () => {
  it("frames a timeout as ambiguous, not as a failure", () => {
    expect(composerErrorMessage(new RequestTimeoutError(), "send")).toBe(
      "The server did not respond — your message may not have been sent. Check the chat before retrying.",
    )
    expect(composerErrorMessage(new RequestTimeoutError(), "side question")).toContain("may not have started")
  })

  it("reports the HTTP status and falls back for unknown errors", () => {
    expect(composerErrorMessage(new ApiError(500, "x"), "send")).toBe("Could not send (HTTP 500)")
    expect(composerErrorMessage(new ApiError(502, "x"), "side question")).toBe(
      "Could not start the side question (HTTP 502)",
    )
    expect(composerErrorMessage(new Error("offline"), "send")).toBe("Could not send")
    expect(composerErrorMessage(new Error("offline"), "side question")).toBe("Could not start the side question")
  })
})
