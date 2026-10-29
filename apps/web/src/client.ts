import { createClient, type Client } from "@masterhand/client-core"

// Deployments may tune the request deadline; E2E shortens it to keep specs fast.
const configured = Number(import.meta.env.VITE_REQUEST_TIMEOUT_MS ?? "")
// `finish` (commit + push + PR) has its own, longer budget.
const finishConfigured = Number(import.meta.env.VITE_FINISH_TIMEOUT_MS ?? "")

function tuning(): { timeoutMs?: number; finishTimeoutMs?: number } {
  return {
    ...(Number.isFinite(configured) && configured > 0 ? { timeoutMs: configured } : {}),
    ...(Number.isFinite(finishConfigured) && finishConfigured > 0
      ? { finishTimeoutMs: finishConfigured }
      : {}),
  }
}

/** Builds a client for one server profile. */
export function createServerClient(options: {
  baseUrl?: string
  getToken?: () => string | null
  onUnauthorized?: () => void
  timeoutMs?: number
}): Client {
  return createClient({ ...tuning(), ...options })
}

/**
 * The active server's client. Components keep importing the singleton, but it
 * is a thin proxy over whichever client the root mounted, so every request
 * goes to exactly one server. Switching servers remounts the authenticated
 * subtree and stops its SSE stream; the proxy never holds state of its own.
 */
let activeClient: Client = createServerClient({})

export function setActiveClient(client: Client): void {
  activeClient = client
}

export function getActiveClient(): Client {
  return activeClient
}

export const client: Client = new Proxy({} as Client, {
  get(_target, property) {
    const value = Reflect.get(activeClient as object, property) as unknown
    return typeof value === "function" ? value.bind(activeClient) : value
  },
})
