import { useState } from "react"
import {
  isNewerVersion,
  queryKeys,
  useBffStatus,
  useUpdate,
  type BffStatus,
  type VersionRelease,
} from "@masterhand/client-core"
import { useQueryClient } from "@tanstack/react-query"
import { client } from "../client"
import { CLIENT_BUILD, CLIENT_VERSION } from "../version"

const SKIPPED_UPDATE_KEY = "masterhand.skippedUpdate"

function loadSkippedTag(): string | null {
  try {
    return window.localStorage.getItem(SKIPPED_UPDATE_KEY)
  } catch {
    return null
  }
}

function releaseNotesUrl(tag: string): string {
  return `https://github.com/togudv/masterhand/releases/tag/${encodeURIComponent(tag)}`
}

const UPGRADE_COMMAND = "docker compose -f deploy/docker-compose.yml pull && docker compose -f deploy/docker-compose.yml up -d"

/**
 * Update banners for the app banner stack (#131):
 *
 * - stale bundle: the loaded web bundle's build id differs from the running
 *   BFF's — a redeploy happened under this tab. Reload picks it up (hashed
 *   assets mean no aggressive HTML caching to fight).
 * - upstream release: the BFF's manifest reports a strictly newer version.
 *   Shows the version, a release-notes link and a copyable
 *   `pull && up -d` block. A skipped tag (persisted) stays hidden; an unknown
 *   upstream (`latest: null`, old BFF included) shows nothing — never an error.
 */
export function UpdateNotices({ status, latest }: { status?: BffStatus; latest?: VersionRelease | null }) {
  const [skippedTag, setSkippedTag] = useState<string | null>(loadSkippedTag)
  const [copied, setCopied] = useState(false)

  const serverBuild = status?.build
  const staleBundle = Boolean(serverBuild && CLIENT_BUILD && serverBuild !== CLIENT_BUILD)

  const current = status?.version ?? CLIENT_VERSION
  const updateAvailable = Boolean(latest && isNewerVersion(current, latest.version)) && skippedTag !== latest?.tag

  if (!staleBundle && !updateAvailable) return null

  function skipVersion(tag: string): void {
    try {
      window.localStorage.setItem(SKIPPED_UPDATE_KEY, tag)
    } catch {
      // Private mode: the banner simply returns next poll.
    }
    setSkippedTag(tag)
  }

  async function copyUpgradeCommand(): Promise<void> {
    try {
      await navigator.clipboard.writeText(UPGRADE_COMMAND)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard unavailable: the command stays selectable as plain text.
    }
  }

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
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <code className="mh-code">{UPGRADE_COMMAND}</code>
              <button type="button" className="mh-btn mh-btn--sm mh-btn--quiet" onClick={copyUpgradeCommand}>
                {copied ? "Copied" : "Copy"}
              </button>
              <button
                type="button"
                className="mh-btn mh-btn--sm mh-btn--quiet"
                onClick={() => skipVersion(latest.tag)}
              >
                Skip this version
              </button>
            </div>
          </div>
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
  const [skippedTag, setSkippedTag] = useState<string | null>(loadSkippedTag)

  const version = status.data?.version ?? CLIENT_VERSION
  const build = status.data?.build ?? CLIENT_BUILD
  const latest = update.data?.latest ?? null
  const current = status.data?.version ?? CLIENT_VERSION
  const updateAvailable = Boolean(latest && isNewerVersion(current, latest.version))

  async function checkNow(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: queryKeys.update })
  }

  function skipLatest(): void {
    if (!latest) return
    try {
      window.localStorage.setItem(SKIPPED_UPDATE_KEY, latest.tag)
    } catch {
      // Private mode: keep it in memory only.
    }
    setSkippedTag(latest.tag)
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
          {latest ? "You are up to date." : "No update information (the server could not reach the release manifest)."}
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          className="mh-btn mh-btn--sm"
          onClick={checkNow}
          disabled={update.isFetching}
        >
          {update.isFetching ? "Checking…" : "Check for updates"}
        </button>
        {updateAvailable && latest && skippedTag !== latest.tag && (
          <button type="button" className="mh-btn mh-btn--sm mh-btn--ghost" onClick={skipLatest}>
            Skip {latest.version}
          </button>
        )}
      </div>
    </section>
  )
}
