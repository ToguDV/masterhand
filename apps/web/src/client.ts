import { createClient } from "@masterhand/client-core"

// Deployments may tune the request deadline; E2E shortens it to keep specs fast.
const configured = Number(import.meta.env.VITE_REQUEST_TIMEOUT_MS ?? "")

export const client = createClient(
  Number.isFinite(configured) && configured > 0 ? { timeoutMs: configured } : {},
)
