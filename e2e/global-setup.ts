import { mkdir, rm } from "node:fs/promises"
import { E2E_CLOUDFLARED_DIE_FILE, E2E_DATA_DIR, E2E_WORKSPACES_ROOT } from "./paths"

/**
 * Starts every run from empty scratch state — a killed run's SQLite, preview
 * ports, tunnel records and workspaces never leak into the next one — and
 * returns the teardown, which leaves no trace behind.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  await rm(E2E_DATA_DIR, { recursive: true, force: true })
  await rm(E2E_WORKSPACES_ROOT, { recursive: true, force: true })
  await rm(E2E_CLOUDFLARED_DIE_FILE, { force: true })
  await mkdir(E2E_DATA_DIR, { recursive: true })
  await mkdir(E2E_WORKSPACES_ROOT, { recursive: true })
  return async () => {
    await rm(E2E_DATA_DIR, { recursive: true, force: true })
    await rm(E2E_WORKSPACES_ROOT, { recursive: true, force: true })
    await rm(E2E_CLOUDFLARED_DIE_FILE, { force: true })
  }
}
