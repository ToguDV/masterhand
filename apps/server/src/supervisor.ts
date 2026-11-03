/**
 * BFF client of the resilience supervisor sidecar (`deploy/watchdog`).
 *
 * The BFF never touches the Docker socket (rule 44 / ADR-41): it calls this
 * first-party sidecar with a shared token on the internal network. The client
 * is deliberately read-only for status (a malformed or slow sidecar must never
 * fail `/api/status`) and every mutation is bounded and never auto-retried.
 */

export interface SupervisorMemory {
  usedBytes: number
  limitBytes: number
}

export interface SupervisorIncident {
  at: number
  service: string
  reason: string
  attempt: number
  memory: SupervisorMemory | null
}

export interface SupervisorServiceSnapshot {
  service: string
  /** running | exited | stopped | restarting | unknown */
  state: string
  /** healthy | unhealthy | starting | none */
  health: string
  memory: SupervisorMemory | null
  attempts: number
  maxAttempts: number
  circuitOpen: boolean
  restarting: boolean
  memoryWarning: boolean
  lastIncident: SupervisorIncident | null
}

export interface SupervisorStatus {
  services: Record<string, SupervisorServiceSnapshot>
}

export interface SupervisorActionResult {
  ok: boolean
  /** `supervisor_unavailable`, `not_found`, or the sidecar's error code. */
  error?: string
  /** HTTP status when the sidecar answered. */
  status?: number
}

export interface SupervisorClient {
  readonly enabled: boolean
  /** Status snapshot, or null when disabled/unreachable/malformed. */
  status(): Promise<SupervisorStatus | null>
  /** Restarts (or starts) one allowed service after clearing its circuit. */
  restart(service: "opencode"): Promise<SupervisorActionResult>
  /** Clears the budget/circuit without restarting. */
  reset(service: "opencode"): Promise<SupervisorActionResult>
}

export interface SupervisorClientOptions {
  url: string | null
  token: string | null
  fetchImpl?: typeof fetch
  /** Status deadline (default 2 s). */
  statusTimeoutMs?: number
  /** Action deadline (default 8 s). */
  actionTimeoutMs?: number
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback
}

function asMemory(value: unknown): SupervisorMemory | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const record = value as { usedBytes?: unknown; limitBytes?: unknown }
  const usedBytes = asNumber(record.usedBytes, -1)
  const limitBytes = asNumber(record.limitBytes, -1)
  if (usedBytes < 0 || limitBytes <= 0) return null
  return { usedBytes, limitBytes }
}

function asIncident(value: unknown): SupervisorIncident | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  return {
    at: asNumber(record.at),
    service: asString(record.service),
    reason: asString(record.reason, "unknown"),
    attempt: asNumber(record.attempt),
    memory: asMemory(record.memory),
  }
}

function asService(value: unknown): SupervisorServiceSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  return {
    service: asString(record.service),
    state: asString(record.state, "unknown"),
    health: asString(record.health, "none"),
    memory: asMemory(record.memory),
    attempts: asNumber(record.attempts),
    maxAttempts: asNumber(record.maxAttempts, 3),
    circuitOpen: record.circuitOpen === true,
    restarting: record.restarting === true,
    memoryWarning: record.memoryWarning === true,
    lastIncident: asIncident(record.lastIncident),
  }
}

/** Defensive parse: an unknown shape is "no status", never a thrown route. */
export function parseSupervisorStatus(value: unknown): SupervisorStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const services = (value as { services?: unknown }).services
  if (!services || typeof services !== "object" || Array.isArray(services)) return null
  const parsed: Record<string, SupervisorServiceSnapshot> = {}
  for (const [name, raw] of Object.entries(services as Record<string, unknown>)) {
    const service = asService(raw)
    if (service) parsed[name] = { ...service, service: service.service || name }
  }
  return { services: parsed }
}

export function createSupervisorClient(options: SupervisorClientOptions): SupervisorClient {
  const fetchImpl = options.fetchImpl ?? fetch
  const url = options.url?.trim().replace(/\/+$/, "") || null
  const token = options.token?.trim() || null
  const statusTimeoutMs = options.statusTimeoutMs ?? 2_000
  const actionTimeoutMs = options.actionTimeoutMs ?? 8_000
  const enabled = Boolean(url && token)

  async function request(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    return fetchImpl(`${url}${path}`, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        ...(init.headers ?? {}),
        authorization: `Bearer ${token}`,
        accept: "application/json",
      },
    })
  }

  async function action(service: "opencode", path: string): Promise<SupervisorActionResult> {
    if (!enabled) return { ok: false, error: "supervisor_unavailable" }
    try {
      const response = await request(
        path,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ service }),
        },
        actionTimeoutMs,
      )
      if (response.ok) return { ok: true, status: response.status }
      let error = `supervisor_${response.status}`
      try {
        const body = (await response.json()) as { error?: unknown }
        if (typeof body.error === "string" && body.error) error = body.error
      } catch {
        // keep the status-based code
      }
      return { ok: false, error, status: response.status }
    } catch {
      return { ok: false, error: "supervisor_unavailable" }
    }
  }

  return {
    enabled,
    async status() {
      if (!enabled) return null
      try {
        const response = await request("/status", { method: "GET" }, statusTimeoutMs)
        if (!response.ok) return null
        return parseSupervisorStatus(await response.json())
      } catch {
        return null
      }
    },
    restart(service) {
      return action(service, "/restart")
    },
    reset(service) {
      return action(service, "/reset")
    },
  }
}
