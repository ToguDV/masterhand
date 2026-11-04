import type { EngineStatusView } from "./types"

/**
 * What the resilience banner can say about the agent engine.
 *
 * `unknown` is deliberately distinct from `stopped`: a supervisor that cannot
 * resolve the Compose project (or is unreachable) reports `state: "unknown"`,
 * but starting the engine cannot fix that and the old shared predicate made
 * the UI claim the engine was stopped and offer a Start button that answered
 * `404 not_found`.
 */
export type EngineAvailability = "unmanaged" | "running" | "restarting" | "circuit" | "stopped" | "unknown"

/** Docker states that mean "not running" and can be started again. */
const STOPPED_STATES = new Set(["exited", "dead", "created", "paused"])

/**
 * Classifies `/api/status.engine` for the banners. Order matters: the circuit
 * and an in-flight restart win over the container state, and a missing
 * supervisor disables the supervised states entirely.
 */
export function engineAvailability(engine: EngineStatusView | null | undefined): EngineAvailability {
  if (!engine || !engine.supervisor) return "unmanaged"
  if (engine.circuitOpen) return "circuit"
  if (engine.restarting || engine.state === "restarting") return "restarting"
  if (engine.state === "running") return "running"
  if (STOPPED_STATES.has(engine.state)) return "stopped"
  return "unknown"
}
