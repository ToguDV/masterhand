import type { Hono } from "hono"
import { createApp, type AppDeps } from "./app.js"
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
  /** Settles in-flight finishes and releases (issue #192 shutdown drain). */
  drainInFlight: () => Promise<void>
}

export function bootstrapApp(deps: AppDeps): BootstrappedApp {
  const built = createApp(deps)
  // Boot reconciliation is explicit here, never a `createApp` side effect:
  // in-flight goal runs surface as paused (never auto-resume) and orphaned
  // scheduler runs settle (firing → interrupted, queued → skipped) with every
  // pending slot recomputed.
  built.goals.reconcileOnBoot()
  built.scheduler.reconcileTasks()
  return { app: built.app, goals: built.goals, scheduler: built.scheduler, drainInFlight: built.drainInFlight }
}
