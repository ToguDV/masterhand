import { ApiError, RequestTimeoutError } from "./client"
import type { SessionStructuredError } from "./types"

/**
 * True when a failed request may still have been applied: the client deadline
 * expired (`RequestTimeoutError`) or the BFF answered `504` for a missed
 * upstream deadline. Callers must reconcile with a second channel and must
 * never auto-retry a non-idempotent mutation (rule 4 in `docs/past-mistakes.md`).
 */
export function isAmbiguousError(error: unknown): boolean {
  return error instanceof RequestTimeoutError || (error instanceof ApiError && error.status === 504)
}

/** Maps a failed composer request to a user-facing message (web + mobile). */
export function composerErrorMessage(error: unknown, kind: "send" | "side question"): string {
  if (error instanceof RequestTimeoutError) {
    return kind === "send"
      ? "The server did not respond — your message may not have been sent. Check the chat before retrying."
      : "The server did not respond — the side question may not have started. Try again."
  }
  if (error instanceof ApiError) {
    return kind === "send"
      ? `Could not send (HTTP ${error.status})`
      : `Could not start the side question (HTTP ${error.status})`
  }
  return kind === "send" ? "Could not send" : "Could not start the side question"
}

/**
 * Turns an opencode structured error (`session.execution.failed`, assistant
 * message error) into a concise message for the UI. Returns `null` for
 * user-initiated aborts (expected, not worth a banner).
 */
export function opencodeErrorMessage(error: SessionStructuredError | null | undefined): string | null {
  if (!error || typeof error !== "object") return "The agent reported an error"
  if (error.type === "MessageAbortedError") return null

  const message = typeof error.message === "string" ? error.message.split("\n")[0]?.trim() : ""
  if (message) return message
  return "The agent reported an error"
}

function apiErrorCode(error: ApiError): string | null {
  try {
    const body = JSON.parse(error.message) as { error?: unknown }
    return typeof body.error === "string" ? body.error : null
  } catch {
    return null
  }
}

/**
 * Message shown when a conversation fails to load. Detects the opencode
 * credential mismatch (the BFF and `opencode serve` must share
 * `OPENCODE_SERVER_PASSWORD`), the most common setup failure.
 */
export function conversationErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const code = apiErrorCode(error)
    if (code === "opencode_unauthorized") {
      return "opencode rejected MasterHand's credentials. MasterHand and opencode must share OPENCODE_SERVER_PASSWORD: set it in apps/server/.env.local (or unset it in opencode), then restart both."
    }
    if (code === "opencode_unreachable") {
      return "opencode is not reachable. Is its server running?"
    }
    const message = error.message.split("\n")[0]?.trim()
    if (message && !message.startsWith("{")) return message
  }
  return "Could not load the conversation"
}

/** Human-readable message for a failed preview Start. */
export function previewErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const code = apiErrorCode(error)
    if (code === "preview_not_running") {
      return "The agent has not started a web server yet. Ask it to run the project, then try again."
    }
    if (code === "preview_unavailable") return "cloudflared is not available on the server."
    if (code === "preview_ports_exhausted") {
      return "No preview ports are free. Stop another preview or widen PREVIEW_PORT_RANGE."
    }
    if (code === "preview_tunnel_unreachable") {
      return "The tunnel started but its public URL never became reachable. Try again."
    }
    if (code === "preview_tunnel_timeout" || code === "preview_tunnel_exited") {
      return "cloudflared could not establish the tunnel. Check the server logs."
    }
    return "Could not start the preview"
  }
  return "Could not start the preview"
}
