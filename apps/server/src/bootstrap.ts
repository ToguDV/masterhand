import type { Hono } from "hono"
import { createApp, type AppDeps } from "./app.js"
import type { EngineMonitor } from "./engine.js"
import type { GoalManager } from "./goal.js"
import type { SchedulerManager } from "./scheduler.js"

/**
 * Composition root (issue #205): `createApp` builds the routes and the
 * managers but performs no boot reconciliation itself; this wrapper owns the
 * explicit boot pass and hands every lifecycle handle to the caller, so
 * `index.ts` (and the test harness) never reach into the app object.
 */
export interface BootstrappedApp {
  app: Hono
  goals: GoalManager
  scheduler: SchedulerManager
  /** Resilience monitor: started by the entry point after `hub.start()`. */
  engine: EngineMonitor
  /** Settles in-flight finishes and releases (issue #192 shutdown drain). */
  drainInFlight: () => Promise<void>
}

export function bootstrapApp(deps: AppDeps): BootstrappedApp {
  const built = createApp(deps)
  // Boot reconciliation is explicit here, never a `createApp` side effect:
  // in-flight goal runs are recorded as recoverable (or paused when
  // `RESILIENCE_AUTO_RESUME=false`) and orphaned scheduler runs settle
  // (firing → interrupted, queued → skipped) with every pending slot
  // recomputed. The engine monitor re-drives the recoverable work once
  // opencode answers.
  built.goals.reconcileOnBoot()
  built.scheduler.reconcileTasks()
  return {
    app: built.app,
    goals: built.goals,
    scheduler: built.scheduler,
    engine: built.engine,
    drainInFlight: built.drainInFlight,
  }
}
