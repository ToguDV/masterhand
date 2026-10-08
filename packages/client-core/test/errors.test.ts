import { describe, expect, it } from "vitest"
import { ApiError, RequestTimeoutError } from "../src/client"
import {
  branchErrorMessage,
  composerErrorMessage,
  conversationErrorMessage,
  customProviderErrorMessage,
  isAmbiguousError,
  modelsLoadErrorMessage,
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

describe("branchErrorMessage", () => {
  function apiError(status: number, body: unknown): ApiError {
    return new ApiError(status, JSON.stringify(body))
  }

  it("maps every server-side guard to an actionable message", () => {
    expect(branchErrorMessage(apiError(409, { error: "workspace_busy" }))).toContain("session is running")
    expect(branchErrorMessage(apiError(409, { error: "dirty_worktree" }))).toContain("uncommitted changes")
    expect(branchErrorMessage(apiError(409, { error: "branch_exists" }))).toContain("already exists")
    expect(branchErrorMessage(apiError(404, { error: "branch_not_found" }))).toContain("not found")
    expect(branchErrorMessage(apiError(400, { error: "invalid_branch_name" }))).toContain("valid branch name")
    expect(branchErrorMessage(apiError(502, { error: "busy_check_failed" }))).toContain("running sessions")
    expect(branchErrorMessage(apiError(502, { error: "git_failed" }))).toContain("git failed")
    expect(branchErrorMessage(apiError(500, { error: "weird" }))).toBe("Could not update the branch")
  })

  it("frames a deadline as ambiguous, never as a definite failure", () => {
    expect(branchErrorMessage(new RequestTimeoutError())).toContain("may have changed")
    expect(branchErrorMessage(apiError(504, { error: "git_timeout" }))).toContain("may have changed")
    expect(branchErrorMessage(new Error("offline"))).toBe("Could not update the branch")
  })
})

describe("customProviderErrorMessage", () => {
  function apiError(status: number, body: unknown): ApiError {
    return new ApiError(status, JSON.stringify(body))
  }

  it("maps every validation and file failure", () => {
    expect(customProviderErrorMessage(apiError(400, { error: "invalid_id" }))).toContain("lowercase")
    expect(customProviderErrorMessage(apiError(400, { error: "invalid_name" }))).toContain("display name")
    expect(customProviderErrorMessage(apiError(400, { error: "invalid_base_url" }))).toContain("base URL")
    expect(customProviderErrorMessage(apiError(400, { error: "invalid_package" }))).toContain("transport")
    expect(customProviderErrorMessage(apiError(400, { error: "invalid_models" }))).toContain("model")
    expect(customProviderErrorMessage(apiError(400, { error: "invalid_headers" }))).toContain("headers")
    expect(customProviderErrorMessage(apiError(500, { error: "custom_providers_corrupt" }))).toContain(
      "not valid JSON",
    )
    expect(customProviderErrorMessage(apiError(503, { error: "custom_providers_unwritable" }))).toContain("read-only")
  })

  it("frames timeouts, generic 400s and unknown errors", () => {
    expect(customProviderErrorMessage(new RequestTimeoutError())).toContain("may have been saved")
    expect(customProviderErrorMessage(apiError(400, { error: "weird" }))).toBe(
      "Check the provider details and try again.",
    )
    expect(customProviderErrorMessage(apiError(500, "x"))).toContain("HTTP 500")
    expect(customProviderErrorMessage(new Error("offline"))).toBe("Could not save the provider")
  })
})

describe("modelsLoadErrorMessage", () => {
  function apiError(status: number, body: unknown): ApiError {
    return new ApiError(status, JSON.stringify(body))
  }

  it("calls out validation and auth errors", () => {
    expect(modelsLoadErrorMessage(apiError(400, { error: "invalid_base_url" }))).toContain("base URL")
    expect(modelsLoadErrorMessage(apiError(400, { error: "invalid_headers" }))).toContain("headers")
    expect(modelsLoadErrorMessage(apiError(400, { error: "invalid_key" }))).toContain("too long")
    expect(modelsLoadErrorMessage(apiError(502, { error: "provider_unauthorized" }))).toContain("rejected the API key")
  })

  it("reads every other failure as an unexposed model list", () => {
    for (const code of [
      "provider_unreachable",
      "provider_failed",
      "provider_invalid_response",
      "provider_no_models",
      "provider_timeout",
    ]) {
      expect(modelsLoadErrorMessage(apiError(502, { error: code }))).toBe("This provider does not expose models.")
    }
    expect(modelsLoadErrorMessage(new RequestTimeoutError())).toBe("This provider does not expose models.")
    expect(modelsLoadErrorMessage(new Error("offline"))).toBe("This provider does not expose models.")
  })
})
