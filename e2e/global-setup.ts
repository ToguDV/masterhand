import { execSync } from "node:child_process"
import { rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { E2E_SCRATCH_ROOT } from "./paths"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

/**
 * Once-per-run setup: build the web app the workers' BFFs serve, and wipe the
 * whole scratch root so a killed run's leftover worker dirs never leak into the
 * next run. The *per-worker* servers, dirs and die file are provisioned by the
 * `harness` fixture (e2e/fixtures.ts); this teardown removes the root.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  // `VITE_*` values are baked into the bundle at build time; the shortened
  // deadlines keep the stalled-send and lost-finish specs fast.
  execSync("npm run build -w @masterhand/web", {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, VITE_REQUEST_TIMEOUT_MS: "5000", VITE_FINISH_TIMEOUT_MS: "5000" },
  })
  await rm(E2E_SCRATCH_ROOT, { recursive: true, force: true })
  return async () => {
    await rm(E2E_SCRATCH_ROOT, { recursive: true, force: true })
  }
}
