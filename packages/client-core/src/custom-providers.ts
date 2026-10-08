/**
 * Custom OpenAI-compatible providers.
 *
 * The BFF stores the definition in an opencode config file it owns; the API key
 * travels separately through opencode's `connect/key` endpoint. These view
 * models keep the client tolerant of missing/unknown fields.
 */

export type CustomProviderPackage = "openai-compatible" | "openai"

export interface CustomProviderModel {
  id: string
  name?: string
  /** Usable context window, in tokens (only set together with `output`). */
  context?: number
  /** Maximum output tokens (only set together with `context`). */
  output?: number
}

export interface CustomProvider {
  id: string
  name: string
  baseURL: string
  package: CustomProviderPackage
  models: CustomProviderModel[]
  headers?: Record<string, string>
}

export interface CustomProviderInput {
  id: string
  name: string
  baseURL: string
  package?: CustomProviderPackage
  models: CustomProviderModel[]
  headers?: Record<string, string>
  /** API key to connect on create; consumed by the BFF and never stored by it. */
  key?: string
  /** Optional label for the stored credential. */
  label?: string
}

export interface CustomProviderCreateResult {
  provider: CustomProvider
  /** Whether the API key was connected (`false` when none was sent or opencode lagged). */
  connected: boolean
}

export interface DiscoverModelsInput {
  baseURL: string
  /** Transient key forwarded to the provider's `/models`; never stored by the BFF. */
  key?: string
  headers?: Record<string, string>
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

/** opencode's own rule for a custom provider id (matches the TUI). */
export function isValidProviderId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-_]*$/.test(id) && id.length <= 64
}

/**
 * Derives a stable provider id from a display name (lowercase, runs of
 * non-alphanumerics to `-`). Empty when the name has no usable leading
 * alphanumeric, so the form falls back to the user typing one.
 */
export function providerIdFromName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
  return isValidProviderId(slug) ? slug : ""
}

function normalizeModel(raw: unknown): CustomProviderModel | null {
  const record = asRecord(raw)
  const id = asString(record?.id)
  if (!record || !id) return null
  const name = asString(record.name)
  const context = typeof record.context === "number" ? record.context : undefined
  const output = typeof record.output === "number" ? record.output : undefined
  return {
    id,
    ...(name ? { name } : {}),
    ...(context !== undefined && output !== undefined ? { context, output } : {}),
  }
}

function normalizeHeaders(raw: unknown): Record<string, string> | undefined {
  const record = asRecord(raw)
  if (!record) return undefined
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" && key.length > 0) headers[key] = value
  }
  return Object.keys(headers).length > 0 ? headers : undefined
}

export function normalizeCustomProvider(raw: unknown): CustomProvider | null {
  const record = asRecord(raw)
  if (!record) return null
  const id = asString(record.id)
  const name = asString(record.name)
  const baseURL = asString(record.baseURL)
  const providerPackage = record.package === "openai" ? "openai" : "openai-compatible"
  if (!id || !name || !baseURL) return null
  const models = Array.isArray(record.models)
    ? record.models.map(normalizeModel).filter((model): model is CustomProviderModel => model !== null)
    : []
  const headers = normalizeHeaders(record.headers)
  return { id, name, baseURL, package: providerPackage, models, ...(headers ? { headers } : {}) }
}

export function normalizeCustomProviders(raw: unknown): CustomProvider[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map(normalizeCustomProvider)
    .filter((provider): provider is CustomProvider => provider !== null)
}

export function normalizeCustomProviderCreateResult(raw: unknown): CustomProviderCreateResult | null {
  const record = asRecord(raw)
  const provider = normalizeCustomProvider(record?.provider)
  if (!record || !provider) return null
  return { provider, connected: record.connected === true }
}

/** Models returned by the discovery endpoint, already id/name shaped. */
export function normalizeDiscoveredModels(raw: unknown): CustomProviderModel[] {
  if (!Array.isArray(raw)) return []
  return raw.map(normalizeModel).filter((model): model is CustomProviderModel => model !== null)
}
