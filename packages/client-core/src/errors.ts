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
 * Maps a failed provider-key connect (settings, #128) to a user message.
 * The connect is non-idempotent: a timeout is reported as ambiguous and never
 * auto-retried — the UI refreshes the connection list instead.
 */
export function providerConnectErrorMessage(error: unknown): string {
  if (error instanceof RequestTimeoutError) {
    return "The server did not answer in time — the key may have been saved. Reopen settings to check before retrying."
  }
  if (error instanceof ApiError) {
    if (error.status === 400 || error.status === 404) return "The provider rejected that key. Check it and try again."
    if (error.status === 502) return "opencode is not reachable right now."
    return `Could not connect (HTTP ${error.status})`
  }
  return "Could not connect to the provider"
}

/**
 * Maps a failed custom-provider create/remove (settings) to a user
 * message. The create is an idempotent upsert, so a timeout is a safe
 * "relaunch and check" rather than a hard failure.
 */
export function customProviderErrorMessage(error: unknown): string {
  if (error instanceof RequestTimeoutError) {
    return "The server did not answer in time — the provider may have been saved. Reopen settings to check."
  }
  if (error instanceof ApiError) {
    switch (apiErrorCode(error)) {
      case "invalid_id":
        return "Use lowercase letters, numbers, hyphens or underscores for the provider id."
      case "invalid_name":
        return "Enter a display name."
      case "invalid_base_url":
        return "Enter a valid http(s) base URL."
      case "invalid_package":
        return "Pick a supported transport."
      case "invalid_models":
        return "Add at least one valid model id (no duplicates)."
      case "invalid_headers":
        return "Check the custom headers."
      case "custom_providers_corrupt":
        return "The custom providers file is not valid JSON. Fix it on the server before adding more."
      case "custom_providers_unwritable":
        return "The server cannot write the providers file (read-only or full disk)."
      default:
        break
    }
    if (error.status === 400) return "Check the provider details and try again."
    return `Could not save the provider (HTTP ${error.status})`
  }
  return "Could not save the provider"
}

/**
 * Turns a model-discovery failure into an actionable message. Discovery is the
 * only way to add models, so any upstream failure reads as "the provider does
 * not expose models" (with validation/auth errors still called out).
 */
export function modelsLoadErrorMessage(error: unknown): string {
  const notExposed = "This provider does not expose models."
  if (error instanceof ApiError) {
    switch (apiErrorCode(error)) {
      case "invalid_base_url":
        return "Enter a valid http(s) base URL first."
      case "invalid_headers":
        return "Check the custom headers."
      case "invalid_key":
        return "The API key is too long."
      case "provider_unauthorized":
        return "The provider rejected the API key. Check it and try again."
      default:
        return notExposed
    }
  }
  return notExposed
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

/**
 * Human-readable message for a failed branch create/checkout. A timeout is
 * surfaced as "may have applied": the caller must refresh the branch list and
 * never auto-retry (the mutation is not idempotent).
 */
export function branchErrorMessage(error: unknown): string {
  if (isAmbiguousError(error)) {
    return "The server did not respond — the branch may have changed. The list was refreshed; check it before retrying."
  }
  if (error instanceof ApiError) {
    switch (apiErrorCode(error)) {
      case "git_timeout":
        return "git timed out — the branch may have changed. The list was refreshed; check it before retrying."
      case "workspace_busy":
        return "A session is running in this workspace. Stop it before switching branches."
      case "dirty_worktree":
        return "The workspace has uncommitted changes. Commit or stash them before switching branches."
      case "branch_exists":
        return "That branch already exists."
      case "branch_not_found":
        return "Branch not found."
      case "invalid_branch_name":
        return "That is not a valid branch name."
      case "busy_check_failed":
        return "Could not check the running sessions. Try again."
      case "git_failed":
        return "git failed. Check the server logs for the exact error."
      default:
        return "Could not update the branch"
    }
  }
  return "Could not update the branch"
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
