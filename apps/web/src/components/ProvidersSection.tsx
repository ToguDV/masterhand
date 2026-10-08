import { useMemo, useState, type FormEvent } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  RequestTimeoutError,
  compareIntegrations,
  customProviderErrorMessage,
  isValidProviderId,
  providerConnectErrorMessage,
  providerIcon,
  providerIdFromName,
  providerMonogram,
  queryKeys,
  useCustomProviders,
  useIntegrations,
  useProviderCredentials,
  type Client,
  type CustomProvider,
  type CustomProviderCreateResult,
  type CustomProviderPackage,
  type Integration,
} from "@masterhand/client-core"
import { client } from "../client"
import { useModalFocus } from "./useModalFocus"

/** Providers shown before the "Show all" affordance. */
const PROVIDER_PAGE_SIZE = 5

/**
 * Settings > Providers (#128): connect an API key without host access, and add
 * custom OpenAI-compatible providers. Keys only transit this UI → BFF →
 * opencode; they are never stored here, never pre-filled and never echoed
 * back. The "Add provider" action stays pinned above the list.
 */
export function ProvidersSection() {
  const queryClient = useQueryClient()
  const integrationsQuery = useIntegrations(client)
  const credentialsQuery = useProviderCredentials(client)
  const customQuery = useCustomProviders(client)
  const [connecting, setConnecting] = useState<Integration | null>(null)
  const [connectingCustom, setConnectingCustom] = useState<CustomProvider | null>(null)
  const [confirmingID, setConfirmingID] = useState<string | null>(null)
  const [removingProvider, setRemovingProvider] = useState<CustomProvider | null>(null)
  const [busyID, setBusyID] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [showAll, setShowAll] = useState(false)

  const filtered = useMemo(() => {
    const sorted = [...(integrationsQuery.data ?? [])].sort(compareIntegrations)
    const needle = search.trim().toLowerCase()
    if (!needle) return sorted
    return sorted.filter((integration) => `${integration.name} ${integration.id}`.toLowerCase().includes(needle))
  }, [integrationsQuery.data, search])
  const visible = showAll ? filtered : filtered.slice(0, PROVIDER_PAGE_SIZE)
  const credentials = credentialsQuery.data ?? []
  const customProviders = customQuery.data ?? []
  const integrationByID = useMemo(
    () => new Map((integrationsQuery.data ?? []).map((integration) => [integration.id, integration])),
    [integrationsQuery.data],
  )

  async function refresh(): Promise<void> {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.integrations }),
      queryClient.invalidateQueries({ queryKey: queryKeys.credentials }),
      queryClient.invalidateQueries({ queryKey: queryKeys.customProviders }),
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

  async function removeProvider(provider: CustomProvider): Promise<void> {
    setBusyID(provider.id)
    setError(null)
    try {
      await client.api.removeCustomProvider(provider.id)
      await refresh()
    } catch (err) {
      setError(customProviderErrorMessage(err))
    } finally {
      setBusyID(null)
      setRemovingProvider(null)
    }
  }

  function credentialRow(integrationID: string, name: string, connection: { credentialID?: string; label?: string }) {
    const credentialID = connection.credentialID!
    const credential = credentials.find((entry) => entry.id === credentialID)
    const label = connection.label?.trim()
    const showLabel = Boolean(label) && label!.toLowerCase() !== name.trim().toLowerCase()
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
              className="mh-btn mh-btn--sm mh-btn--quiet"
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
        <span className="min-w-0 flex-1 truncate">{showLabel ? label : "API key"}</span>
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
      </li>
    )
  }

  return (
    <section aria-labelledby="settings-providers">
      {/* Pinned above the provider list: adding a provider never scrolls away. */}
      <div className="mh-providers__head">
        <div className="min-w-0">
          <h3 id="settings-providers" className="mh-settings__title">
            Providers
          </h3>
          <p className="mh-settings__desc">Connect provider API keys and manage the stored credentials.</p>
        </div>
        <button
          type="button"
          className="mh-btn mh-btn--primary mh-btn--sm shrink-0"
          data-testid="add-custom-provider"
          onClick={() => {
            setAdding(true)
            setNotice(null)
          }}
        >
          Add provider
        </button>
      </div>

      {customQuery.isLoading && <p className="mt-4 text-xs text-ink-muted">Loading custom providers…</p>}
      {customQuery.error && (
        <p className="mt-4 text-xs text-danger">Could not load the custom providers.</p>
      )}

      {customProviders.length > 0 && (
        <div className="mt-4">
          <p className="mh-caption mh-muted">Custom providers</p>
          <ul className="flex flex-col gap-2">
            {customProviders.map((provider) => {
              const integration = integrationByID.get(provider.id)
              const credentialConnections = (integration?.connections ?? []).filter(
                (connection) => connection.type === "credential" && connection.credentialID,
              )
              const connected = credentialConnections.length > 0 || integration?.connections.length
              const busy = busyID === provider.id
              return (
                <li
                  key={provider.id}
                  className="rounded-md border border-hairline bg-surface p-3"
                  data-testid={`custom-provider-${provider.id}`}
                >
                  <div className="flex items-center gap-2">
                    <ProviderAvatar integration={{ id: provider.id, name: provider.name, methods: [], connections: [] }} />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{provider.name}</span>
                    {connected ? <span className="mh-chip mh-chip--accent shrink-0">Connected</span> : null}
                  </div>
                  <p className="mt-1 truncate text-[11px] text-ink-muted">{provider.baseURL}</p>

                  {credentialConnections.length > 0 && (
                    <ul className="mt-2 flex flex-col gap-1">
                      {credentialConnections.map((connection) =>
                        credentialRow(provider.id, provider.name, connection),
                      )}
                    </ul>
                  )}

                  <div className="mt-2 flex flex-wrap gap-2">
                    {credentialConnections.length === 0 && (
                      <button
                        type="button"
                        className="mh-btn mh-btn--secondary mh-btn--sm"
                        disabled={busy}
                        onClick={() => setConnectingCustom(provider)}
                      >
                        Connect
                      </button>
                    )}
                    {removingProvider?.id === provider.id ? (
                      <>
                        <span className="self-center text-xs text-danger">Remove provider?</span>
                        <button
                          type="button"
                          className="mh-btn mh-btn--sm mh-btn--danger"
                          disabled={busy}
                          onClick={() => void removeProvider(provider)}
                        >
                          {busy ? "Removing…" : "Yes"}
                        </button>
                        <button
                          type="button"
                          className="mh-btn mh-btn--sm mh-btn--quiet"
                          onClick={() => setRemovingProvider(null)}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="mh-btn mh-btn--sm mh-btn--quiet"
                        disabled={busy}
                        onClick={() => setRemovingProvider(provider)}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      <p className="mh-caption mh-muted mt-4">Catalog</p>
      {integrationsQuery.isLoading && <p className="mt-2 text-xs text-ink-muted">Loading providers…</p>}
      {integrationsQuery.error && (
        <p className="mt-2 text-xs text-danger">Could not load the provider catalog.</p>
      )}
      {!integrationsQuery.isLoading && filtered.length === 0 && !integrationsQuery.error && (
        <p className="mt-2 text-xs text-ink-muted">
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
        className="mh-input mt-2 mb-2 w-full"
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
                  {credentialConnections.map((connection) => credentialRow(integration.id, integration.name, connection))}
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

      {notice && <p className="mt-2 text-xs text-accent">{notice}</p>}
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

      {connectingCustom && (
        <ProviderKeyDialog
          integrationID={connectingCustom.id}
          name={connectingCustom.name}
          onClose={() => setConnectingCustom(null)}
          onConnected={async () => {
            setConnectingCustom(null)
            await refresh()
          }}
        />
      )}

      {adding && (
        <AddProviderDialog
          client={client}
          onClose={() => setAdding(false)}
          onCreated={async (result) => {
            setAdding(false)
            await refresh()
            setError(null)
            if (result.connected) setNotice(`${result.provider.name} added and connected.`)
            else setNotice(`${result.provider.name} added. Connect its API key to use it.`)
          }}
        />
      )}
    </section>
  )
}

/**
 * Provider glyph: the original brand mark when vendored (models.dev), an
 * explicit `metadata.icon` URL when the backend provides one, and otherwise a
 * deterministic monogram.
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
  const icon = providerIcon(integration.id)
  if (icon) {
    return (
      <span
        aria-hidden="true"
        data-testid="provider-avatar"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-hairline bg-canvas text-ink [&_svg]:h-4 [&_svg]:w-4"
        dangerouslySetInnerHTML={{ __html: icon }}
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

interface ModelRow {
  key: string
  id: string
  name: string
  context: string
  output: string
}

/** Stable row keys without `crypto.randomUUID` (unavailable over plain HTTP). */
let rowSeq = 0
function nextRowKey(): string {
  rowSeq += 1
  return `row-${rowSeq}`
}

function newModelRow(): ModelRow {
  return { key: nextRowKey(), id: "", name: "", context: "", output: "" }
}

/** Validates an http(s) URL the same way the BFF does before enabling submit. */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

function positiveInteger(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function AddProviderDialog({
  client,
  onClose,
  onCreated,
}: {
  client: Client
  onClose: () => void
  onCreated: (result: CustomProviderCreateResult) => Promise<void>
}) {
  const dialogRef = useModalFocus<HTMLDivElement>(onClose)
  const [name, setName] = useState("")
  const [id, setID] = useState("")
  const [idTouched, setIDTouched] = useState(false)
  const [baseURL, setBaseURL] = useState("")
  const [key, setKey] = useState("")
  const [providerPackage, setProviderPackage] = useState<CustomProviderPackage>("openai-compatible")
  const [models, setModels] = useState<ModelRow[]>([newModelRow()])
  const [advanced, setAdvanced] = useState(false)
  const [headers, setHeaders] = useState<Array<{ key: string; name: string; value: string }>>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const validModels = models.filter((model) => model.id.trim().length > 0)
  const canSubmit =
    !busy &&
    Boolean(name.trim()) &&
    isValidProviderId(id.trim()) &&
    isHttpUrl(baseURL.trim()) &&
    validModels.length > 0

  function updateModel(key: string, patch: Partial<ModelRow>): void {
    setModels((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)))
  }

  function addHeader(): void {
    setHeaders((rows) => [...rows, { key: nextRowKey(), name: "", value: "" }])
  }

  function updateHeader(key: string, patch: Partial<{ name: string; value: string }>): void {
    setHeaders((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)))
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    const headerObject: Record<string, string> = {}
    for (const header of headers) {
      if (header.name.trim()) headerObject[header.name.trim()] = header.value
    }
    try {
      const result = await client.api.createCustomProvider({
        id: id.trim(),
        name: name.trim(),
        baseURL: baseURL.trim(),
        package: providerPackage,
        models: validModels.map((model) => {
          const context = positiveInteger(model.context)
          const output = positiveInteger(model.output)
          return {
            id: model.id.trim(),
            ...(model.name.trim() ? { name: model.name.trim() } : {}),
            ...(context !== undefined && output !== undefined ? { context, output } : {}),
          }
        }),
        ...(Object.keys(headerObject).length > 0 ? { headers: headerObject } : {}),
        ...(key.trim() ? { key: key.trim() } : {}),
      })
      setKey("")
      await onCreated(result)
    } catch (err) {
      setError(customProviderErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center mh-overlay md:items-center md:p-4">
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="pb-safe mh-dialog max-h-[100dvh] w-full overflow-y-auto rounded-b-none outline-none md:max-h-[90dvh] md:rounded-xl"
        role="dialog"
        aria-modal="true"
        aria-label="Add OpenAI-compatible provider"
      >
        <h3 className="mh-dialog__title mh-heading-4">Add OpenAI-compatible provider</h3>
        <p className="mh-body-sm text-ink-muted">
          opencode gains the provider's models; the key stays in opencode's data volume.
        </p>
        <form onSubmit={(event) => void submit(event)} className="mt-3 flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs text-ink-muted">
            Display name
            <input
              type="text"
              autoComplete="off"
              autoFocus
              value={name}
              onChange={(event) => {
                const value = event.target.value
                setName(value)
                if (!idTouched) setID(providerIdFromName(value))
              }}
              placeholder="Acme AI"
              aria-label="Display name"
              className="mh-input"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-muted">
            Provider id
            <input
              type="text"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={id}
              onChange={(event) => {
                setIDTouched(true)
                setID(event.target.value.toLowerCase())
              }}
              placeholder="acme"
              aria-label="Provider id"
              className="mh-input"
            />
            <span className="text-[11px] text-ink-muted">
              Lowercase letters, numbers, hyphens or underscores. Used in model ids.
            </span>
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-muted">
            Base URL
            <input
              type="url"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={baseURL}
              onChange={(event) => setBaseURL(event.target.value)}
              placeholder="https://api.acme.example/v1"
              aria-label="Base URL"
              className="mh-input"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-muted">
            API key (optional)
            <input
              type="password"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder="sk-…"
              aria-label="API key"
              className="mh-input"
            />
          </label>

          <div className="flex flex-col gap-2">
            <span className="text-xs text-ink-muted">Models</span>
            {models.map((model) => (
              <div key={model.key} className="rounded-md border border-hairline p-2">
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input
                    type="text"
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    value={model.id}
                    onChange={(event) => updateModel(model.key, { id: event.target.value })}
                    placeholder="model-id"
                    aria-label="Model id"
                    className="mh-input flex-1"
                  />
                  <input
                    type="text"
                    autoComplete="off"
                    value={model.name}
                    onChange={(event) => updateModel(model.key, { name: event.target.value })}
                    placeholder="Display name (optional)"
                    aria-label="Model display name"
                    className="mh-input flex-1"
                  />
                </div>
                {advanced && (
                  <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                    <input
                      type="number"
                      min={1}
                      value={model.context}
                      onChange={(event) => updateModel(model.key, { context: event.target.value })}
                      placeholder="Context tokens"
                      aria-label="Context tokens"
                      className="mh-input flex-1"
                    />
                    <input
                      type="number"
                      min={1}
                      value={model.output}
                      onChange={(event) => updateModel(model.key, { output: event.target.value })}
                      placeholder="Output tokens"
                      aria-label="Output tokens"
                      className="mh-input flex-1"
                    />
                  </div>
                )}
                {models.length > 1 && (
                  <button
                    type="button"
                    className="mh-btn mh-btn--sm mh-btn--quiet mt-2"
                    onClick={() => setModels((rows) => rows.filter((row) => row.key !== model.key))}
                  >
                    Remove model
                  </button>
                )}
              </div>
            ))}
            <button
              type="button"
              className="mh-btn mh-btn--sm mh-btn--quiet self-start"
              onClick={() => setModels((rows) => [...rows, newModelRow()])}
            >
              Add model
            </button>
          </div>

          <button
            type="button"
            className="mh-btn mh-btn--sm mh-btn--quiet self-start"
            aria-expanded={advanced}
            onClick={() => setAdvanced((value) => !value)}
          >
            {advanced ? "Hide advanced" : "Advanced"}
          </button>

          {advanced && (
            <div className="flex flex-col gap-3 rounded-md border border-hairline p-2">
              <fieldset className="flex flex-col gap-1">
                <legend className="text-xs text-ink-muted">Transport</legend>
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="radio"
                    name="provider-package"
                    checked={providerPackage === "openai-compatible"}
                    onChange={() => setProviderPackage("openai-compatible")}
                  />
                  Chat completions (/v1/chat/completions)
                </label>
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="radio"
                    name="provider-package"
                    checked={providerPackage === "openai"}
                    onChange={() => setProviderPackage("openai")}
                  />
                  Responses (/v1/responses)
                </label>
              </fieldset>
              <div className="flex flex-col gap-2">
                <span className="text-xs text-ink-muted">Custom headers</span>
                {headers.map((header) => (
                  <div key={header.key} className="flex gap-2">
                    <input
                      type="text"
                      autoComplete="off"
                      value={header.name}
                      onChange={(event) => updateHeader(header.key, { name: event.target.value })}
                      placeholder="Header"
                      aria-label="Header name"
                      className="mh-input flex-1"
                    />
                    <input
                      type="text"
                      autoComplete="off"
                      value={header.value}
                      onChange={(event) => updateHeader(header.key, { value: event.target.value })}
                      placeholder="Value"
                      aria-label="Header value"
                      className="mh-input flex-1"
                    />
                    <button
                      type="button"
                      className="mh-btn mh-btn--sm mh-btn--quiet"
                      onClick={() => setHeaders((rows) => rows.filter((row) => row.key !== header.key))}
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="mh-btn mh-btn--sm mh-btn--quiet self-start"
                  onClick={addHeader}
                >
                  Add header
                </button>
              </div>
            </div>
          )}

          {error && <p className="text-xs text-danger">{error}</p>}
          <div className="mh-dialog__actions">
            <button type="button" onClick={onClose} disabled={busy} className="mh-btn mh-btn--secondary">
              Cancel
            </button>
            <button type="submit" disabled={!canSubmit} className="mh-btn mh-btn--primary">
              {busy ? "Adding…" : "Add provider"}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
