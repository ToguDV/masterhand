import { isNewerVersion, type VersionRelease } from "./update.js"

/** How long a successful trigger blocks another request if the restart did not happen. */
const SUCCESS_HOLD_MS = 4 * 60 * 1000

/**
 * Opt-in one-click BFF updater (#134).
 *
 * The BFF never touches the Docker socket: it asks a small sidecar on the
 * internal network to pull and recreate only the `masterhand` service. This
 * module owns the request-side guards:
 *
 * - disabled unless both the sidecar URL and token are configured;
 * - disabled for pinned image tags (the sidecar would re-pull the same tag);
 * - one update per process lifetime (the process is about to be restarted);
 * - a consistent database backup before the sidecar is called (migrations are
 *   forward-only, so the backup is the only safe rollback);
 * - no automatic retry: a lost response is ambiguous, and the UI reconciles
 *   through `/api/status` after the server reconnects.
 */

export type UpdateApplyError =
  | "updater_disabled"
  | "updater_pinned"
  | "update_in_progress"
  | "update_not_available"
  | "backup_failed"
  | "updater_unreachable"
  | "updater_rejected"

export type UpdateApplyResult =
  | { ok: true; target: string }
  | { ok: false; error: UpdateApplyError; status: 409 | 502 | 503 }

export interface UpdateApplier {
  /** Both the URL and the token are configured. */
  readonly enabled: boolean
  /** The deployment tracks the floating `latest` tag. */
  readonly tracksLatest: boolean
  apply(): Promise<UpdateApplyResult>
}

export interface UpdateApplierOptions {
  url: string | null
  token: string | null
  track: string
  currentVersion: string
  /** Fresh release manifest (never trust a client-supplied target). */
  check: () => Promise<VersionRelease | null>
  /** Consistent database snapshot; rejects when it could not be written. */
  backup: () => Promise<void>
  fetchImpl?: typeof fetch
  /** Budget for the sidecar request; the pull itself runs asynchronously. */
  timeoutMs?: number
}

export function createUpdateApplier(options: UpdateApplierOptions): UpdateApplier {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 10_000
  const url = options.url
  const token = options.token
  const enabled = Boolean(url && token)
  const tracksLatest = options.track === "latest"
  // A successful trigger blocks a second request for a bounded hold window:
  // the sidecar is pulling/recreating this process. If the restart never
  // happens, the guard releases so the operator can retry (the sidecar still
  // serializes its own job and answers 409 while it runs).
  let inFlight = false

  return {
    enabled,
    tracksLatest,
    async apply() {
      if (!url || !token) return { ok: false, error: "updater_disabled", status: 409 }
      if (!tracksLatest) return { ok: false, error: "updater_pinned", status: 409 }
      if (inFlight) return { ok: false, error: "update_in_progress", status: 409 }
      inFlight = true

      const fail = (error: UpdateApplyError, status: 409 | 502 | 503): UpdateApplyResult => {
        inFlight = false
        return { ok: false, error, status }
      }

      const latest = await options.check()
      if (!latest || !isNewerVersion(options.currentVersion, latest.version)) {
        return fail("update_not_available", 409)
      }

      try {
        await options.backup()
      } catch (error) {
        console.warn(
          "[masterhand] pre-update backup failed; the update was not requested:",
          error instanceof Error ? error.message : error,
        )
        return fail("backup_failed", 503)
      }

      try {
        const response = await fetchImpl(new URL("/update", url).toString(), {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ version: latest.version }),
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (!response.ok) {
          console.warn(`[masterhand] updater sidecar rejected the request (HTTP ${response.status})`)
          return fail("updater_rejected", 502)
        }
      } catch (error) {
        console.warn(
          "[masterhand] updater sidecar unreachable:",
          error instanceof Error ? error.message : error,
        )
        return fail("updater_unreachable", 502)
      }

      // The sidecar is pulling/recreating this process. If the restart never
      // happens (pull failed, sidecar died), release the guard after a bounded
      // window so the operator can retry; the sidecar still serializes updates
      // and answers 409 while its own job is running.
      setTimeout(() => {
        inFlight = false
      }, SUCCESS_HOLD_MS).unref()

      return { ok: true, target: latest.version }
    },
  }
}
