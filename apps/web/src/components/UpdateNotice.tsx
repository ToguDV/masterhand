import { useEffect, useState } from "react"
import {
  ApiError,
  isNewerVersion,
  queryKeys,
  useBffStatus,
  useApplyUpdate,
  useUpdate,
  type BffStatus,
  type VersionRelease,
} from "@masterhand/client-core"
import { useQueryClient } from "@tanstack/react-query"
import { client } from "../client"
import { CLIENT_BUILD, CLIENT_VERSION } from "../version"

const SKIPPED_UPDATE_KEY = "masterhand.skippedUpdate"
const UPDATE_POLL_MS = 3000
const UPDATE_DEADLINE_MS = 5 * 60 * 1000

function loadSkippedTag(): string | null {
  try {
    return window.localStorage.getItem(SKIPPED_UPDATE_KEY)
  } catch {
    return null
  }
}

/** Persisted skip shared by the banner and the About section in one document. */
function useSkippedTag(): [string | null, (tag: string) => void] {
  const [skippedTag, setSkippedTag] = useState<string | null>(loadSkippedTag)
  const skip = (tag: string): void => {
    try {
      window.localStorage.setItem(SKIPPED_UPDATE_KEY, tag)
    } catch {
      // Private mode: the skip lives in memory only.
    }
    setSkippedTag(tag)
  }
  return [skippedTag, skip]
}

function releaseNotesUrl(tag: string): string {
  return `https://github.com/togudv/masterhand/releases/tag/${encodeURIComponent(tag)}`
}

const UPGRADE_COMMAND =
  "docker compose -f deploy/docker-compose.yml pull && docker compose -f deploy/docker-compose.yml up -d"

function apiErrorCode(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null
  try {
    const body = JSON.parse(error.message) as { error?: unknown }
    return typeof body.error === "string" ? body.error : null
  } catch {
    return null
  }
}

function applyErrorMessage(error: unknown): string {
  switch (apiErrorCode(error)) {
    case "update_in_progress":
      return "An update is already running. Wait for the server to restart."
    case "update_not_available":
      return "No newer release is available right now."
    case "updater_pinned":
      return "One-click updates are disabled because this server tracks a pinned image tag."
    case "updater_disabled":
      return "The updater is not enabled on this server."
    case "backup_failed":
      return "The pre-update backup failed, so the server was not updated. Check the data volume."
    case "updater_unreachable":
      return "The updater sidecar is unreachable. Check the server logs."
    case "updater_rejected":
      return "The updater sidecar rejected the request. Check the server logs."
    default:
      return error instanceof ApiError && error.status === 401
        ? "Your session expired. Sign in again."
        : "Could not start the update. Check the server logs."
  }
}

type UpdatePhase = "idle" | "updating" | "updated" | "failed"

/**
 * One-click self-update (#134). The BFF answers 202 before the sidecar
 * restarts it, so the only reliable signal is the version `/api/status`
 * reports after reconnecting. Polling is bounded; a failure is explicit and
 * never auto-retried.
 */
function useUpdateAction(latest: VersionRelease | null, status?: BffStatus) {
  const apply = useApplyUpdate(client)
  const queryClient = useQueryClient()
  const [phase, setPhase] = useState<UpdatePhase>("idle")
  const [message, setMessage] = useState<string | null>(null)

  const target = latest?.version ?? null
  const current = status?.version
  const updater = status?.updater
  const supported = Boolean(updater?.enabled && updater.tracksLatest)

  useEffect(() => {
    if (phase !== "updating") return
    if (target && current && !isNewerVersion(current, target)) {
      setPhase("updated")
      setMessage(`Updated to ${current}. Reload to use the new build.`)
      return
    }
    const deadline = Date.now() + UPDATE_DEADLINE_MS
    const timer = window.setInterval(() => {
      if (Date.now() > deadline) {
        window.clearInterval(timer)
        setPhase("failed")
        setMessage(
          "The server did not come back with the new version. Check the host logs and the pre-update backup.",
        )
        return
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.status })
    }, UPDATE_POLL_MS)
    return () => window.clearInterval(timer)
  }, [phase, target, current, queryClient])

  async function start(): Promise<void> {
    if (apply.isPending || phase === "updating") return
    setPhase("updating")
    setMessage("Updating MasterHand… the server will restart.")
    try {
      await apply.mutateAsync()
    } catch (error) {
      setPhase("failed")
      setMessage(applyErrorMessage(error))
    }
  }

  return { phase, message, start, supported, busy: apply.isPending || phase === "updating" }
}

function ActionMessage({ message, phase }: { message: string | null; phase: UpdatePhase }) {
  if (!message) return null
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      <span className="mh-body-sm" role={phase === "failed" ? "alert" : "status"}>
        {message}
      </span>
      {phase === "updated" && (
        <button type="button" className="mh-btn mh-btn--sm" onClick={() => window.location.reload()}>
          Reload
        </button>
      )}
    </div>
  )
}

/**
 * Update banners for the app banner stack (#131/#134):
 *
 * - stale bundle: the loaded web bundle's build id differs from the running
 *   BFF's — a redeploy happened under this tab. Reload picks it up (hashed
 *   assets mean no aggressive HTML caching to fight).
 * - upstream release: the BFF's manifest reports a strictly newer version.
 *   With the opt-in updater it shows "Update now"; otherwise it shows the
 *   copyable `pull && up -d` command. A skipped tag (persisted) stays hidden;
 *   an unknown upstream (`latest: null`, old BFF included) shows nothing.
 */
export function UpdateNotices({ status, latest }: { status?: BffStatus; latest?: VersionRelease | null }) {
  const [skippedTag, skipVersion] = useSkippedTag()
  const [copied, setCopied] = useState(false)
  const action = useUpdateAction(latest ?? null, status)

  const serverBuild = status?.build
  const staleBundle = Boolean(serverBuild && CLIENT_BUILD && serverBuild !== CLIENT_BUILD)

  const current = status?.version ?? CLIENT_VERSION
  const updateAvailable =
    Boolean(latest && isNewerVersion(current, latest.version)) && skippedTag !== latest?.tag

  if (!staleBundle && !updateAvailable && action.phase !== "updated") return null

  async function copyUpgradeCommand(): Promise<void> {
    try {
      await navigator.clipboard.writeText(UPGRADE_COMMAND)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard unavailable: the command stays selectable as plain text.
    }
  }

  const updater = status?.updater

  return (
    <>
      {staleBundle && (
        <div className="mh-banner mh-banner--info" role="status">
          <span className="min-w-0 flex-1">
            This page is running an older build ({CLIENT_BUILD}); the server is on {serverBuild}. Reload to pick it
            up.
          </span>
          <button type="button" className="mh-btn mh-btn--sm" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      )}
      {updateAvailable && latest && (
        <div className="mh-banner mh-banner--info" role="status">
          <div className="min-w-0 flex-1">
            <span>
              MasterHand {latest.version} is available (running {current}).{" "}
              <a href={releaseNotesUrl(latest.tag)} target="_blank" rel="noreferrer">
                Release notes
              </a>
            </span>
            <ActionMessage message={action.message} phase={action.phase} />
            <div className="mt-1 flex flex-wrap items-center gap-2">
              {action.supported ? (
                <button
                  type="button"
                  className="mh-btn mh-btn--sm mh-btn--primary"
                  onClick={() => void action.start()}
                  disabled={action.busy}
                >
                  {action.busy ? "Updating…" : "Update now"}
                </button>
              ) : (
                <>
                  <code className="mh-code">{UPGRADE_COMMAND}</code>
                  <button type="button" className="mh-btn mh-btn--sm mh-btn--quiet" onClick={copyUpgradeCommand}>
                    {copied ? "Copied" : "Copy"}
                  </button>
                </>
              )}
              <button
                type="button"
                className="mh-btn mh-btn--sm mh-btn--quiet"
                onClick={() => skipVersion(latest.tag)}
              >
                Skip this version
              </button>
            </div>
            {updater?.enabled && !updater.tracksLatest && (
              <p className="mh-body-sm mh-muted mt-1">
                One-click updates need a floating image tag; this server tracks {updater.track ?? "a pinned tag"}.
              </p>
            )}
          </div>
        </div>
      )}
      {!updateAvailable && action.phase === "updated" && action.message && (
        <div className="mh-banner mh-banner--info" role="status">
          <span className="min-w-0 flex-1">{action.message}</span>
          <button type="button" className="mh-btn mh-btn--sm" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      )}
    </>
  )
}

/**
 * Settings > About (#131): running version/build, the latest known upstream
 * release, a manual Check for updates, the last-checked time and the persisted
 * skip. Desktop shows this same section: it serves the web build unchanged.
 */
export function AboutSection() {
  const queryClient = useQueryClient()
  const status = useBffStatus(client)
  const update = useUpdate(client)
  const [skippedTag, skipLatestTag] = useSkippedTag()

  const version = status.data?.version ?? CLIENT_VERSION
  const build = status.data?.build ?? CLIENT_BUILD
  const latest = update.data?.latest ?? null
  const current = status.data?.version ?? CLIENT_VERSION
  const updateAvailable = Boolean(latest && isNewerVersion(current, latest.version))
  const action = useUpdateAction(latest, status.data)
  const updater = status.data?.updater

  async function checkNow(): Promise<void> {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.update }),
      queryClient.invalidateQueries({ queryKey: queryKeys.status }),
    ])
  }

  function skipLatest(): void {
    if (!latest) return
    skipLatestTag(latest.tag)
  }

  const lastChecked =
    update.dataUpdatedAt > 0 ? new Date(update.dataUpdatedAt).toLocaleString() : "never"

  return (
    <section aria-labelledby="settings-about">
      <h3 id="settings-about" className="mh-settings__title">
        About
      </h3>
      <p className="mh-settings__desc">Release identity and updates.</p>
      <dl className="mt-4 flex flex-col gap-1 mh-body-sm">
        <div className="flex gap-2">
          <dt className="mh-muted">Version</dt>
          <dd>{version}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="mh-muted">Build</dt>
          <dd>{build}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="mh-muted">Latest release</dt>
          <dd>
            {update.isPending
              ? "checking…"
              : latest
                ? `${latest.version} (${latest.tag})`
                : "unknown"}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="mh-muted">Last checked</dt>
          <dd>{lastChecked}</dd>
        </div>
      </dl>
      {updateAvailable && latest && skippedTag !== latest.tag ? (
        <p className="mh-body-sm mt-2">
          MasterHand {latest.version} is available.{" "}
          <a href={releaseNotesUrl(latest.tag)} target="_blank" rel="noreferrer">
            Release notes
          </a>
        </p>
      ) : (
        <p className="mh-body-sm mh-muted mt-2">
          {!latest
            ? "No update information (the server could not reach the release manifest)."
            : skippedTag === latest.tag
              ? `Skipped ${latest.version}.`
              : "You are up to date."}
        </p>
      )}
      <ActionMessage message={action.message} phase={action.phase} />
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          className="mh-btn mh-btn--sm"
          onClick={checkNow}
          disabled={update.isFetching}
        >
          {update.isFetching ? "Checking…" : "Check for updates"}
        </button>
        {updateAvailable && latest && skippedTag !== latest.tag && action.supported && (
          <button
            type="button"
            className="mh-btn mh-btn--sm mh-btn--primary"
            onClick={() => void action.start()}
            disabled={action.busy}
          >
            {action.busy ? "Updating…" : "Update now"}
          </button>
        )}
        {updateAvailable && latest && skippedTag !== latest.tag && (
          <button type="button" className="mh-btn mh-btn--sm mh-btn--ghost" onClick={skipLatest}>
            Skip {latest.version}
          </button>
        )}
      </div>
      {updateAvailable && !action.supported && updater?.enabled && (
        <p className="mh-body-sm mh-muted mt-2">
          One-click updates need a floating image tag; this server tracks {updater.track ?? "a pinned tag"}.
        </p>
      )}
      {updateAvailable && !updater?.enabled && (
        <p className="mh-body-sm mh-muted mt-2">
          One-click updates are not enabled on this server. Use the command shown in the update banner, or enable
          the updater sidecar (see the deployment runbook).
        </p>
      )}
    </section>
  )
}
