import { useMemo, useState, type FormEvent } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  RequestTimeoutError,
  providerConnectErrorMessage,
  providerMonogram,
  queryKeys,
  useIntegrations,
  useProviderCredentials,
  type Integration,
} from "@masterhand/client-core"
import { client } from "../client"
import { useModalFocus } from "./useModalFocus"

/** Providers shown before the "Show all" affordance. */
const PROVIDER_PAGE_SIZE = 5

/** OpenCode Go (and any other opencode integration) is pinned first. */
function integrationRank(integration: Integration): number {
  return /opencode/i.test(`${integration.id} ${integration.name}`) ? 0 : 1
}

/**
 * Settings > Providers (issue #128): connect an API key without host access.
 * Keys only transit this UI → BFF → opencode; they are never stored here, never
 * pre-filled and never echoed back. OAuth/command providers stay informational.
 */
export function ProvidersSection() {
  const queryClient = useQueryClient()
  const integrationsQuery = useIntegrations(client)
  const credentialsQuery = useProviderCredentials(client)
  const [connecting, setConnecting] = useState<Integration | null>(null)
  const [confirmingID, setConfirmingID] = useState<string | null>(null)
  const [busyID, setBusyID] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [showAll, setShowAll] = useState(false)

  const filtered = useMemo(() => {
    const sorted = [...(integrationsQuery.data ?? [])].sort((a, b) => integrationRank(a) - integrationRank(b))
    const needle = search.trim().toLowerCase()
    if (!needle) return sorted
    return sorted.filter((integration) => `${integration.name} ${integration.id}`.toLowerCase().includes(needle))
  }, [integrationsQuery.data, search])
  const visible = showAll ? filtered : filtered.slice(0, PROVIDER_PAGE_SIZE)
  const credentials = credentialsQuery.data ?? []

  async function refresh(): Promise<void> {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.integrations }),
      queryClient.invalidateQueries({ queryKey: queryKeys.credentials }),
    ])
  }

  async function disconnect(credentialID: string): Promise<void> {
    setBusyID(credentialID)
    setError(null)
    try {
      await client.api.removeCredential(credentialID)
      await refresh()
    } catch (err) {
      setError(err instanceof RequestTimeoutError
        ? "The server did not answer in time — the credential may still be there. Reopen settings to check."
        : "Could not disconnect the credential")
    } finally {
      setBusyID(null)
      setConfirmingID(null)
    }
  }

  async function activate(credentialID: string): Promise<void> {
    setBusyID(credentialID)
    setError(null)
    try {
      await client.api.activateCredential(credentialID)
      await refresh()
    } catch {
      setError("Could not switch the active credential")
    } finally {
      setBusyID(null)
    }
  }

  return (
    <section className="border-b border-hairline p-4" aria-labelledby="settings-providers">
      <h3
        id="settings-providers"
        className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-muted"
      >
        Providers
      </h3>

      {integrationsQuery.isLoading && <p className="text-xs text-ink-muted">Loading providers…</p>}
      {integrationsQuery.error && (
        <p className="text-xs text-danger">Could not load the provider catalog.</p>
      )}
      {!integrationsQuery.isLoading && filtered.length === 0 && !integrationsQuery.error && (
        <p className="text-xs text-ink-muted">
          {search.trim() ? "No provider matches that search." : "No provider integrations available."}
        </p>
      )}

      <input
        type="search"
        value={search}
        onChange={(event) => {
          setSearch(event.target.value)
          setShowAll(false)
        }}
        placeholder="Search providers…"
        aria-label="Search providers"
        className="mh-input mb-2 w-full"
      />

      <ul className="flex flex-col gap-2">
        {visible.map((integration) => {
          const keyMethod = integration.methods.find((method) => method.type === "key")
          const credentialConnections = integration.connections.filter(
            (connection) => connection.type === "credential" && connection.credentialID,
          )
          const connected = integration.connections.length > 0
          return (
            <li
              key={integration.id}
              className="rounded-md border border-hairline bg-surface p-3"
              data-testid={`integration-${integration.id}`}
            >
              <div className="flex items-center gap-2">
                <ProviderAvatar integration={integration} />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{integration.name}</span>
                {connected && (
                  <span className="mh-chip mh-chip--accent shrink-0">
                    Connected
                  </span>
                )}
              </div>

              {credentialConnections.length > 0 && (
                <ul className="mt-2 flex flex-col gap-1">
                  {credentialConnections.map((connection) => {
                    const credentialID = connection.credentialID!
                    const credential = credentials.find((entry) => entry.id === credentialID)
                    return (
                      <li key={credentialID} className="flex items-center gap-2 text-xs text-ink-muted">
                        <span className="min-w-0 flex-1 truncate">{connection.label ?? "API key"}</span>
                        {credential?.active && <span className="text-accent">Active</span>}
                        {credential && !credential.active && (
                          <button
                            type="button"
                            className="mh-btn mh-btn--sm mh-btn--quiet"
                            disabled={busyID === credentialID}
                            onClick={() => void activate(credentialID)}
                          >
                            Use
                          </button>
                        )}
                        {confirmingID === credentialID ? (
                          <>
                            <span className="text-danger">Disconnect?</span>
                            <button
                              type="button"
                              className="mh-btn mh-btn--sm mh-btn--danger"
                              disabled={busyID === credentialID}
                              onClick={() => void disconnect(credentialID)}
                            >
                              {busyID === credentialID ? "Removing…" : "Yes"}
                            </button>
                            <button
                              type="button"
                              className="mh-btn mh-btn--sm mh-btn--quiet"
                              onClick={() => setConfirmingID(null)}
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="mh-btn mh-btn--sm mh-btn--quiet"
                            disabled={busyID === credentialID}
                            onClick={() => setConfirmingID(credentialID)}
                          >
                            Disconnect
                          </button>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}

              {keyMethod && credentialConnections.length === 0 && (
                <button
                  type="button"
                  className="mh-btn mh-btn--secondary mh-btn--sm mt-2"
                  onClick={() => setConnecting(integration)}
                >
                  Connect
                </button>
              )}
              {!keyMethod && (
                <p className="mt-1 text-[11px] text-ink-muted">
                  {integration.methods.some((method) => method.type === "oauth")
                    ? "Connect this provider from the opencode CLI/TUI for now."
                    : "Set this provider's environment variable on the host for now."}
                </p>
              )}
            </li>
          )
        })}
      </ul>

      {!showAll && filtered.length > PROVIDER_PAGE_SIZE && (
        <button
          type="button"
          className="mh-btn mh-btn--quiet mt-2 w-full justify-start"
          onClick={() => setShowAll(true)}
        >
          Show all {filtered.length} providers
        </button>
      )}

      {error && <p className="mt-2 text-xs text-danger">{error}</p>}

      {connecting && (
        <ProviderKeyDialog
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
 * Provider glyph: opencode does not expose provider logos, so a deterministic
 * monogram stands in (with a passthrough for a future `metadata.icon` URL).
 */
function ProviderAvatar({ integration }: { integration: Integration }) {
  if (integration.icon) {
    return (
      <img
        src={integration.icon}
        alt=""
        data-testid="provider-avatar"
        className="h-7 w-7 shrink-0 rounded-md border border-hairline bg-canvas object-contain p-0.5"
      />
    )
  }
  return (
    <span
      aria-hidden="true"
      data-testid="provider-avatar"
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-accent-line bg-accent-soft text-xs font-semibold text-accent"
    >
      {providerMonogram(integration.name)}
    </span>
  )
}

function ProviderKeyDialog({
  integrationID,
  name,
  onClose,
  onConnected,
}: {
  integrationID: string
  name: string
  onClose: () => void
  onConnected: () => Promise<void>
}) {
  const dialogRef = useModalFocus<HTMLDivElement>(onClose)
  const [key, setKey] = useState("")
  const [label, setLabel] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (!key.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      // Write-only: the value lives in this component's state and is never
      // pre-filled or read back; connecting twice is not auto-retried.
      await client.api.connectIntegrationKey(integrationID, {
        key: key.trim(),
        ...(label.trim() ? { label: label.trim() } : {}),
      })
      setKey("")
      setLabel("")
      await onConnected()
    } catch (err) {
      setError(providerConnectErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center mh-overlay md:items-center md:p-4">
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="pb-safe mh-dialog w-full rounded-b-none outline-none md:rounded-xl"
        role="dialog"
        aria-modal="true"
        aria-label={`Connect ${name}`}
      >
        <h3 className="mh-dialog__title mh-heading-4">Connect {name}</h3>
        <p className="mh-body-sm text-ink-muted">
          The key goes straight to opencode and stays in its data volume. MasterHand never stores a copy.
        </p>
        <form onSubmit={(event) => void submit(event)} className="mt-3 flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs text-ink-muted">
            API key
            <input
              type="password"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder="sk-…"
              aria-label="API key"
              className="mh-input"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-muted">
            Label (optional)
            <input
              type="text"
              autoComplete="off"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="Personal"
              aria-label="Key label"
              className="mh-input"
            />
          </label>
          {error && <p className="text-xs text-danger">{error}</p>}
          <div className="mh-dialog__actions">
            <button type="button" onClick={onClose} disabled={busy} className="mh-btn mh-btn--secondary">
              Cancel
            </button>
            <button type="submit" disabled={!key.trim() || busy} className="mh-btn mh-btn--primary">
              {busy ? "Connecting…" : "Connect"}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
