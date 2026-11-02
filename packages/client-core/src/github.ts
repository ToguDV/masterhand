/**
 * GitHub account integration (Settings > GitHub).
 *
 * The token is write-only: it goes up once in `PUT /api/github` and the BFF
 * never returns it. The status object only carries the public account identity
 * plus whether the agent container received the credential files.
 */

export interface GithubStatus {
  connected: boolean
  login: string | null
  name: string | null
  avatarUrl: string | null
  scopes: string[]
  updatedAt: string | null
  /** True when the BFF wrote the credential files to the shared agent volume. */
  injected: boolean
  /** Why injection failed, when it did. */
  agentConfigError: string | null
}

export const DISCONNECTED_GITHUB: GithubStatus = {
  connected: false,
  login: null,
  name: null,
  avatarUrl: null,
  scopes: [],
  updatedAt: null,
  injected: false,
  agentConfigError: null,
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

/** Tolerates older/newer servers; malformed input reads as disconnected. */
export function normalizeGithubStatus(raw: unknown): GithubStatus {
  const record = asRecord(raw)
  if (!record || record.connected !== true) return { ...DISCONNECTED_GITHUB }
  const scopes = Array.isArray(record.scopes)
    ? record.scopes.filter((scope): scope is string => typeof scope === "string" && scope.length > 0)
    : []
  return {
    connected: true,
    login: asString(record.login),
    name: asString(record.name),
    avatarUrl: asString(record.avatarUrl),
    scopes,
    updatedAt: asString(record.updatedAt),
    injected: record.injected === true,
    agentConfigError: asString(record.agentConfigError),
  }
}
