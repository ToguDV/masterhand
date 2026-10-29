import { defineConfig, devices } from "@playwright/test"

// The flows a client-only change must never break. CI runs this list as the
// `smoke` project (`.github/workflows/ci.yml`); the `full` project runs every
// other spec, so both projects together always cover the suite exactly once
// (no duplicated or dropped file). Guarded by scripts/ci-workflow.test.mjs.
const SMOKE_SPECS = [
  "**/chat.spec.ts",
  "**/permissions.spec.ts",
  "**/permission-ambiguity.spec.ts",
  "**/reconnect.spec.ts",
  "**/run.spec.ts",
  "**/composer-stuck.spec.ts",
  "**/workspaces.spec.ts",
  "**/design.spec.ts",
  "**/mobile-nav.spec.ts",
]

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  // Per-worker isolation (#175): the `harness` fixture (e2e/fixtures.ts) spawns
  // one mock + one BFF per worker on worker-derived ports, with per-worker
  // scratch dirs and die file, so workers can run in parallel without sharing
  // process-global mock controls or foreign-session UI. Both projects together
  // never exceed E2E_MAX_WORKERS (paths.ts), which `cleanup-ports.mjs` mirrors.
  workers: 4,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  outputDir: "test-results",
  globalSetup: "./global-setup.ts",
  use: {
    // `baseURL` deliberately lives in the fixture, not here: the config is
    // shared by every worker and must point at the worker's own BFF port.
    trace: "on-first-retry",
  },
  projects: [
    { name: "smoke", testMatch: SMOKE_SPECS, use: { ...devices["Desktop Chrome"] } },
    { name: "full", testIgnore: SMOKE_SPECS, use: { ...devices["Desktop Chrome"] } },
  ],
})
