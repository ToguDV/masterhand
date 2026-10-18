/**
 * E2E harness constants. Playwright evaluates this module in the runner and in
 * every worker process, so everything here is a pure function of the worker
 * index — never of the clock or the pid: the process that derives a worker's
 * ports and scratch dirs is the very one that spawns its servers and runs its
 * specs against them (the worker-scoped `harness` fixture in `./fixtures`).
 *
 * Worker 0 uses the historical 4097/8788 pair; worker N gets the N-th port of
 * each reserved block. The reserved space deliberately avoids the dev stack
 * (opencode 4096, BFF 8787, Vite 5173) and stays clear of the production
 * preview pool (3200-3299).
 */

/** Worker 0's mock opencode port. */
export const E2E_MOCK_BASE_PORT = 4097
/** Worker 0's BFF port. */
export const E2E_BFF_BASE_PORT = 8788
/**
 * Workers the reserved port/scratch space supports. `cleanup-ports.mjs` mirrors
 * this number (statically guarded) and frees the whole block, so a killed run
 * with any worker count up to this is reclaimed.
 */
export const E2E_MAX_WORKERS = 8
/** Scratch root wiped per run; each worker owns `<root>/w<index>`. */
export const E2E_SCRATCH_ROOT = "/tmp/masterhand-e2e"

/** Parallel index of the current worker process (0 in the runner / `--list`). */
export function e2eWorkerIndex(): number {
  const parsed = Number.parseInt(process.env.TEST_PARALLEL_INDEX ?? "", 10)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0
}

function checkedWorkerIndex(workerIndex: number): number {
  if (!Number.isInteger(workerIndex) || workerIndex < 0 || workerIndex >= E2E_MAX_WORKERS) {
    throw new Error(`E2E worker index ${workerIndex} outside 0..${E2E_MAX_WORKERS - 1} (E2E_MAX_WORKERS)`)
  }
  return workerIndex
}

export function e2eMockPort(workerIndex: number = e2eWorkerIndex()): number {
  return E2E_MOCK_BASE_PORT + checkedWorkerIndex(workerIndex)
}

export function e2eBffPort(workerIndex: number = e2eWorkerIndex()): number {
  return E2E_BFF_BASE_PORT + checkedWorkerIndex(workerIndex)
}

/**
 * The worker's session-preview port pool (a single port): the mock's own port
 * doubles as the session's dev server, so the BFF's reachability probe only
 * needs a listener and no second reserved port is required.
 */
export function e2ePreviewPort(workerIndex: number = e2eWorkerIndex()): number {
  return e2eMockPort(workerIndex)
}

/** Base URL of the worker's mock opencode control server. */
export function e2eMockURL(workerIndex: number = e2eWorkerIndex()): string {
  return `http://127.0.0.1:${e2eMockPort(workerIndex)}`
}

/** Scratch dir owned by one worker (wiped before its servers spawn). */
export function e2eScratchDir(workerIndex: number = e2eWorkerIndex()): string {
  return `${E2E_SCRATCH_ROOT}/w${checkedWorkerIndex(workerIndex)}`
}

/** Per-worker SQLite/data dir (never shared with another worker or run). */
export function e2eDataDir(workerIndex: number = e2eWorkerIndex()): string {
  return `${e2eScratchDir(workerIndex)}/data`
}

/** Per-worker workspaces root. */
export function e2eWorkspacesRoot(workerIndex: number = e2eWorkerIndex()): string {
  return `${e2eScratchDir(workerIndex)}/workspace`
}

/** Per-worker custom-providers file (inside the wiped data dir). */
export function e2eProvidersFile(workerIndex: number = e2eWorkerIndex()): string {
  return `${e2eDataDir(workerIndex)}/masterhand-providers.json`
}

/** Per-worker cloudflared die file (see `fake-cloudflared.sh`). */
export function e2eDieFile(workerIndex: number = e2eWorkerIndex()): string {
  return `${e2eScratchDir(workerIndex)}/cloudflared-die`
}
