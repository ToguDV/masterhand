import { useEffect, useState } from "react"
import { ApiError, RequestTimeoutError, type Client, type GithubStatus } from "@masterhand/client-core"
import { ExternalLinkIcon, GithubIcon } from "./icons"

function errorCode(error: ApiError): string | null {
  try {
    const body = JSON.parse(error.message) as { error?: unknown }
    return typeof body.error === "string" ? body.error : null
  } catch {
    return null
  }
}

export function githubErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 400) return "GitHub rejected that token. Check that it is valid and not expired."
    if (error.status === 404) return "This server does not support GitHub integration yet. Update the server."
    if (error.status === 502) {
      return errorCode(error) === "github_rejected"
        ? "GitHub rejected the request. Check the token permissions, rate limit or organization SSO policy."
        : "Could not reach GitHub from the server. Check its Internet connection and try again."
    }
  }
  if (error instanceof RequestTimeoutError) {
    return "The server did not answer in time. Reopen settings to check whether the token was saved."
  }
  return "Could not update the GitHub integration."
}

function shortDate(value: string | null): string {
  if (!value) return "just now"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "just now" : date.toLocaleDateString()
}

/**
 * Settings > GitHub. A single server-wide fine-grained PAT lets agents use
 * `git` and `gh` inside the agent container. The token is write-only: the
 * status only carries the account identity and whether the container received
 * the credential files.
 */
export function GithubSection({ client }: { client: Client }) {
  const [status, setStatus] = useState<GithubStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [token, setToken] = useState("")
  const [replacing, setReplacing] = useState(false)

  useEffect(() => {
    let cancelled = false
    client.github
      .status()
      .then((next) => {
        if (!cancelled) setStatus(next)
      })
      .catch((err) => {
        if (!cancelled) setError(githubErrorMessage(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [client])

  async function connect(): Promise<void> {
    const value = token.trim()
    if (!value || busy) return
    setBusy(true)
    setError(null)
    try {
      setStatus(await client.github.connect(value))
      setToken("")
      setReplacing(false)
    } catch (err) {
      if (err instanceof RequestTimeoutError) {
        // The write is idempotent; a lost response may still have landed.
        const reconciled = await client.github.status().catch(() => null)
        if (reconciled?.connected) {
          setStatus(reconciled)
          setToken("")
          setReplacing(false)
          return
        }
      }
      setError(githubErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  async function disconnect(): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      setStatus(await client.github.disconnect())
      setToken("")
      setReplacing(false)
    } catch (err) {
      setError(githubErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const connected = status?.connected === true
  const showForm = !connected || replacing

  return (
    <section aria-labelledby="settings-github">
      <div className="flex items-center gap-2">
        <GithubIcon size={18} className="text-ink" />
        <h3 id="settings-github" className="mh-settings__title">
          GitHub
        </h3>
      </div>
      <p className="mh-settings__desc">
        Connect a GitHub account so agents can create branches, push commits and open pull requests with{" "}
        <code className="font-mono text-[0.9em]">git</code> and <code className="font-mono text-[0.9em]">gh</code> inside the agent
        container.
      </p>

      {loading && <p className="mt-4 text-xs text-ink-muted">Loading…</p>}
      {error && <p className="mt-4 text-xs text-danger">{error}</p>}
      {!connected && status?.agentConfigError && (
        <p className="mt-4 rounded-sm border border-warning-line bg-warning-soft px-2 py-1.5 text-xs text-ink-soft">
          Credential cleanup failed: {status.agentConfigError}
        </p>
      )}

      {connected && !replacing && (
        <div className="mt-4 rounded-md border border-hairline bg-surface-muted p-3">
          <div className="flex items-center gap-3">
            {status?.avatarUrl ? (
              <img
                src={status.avatarUrl}
                alt=""
                className="h-10 w-10 rounded-full border border-hairline object-cover"
              />
            ) : (
              <span className="flex h-10 w-10 items-center justify-center rounded-full border border-hairline text-ink-muted">
                <GithubIcon size={18} />
              </span>
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-ink">
                {status?.name ?? `@${status?.login ?? "github"}`}
              </p>
              <p className="truncate text-xs text-ink-muted">
                @{status?.login} · connected {shortDate(status?.updatedAt ?? null)}
              </p>
            </div>
          </div>

          {status && !status.injected && (
            <p className="mt-3 rounded-sm border border-warning-line bg-warning-soft px-2 py-1.5 text-xs text-ink-soft">
              The token is saved, but the agent container has not received it.
              {status.agentConfigError ? ` ${status.agentConfigError}` : " Check the server's AGENT_CONFIG_DIR and shared volume."}
            </p>
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className="mh-btn mh-btn--secondary mh-btn--sm" onClick={() => setReplacing(true)}>
              Replace token
            </button>
            <button
              type="button"
              className="mh-btn mh-btn--danger mh-btn--sm"
              disabled={busy}
              onClick={() => void disconnect()}
            >
              {busy ? "Disconnecting…" : "Disconnect"}
            </button>
          </div>
        </div>
      )}

      {showForm && !loading && (
        <form
          className="mt-4"
          onSubmit={(event) => {
            event.preventDefault()
            void connect()
          }}
        >
          <label className="mh-label" htmlFor="github-token">
            Fine-grained personal access token
          </label>
          <input
            id="github-token"
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="github_pat_…"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="mh-input mt-1 w-full font-mono text-xs"
          />
          <p className="mt-2 text-xs text-ink-muted">
            The token is stored on the server and never shown again. Use an expiry and the minimum permissions.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="submit" className="mh-btn mh-btn--primary mh-btn--sm" disabled={!token.trim() || busy}>
              {busy ? "Connecting…" : connected ? "Replace token" : "Connect GitHub"}
            </button>
            {replacing && (
              <button
                type="button"
                className="mh-btn mh-btn--ghost mh-btn--sm"
                disabled={busy}
                onClick={() => {
                  setReplacing(false)
                  setToken("")
                  setError(null)
                }}
              >
                Cancel
              </button>
            )}
            <a
              href="https://github.com/settings/personal-access-tokens/new"
              target="_blank"
              rel="noreferrer"
              className="ml-auto inline-flex items-center gap-1 text-xs text-accent hover:underline"
            >
              Create a token
              <ExternalLinkIcon size={12} />
            </a>
          </div>
        </form>
      )}

      <details className="mt-5 text-xs text-ink-muted">
        <summary className="cursor-pointer text-ink-soft">Recommended token permissions</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>Repository access: the repos the agent should work in, or all repositories for repo creation.</li>
          <li>Contents: read and write.</li>
          <li>Pull requests: read and write.</li>
          <li>Metadata: read (required by GitHub).</li>
          <li>Workflows: read and write only if the agent edits GitHub Actions files.</li>
          <li>Account permission Repository creation: read and write if the agent should create repos.</li>
        </ul>
      </details>
    </section>
  )
}
