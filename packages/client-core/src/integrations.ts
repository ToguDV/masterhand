/**
 * Provider integrations and their credentials (issue #128).
 *
 * The generated opencode client returns deeply nested readonly types; these
 * normalized view models keep the UI simple and tolerate missing/unknown fields
 * (older or newer opencode builds must never break the settings section).
 */

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
  return { id, name, methods, connections }
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
