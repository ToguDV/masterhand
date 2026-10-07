/**
 * Provider integrations and their credentials (issue #128).
 *
 * The generated opencode client returns deeply nested readonly types; these
 * normalized view models keep the UI simple and tolerate missing/unknown fields
 * (older or newer opencode builds must never break the settings section).
 */

import { providerIconSvgs } from "./provider-icons.generated"

export type IntegrationMethodType = "key" | "oauth" | "command" | "env"

export interface IntegrationMethod {
  /** Method id used by the connect call ("key", "oauth", a command id, "env"). */
  id: string
  type: IntegrationMethodType
  label: string
}

export interface IntegrationConnection {
  type: "credential" | "env"
  /** Credential id (only for `type: "credential"`), needed to remove it. */
  credentialID?: string
  label?: string
  method?: "key" | "oauth"
  status?: string
}

export interface Integration {
  id: string
  name: string
  methods: IntegrationMethod[]
  connections: IntegrationConnection[]
  /** Optional icon URL exposed by a fork/plugin via `metadata.icon` or `metadata.logo`. */
  icon?: string
}

export interface ProviderCredential {
  id: string
  integrationID: string
  label: string
  active: boolean
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

function normalizeMethod(raw: unknown): IntegrationMethod | null {
  const record = asRecord(raw)
  const type = record?.type
  if (!record || (type !== "key" && type !== "oauth" && type !== "command" && type !== "env")) return null
  if (type === "key") return { id: "key", type, label: asString(record.label) ?? "API key" }
  if (type === "env") {
    const names = Array.isArray(record.names)
      ? record.names.filter((name): name is string => typeof name === "string")
      : []
    return { id: "env", type, label: names.length > 0 ? names.join(", ") : "Environment variable" }
  }
  const id = asString(record.id) ?? type
  return { id, type, label: asString(record.label) ?? id }
}

function normalizeConnection(raw: unknown): IntegrationConnection | null {
  const record = asRecord(raw)
  const type = record?.type
  if (!record || (type !== "credential" && type !== "env")) return null
  const method = record.method === "key" || record.method === "oauth" ? record.method : undefined
  const status = asRecord(record.status) ? asString((record.status as Record<string, unknown>).status) : null
  return {
    type,
    ...(asString(record.id) ? { credentialID: asString(record.id)! } : {}),
    ...(asString(record.label) ? { label: asString(record.label)! } : {}),
    ...(method ? { method } : {}),
    ...(status ? { status } : {}),
  }
}

export function normalizeIntegration(raw: unknown): Integration | null {
  const record = asRecord(raw)
  const id = asString(record?.id)
  const name = asString(record?.name)
  if (!record || !id || !name) return null
  const methods = Array.isArray(record.methods)
    ? record.methods.map(normalizeMethod).filter((method): method is IntegrationMethod => method !== null)
    : []
  const connections = Array.isArray(record.connections)
    ? record.connections
        .map(normalizeConnection)
        .filter((connection): connection is IntegrationConnection => connection !== null)
    : []
  const metadata = asRecord(record.metadata)
  const icon = asString(metadata?.icon) ?? asString(metadata?.logo)
  return { id, name, methods, connections, ...(icon ? { icon } : {}) }
}

/**
 * One-letter avatar fallback for a provider without a vendored brand mark:
 * the first letter or digit of its name, uppercased. Falls back to "?".
 */
export function providerMonogram(name: string): string {
  const match = name.trim().match(/[a-z0-9]/i)
  return match ? match[0].toUpperCase() : "?"
}

/**
 * Original brand mark for an integration id (see
 * `scripts/generate-provider-icons.mjs`), as normalized SVG markup ready to be
 * rendered inline. `null` for providers without a vendored logo, so the caller
 * can fall back to `providerMonogram`.
 */
export function providerIcon(id: string): string | null {
  return providerIconSvgs[id.trim().toLowerCase()] ?? null
}

/**
 * Curated importance order for the provider list: the opencode integrations
 * first, then the providers people reach for most. Ids missing here fall in
 * after the listed ones (still ahead of iconless providers).
 */
const PROVIDER_IMPORTANCE: readonly string[] = [
  "opencode-go",
  "opencode",
  "anthropic",
  "openai",
  "google",
  "google-vertex",
  "xai",
  "deepseek",
  "meta",
  "mistral",
  "openrouter",
  "groq",
  "cerebras",
  "togetherai",
  "perplexity",
  "perplexity-agent",
  "cohere",
  "nvidia",
  "alibaba",
  "zai",
  "zhipuai",
  "zai-coding-plan",
  "moonshotai",
  "moonshotai-cn",
  "minimax",
  "minimax-cn",
  "minimax-coding-plan",
  "amazon-bedrock",
  "azure",
  "github-copilot",
  "gitlab",
  "cloudflare-workers-ai",
  "fireworks-ai",
  "deepinfra",
  "novita-ai",
  "nebius",
  "baseten",
  "modal",
  "vercel",
  "huggingface",
  "poe",
  "venice",
  "modelscope",
  "siliconflow",
  "siliconflow-cn",
]

const providerImportance = new Map(PROVIDER_IMPORTANCE.map((id, index) => [id, index]))

/**
 * Sort order for the provider list (issue #128). Providers with a vendored
 * brand mark come first — so the visible page shows real, established logos —
 * ordered by the curated importance list, then the rest by name. Unknown icon
 * providers land between both groups. Ties break alphabetically so the order
 * stays stable across refreshes.
 */
export function compareIntegrations(a: Integration, b: Integration): number {
  const byIcon = (providerIcon(a.id) ? 0 : 1) - (providerIcon(b.id) ? 0 : 1)
  if (byIcon !== 0) return byIcon
  const aRank = providerImportance.get(a.id.trim().toLowerCase()) ?? Number.MAX_SAFE_INTEGER
  const bRank = providerImportance.get(b.id.trim().toLowerCase()) ?? Number.MAX_SAFE_INTEGER
  if (aRank !== bRank) return aRank - bRank
  return a.name.localeCompare(b.name)
}

export function normalizeIntegrations(raw: unknown): Integration[] {
  if (!Array.isArray(raw)) return []
  return raw.map(normalizeIntegration).filter((integration): integration is Integration => integration !== null)
}

export function normalizeCredentials(raw: unknown): ProviderCredential[] {
  if (!Array.isArray(raw)) return []
  const credentials: ProviderCredential[] = []
  for (const entry of raw) {
    const record = asRecord(entry)
    const id = asString(record?.id)
    const integrationID = asString(record?.integrationID)
    if (!id || !integrationID) continue
    credentials.push({
      id,
      integrationID,
      label: asString(record?.label) ?? id,
      active: record?.active === true,
    })
  }
  return credentials
}
