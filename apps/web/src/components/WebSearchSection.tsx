import { useMemo, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  RequestTimeoutError,
  providerIcon,
  providerMonogram,
  queryKeys,
  useIntegrations,
  useProviderCredentials,
  useWebsearchSettings,
  useWebsearchSources,
  websearchIcon,
  websearchSaveErrorMessage,
  websearchTestErrorMessage,
  type Integration,
  type WebsearchSource,
  type WebsearchTestResult,
} from "@masterhand/client-core"
import { client } from "../client"
import { ConnectKeyDialog } from "./ConnectKeyDialog"
import { ExternalLinkIcon, SearchIcon } from "./icons"

/**
 * Settings > Web search: pick the default source opencode uses for agent web
 * searches, connect an API key per source, and probe the current selection
 * with a real search. The selection lives in the config file MasterHand owns
 * (`websearch.provider`, hot-reloaded by opencode); the keys stay in opencode's
 * credential store. TinyFish is the keyless source, seeded as the default.
 */
export function WebSearchSection() {
  const queryClient = useQueryClient()
  const settingsQuery = useWebsearchSettings(client)
  const sourcesQuery = useWebsearchSources(client)
  const integrationsQuery = useIntegrations(client)
  const credentialsQuery = useProviderCredentials(client)

  const [saving, setSaving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [connecting, setConnecting] = useState<WebsearchSource | null>(null)
  const [confirmingID, setConfirmingID] = useState<string | null>(null)
  const [busyID, setBusyID] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [testing, setTesting] = useState(false)
  const [testError, setTestError] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<WebsearchTestResult | null>(null)

  const selection = settingsQuery.data ?? null
  const sources = sourcesQuery.data ?? []
  const credentials = credentialsQuery.data ?? []
  const integrationByID = useMemo(
    () => new Map((integrationsQuery.data ?? []).map((integration) => [integration.id, integration])),
    [integrationsQuery.data],
  )

  async function refresh(): Promise<void> {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.websearch }),
      queryClient.invalidateQueries({ queryKey: queryKeys.integrations }),
      queryClient.invalidateQueries({ queryKey: queryKeys.credentials }),
    ])
  }

  async function select(provider: string | "random"): Promise<void> {
    if (saving) return
    setSaving(provider)
    setError(null)
    try {
      await client.api.saveWebsearchSettings(provider)
    } catch (err) {
      setError(websearchSaveErrorMessage(err))
    } finally {
      setSaving(null)
      // Reconcile either way: the write is idempotent and may have landed even
      // when its response was lost (rule 4 in docs/past-mistakes.md).
      await queryClient.invalidateQueries({ queryKey: queryKeys.websearch })
    }
  }

  async function disconnect(credentialID: string): Promise<void> {
    setBusyID(credentialID)
    setError(null)
    try {
      await client.api.removeCredential(credentialID)
      await refresh()
    } catch (err) {
      setError(
        err instanceof RequestTimeoutError
          ? "The server did not answer in time — the key may still be connected. Reopen settings to check."
          : "Could not disconnect the key",
      )
    } finally {
      setBusyID(null)
      setConfirmingID(null)
    }
  }

  async function runTest(): Promise<void> {
    const text = query.trim()
    if (!text || testing) return
    setTesting(true)
    setTestError(null)
    setTestResult(null)
    try {
      setTestResult(await client.api.testWebsearch(text))
    } catch (err) {
      setTestError(websearchTestErrorMessage(err))
    } finally {
      setTesting(false)
    }
  }

  function sourceName(id: string): string {
    return sources.find((source) => source.id === id)?.name ?? id
  }

  return (
    <section aria-labelledby="settings-websearch">
      <h3 id="settings-websearch" className="mh-settings__title">
        Web search
      </h3>
      <p className="mh-settings__desc">
        The source opencode uses when the agent searches the web. Connect a source&apos;s API key to use it, or keep
        the keyless default.
      </p>

      {settingsQuery.isLoading && <p className="mt-4 text-xs text-ink-muted">Loading…</p>}
      {settingsQuery.error && <p className="mt-4 text-xs text-danger">Could not load the default source.</p>}
      {settingsQuery.data !== undefined && selection === null && (
        <p className="mt-3 text-xs text-ink-muted">
          No default source is set — opencode would ask per search, which MasterHand cannot show. Pick one below.
        </p>
      )}
      {settingsQuery.data === false && (
        <p className="mt-3 text-xs text-ink-muted">
          Web search is disabled in opencode&apos;s config (websearch: false). Pick a source to enable it.
        </p>
      )}

      {sourcesQuery.isLoading && <p className="mt-3 text-xs text-ink-muted">Loading sources…</p>}
      {sourcesQuery.error && (
        <p className="mt-3 text-xs text-danger">Could not load the web search sources from opencode.</p>
      )}

      <div role="radiogroup" aria-label="Default web search source" className="mh-options mt-4">
        <button
          type="button"
          role="radio"
          aria-checked={selection === "random"}
          disabled={saving !== null}
          onClick={() => void select("random")}
          className={`mh-option w-full${selection === "random" ? " is-selected" : ""}`}
        >
          <span className="mh-option__mark" aria-hidden="true" />
          <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-hairline bg-canvas text-ink">
            <SearchIcon size={14} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm">Automatic</span>
            <span className="block text-[11px] text-ink-muted">
              Picks an available source per search, retrying another on rate limits.
            </span>
          </span>
        </button>

        {sources.map((source) => {
          const integration = integrationByID.get(source.id)
          const credentialConnections = (integration?.connections ?? []).filter(
            (connection) => connection.type === "credential" && connection.credentialID,
          )
          const envConnections = (integration?.connections ?? []).filter((connection) => connection.type === "env")
          const connected = credentialConnections.length > 0 || envConnections.length > 0
          const checked = selection === source.id
          return (
            <div key={source.id} data-testid={`websearch-source-${source.id}`}>
              <button
                type="button"
                role="radio"
                aria-checked={checked}
                disabled={saving !== null}
                onClick={() => void select(source.id)}
                className={`mh-option w-full${checked ? " is-selected" : ""}`}
              >
                <span className="mh-option__mark" aria-hidden="true" />
                <SourceAvatar integration={integration} name={source.name} />
                <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                  <span className="truncate text-sm">{source.name}</span>
                  {source.keyless && <span className="mh-chip mh-chip--outline shrink-0">No API key required</span>}
                  {connected && <span className="mh-chip mh-chip--accent shrink-0">Connected</span>}
                </span>
              </button>

              {(credentialConnections.length > 0 || envConnections.length > 0) && (
                <ul className="mt-1.5 flex flex-col gap-1 pl-1">
                  {credentialConnections.map((connection) => {
                    const credentialID = connection.credentialID!
                    const credential = credentials.find((entry) => entry.id === credentialID)
                    const label = connection.label?.trim() || "API key"
                    return (
                      <li key={credentialID} className="flex items-center gap-2 text-xs text-ink-muted">
                        {confirmingID === credentialID ? (
                          <>
                            <span className="text-danger">Disconnect?</span>
                            <button
                              type="button"
                              className="mh-btn mh-btn--sm mh-btn--danger shrink-0"
                              disabled={busyID === credentialID}
                              onClick={() => void disconnect(credentialID)}
                            >
                              {busyID === credentialID ? "Removing…" : "Yes"}
                            </button>
                            <button
                              type="button"
                              className="mh-btn mh-btn--sm mh-btn--ghost"
                              onClick={() => setConfirmingID(null)}
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="mh-btn mh-btn--sm mh-btn--danger shrink-0"
                            disabled={busyID === credentialID}
                            onClick={() => setConfirmingID(credentialID)}
                          >
                            Disconnect
                          </button>
                        )}
                        <span className="min-w-0 flex-1 truncate">{label}</span>
                        {credential?.active && <span className="text-accent">Active</span>}
                      </li>
                    )
                  })}
                  {envConnections.length > 0 && (
                    <li className="truncate text-xs text-ink-muted">
                      Using {envConnections.map((connection) => connection.label).filter(Boolean).join(", ")}
                    </li>
                  )}
                </ul>
              )}

              {credentialConnections.length === 0 && (
                <div className="mt-1.5 pl-1">
                  <button
                    type="button"
                    className="mh-btn mh-btn--sm mh-btn--ghost"
                    onClick={() => setConnecting(source)}
                  >
                    Connect
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {saving && <p className="mt-2 text-xs text-ink-muted">Saving…</p>}
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}

      <div className="mt-5 rounded-md border border-hairline bg-surface p-3">
        <p className="mh-caption mh-muted">Test the current source</p>
        <div className="mt-2 flex gap-2">
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void runTest()
            }}
            placeholder="Search the web…"
            aria-label="Test search query"
            className="mh-input flex-1"
          />
          <button
            type="button"
            className="mh-btn mh-btn--secondary mh-btn--sm shrink-0"
            disabled={testing || !query.trim()}
            onClick={() => void runTest()}
          >
            {testing ? "Searching…" : "Test"}
          </button>
        </div>
        {testError && <p className="mt-2 text-xs text-danger">{testError}</p>}
        {testResult && (
          <div className="mt-2">
            {testResult.results.length === 0 ? (
              <p className="text-[11px] text-ink-muted">No results.</p>
            ) : (
              <>
                <p className="text-[11px] text-ink-muted">
                  Answered by <span className="text-ink">{sourceName(testResult.providerID)}</span>
                </p>
                <ul className="mt-1 flex flex-col gap-1">
                  {testResult.results.slice(0, 4).map((result) => (
                    <li key={result.url} className="flex min-w-0 items-center gap-1 text-xs">
                      <ExternalLinkIcon size={12} className="shrink-0 text-ink-muted" />
                      <a
                        href={result.url}
                        target="_blank"
                        rel="noreferrer"
                        className="min-w-0 truncate text-accent hover:underline"
                      >
                        {result.title ?? result.url}
                      </a>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </div>

      {connecting && (
        <ConnectKeyDialog
          integrationID={connecting.id}
          name={connecting.name}
          onClose={() => setConnecting(null)}
          onConnected={async () => {
            setConnecting(null)
            await refresh()
          }}
        />
      )}
    </section>
  )
}

/**
 * Source glyph, like the Providers catalog: the real brand mark when vendored
 * (`websearch-icons.ts`), the backend icon URL or a shared provider mark when
 * the integration exposes one, otherwise a deterministic monogram.
 */
function SourceAvatar({ integration, name }: { integration?: Integration; name: string }) {
  const id = integration?.id ?? name
  const brand = websearchIcon(id) ?? providerIcon(id)
  if (integration?.icon) {
    return (
      <img
        src={integration.icon}
        alt=""
        data-testid="source-avatar"
        className="h-7 w-7 shrink-0 rounded-md border border-hairline bg-canvas object-contain p-0.5"
      />
    )
  }
  const icon = brand
  if (icon) {
    return (
      <span
        aria-hidden="true"
        data-testid="source-avatar"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-hairline bg-canvas text-ink [&_svg]:h-4 [&_svg]:w-4"
        dangerouslySetInnerHTML={{ __html: icon }}
      />
    )
  }
  return (
    <span
      aria-hidden="true"
      data-testid="source-avatar"
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-accent-line bg-accent-soft text-xs font-semibold text-accent"
    >
      {providerMonogram(name)}
    </span>
  )
}
