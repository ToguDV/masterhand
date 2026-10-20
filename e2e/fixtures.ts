import { spawn, type ChildProcess } from "node:child_process"
import { createWriteStream } from "node:fs"
import { mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { test as base } from "@playwright/test"
import {
  e2eBffPort,
  e2eDataDir,
  e2eDieFile,
  e2eMockPort,
  e2eProvidersFile,
  e2eScratchDir,
  e2eWorkerIndex,
  e2eWorkspacesRoot,
} from "./paths"

/**
 * Per-worker harness (issue #175): every Playwright worker gets its own mock
 * opencode and its own BFF on ports derived from the worker index, its own
 * scratch dirs and its own cloudflared die file. `baseURL` points at the
 * worker's BFF, so `page.goto("/")` and relative `page.request` calls can never
 * reach another worker's state, and the process-global `/e2e/*` mock controls
 * are global only within one worker.
 *
 * The servers are spawned by this worker-scoped fixture instead of Playwright's
 * `webServer` (which starts exactly one instance per run), waited for by
 * health-polling (a killed run's orphans are reaped by `cleanup-ports.mjs`
 * before Playwright boots), and torn down with the worker.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(e2eDir, "..")
/**
 * Server logs live next to the Playwright output: `test-results/` is recreated
 * per run (so stale logs never survive) and uploaded by CI on failure, while
 * the scratch dir is wiped on teardown.
 */
const logsDir = path.join(e2eDir, "test-results")

export interface WorkerHarness {
  /** `testInfo.parallelIndex` this worker runs under. */
  workerIndex: number
  /** Mock opencode base URL (its `/e2e/*` controls included). */
  mockURL: string
  /** This worker's BFF base URL (the page `baseURL`). */
  bffURL: string
  /** The worker's session-preview port pool (single port, see `paths.ts`). */
  previewPort: number
}

const READY_TIMEOUT_MS = 120_000
const KILL_GRACE_MS = 5_000

function logPath(name: string, workerIndex: number): string {
  return path.join(logsDir, `w${workerIndex}-${name}.log`)
}

function startServer(name: string, script: string, cwd: string, env: NodeJS.ProcessEnv, workerIndex: number): ChildProcess {
  const out = createWriteStream(logPath(name, workerIndex), { flags: "w" })
  // `node --import tsx` keeps the server in the spawned process itself (no npm
  // exec wrapper in between), so SIGTERM reaches the BFF's signal handlers and
  // a killed worker cannot leave a grandchild listening on the port.
  const child = spawn(process.execPath, ["--import", "tsx", script], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  })
  child.stdout?.pipe(out)
  child.stderr?.pipe(out)
  return child
}

async function waitForHealth(url: string, child: ChildProcess, name: string, workerIndex: number): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${name} exited before becoming healthy; see ${logPath(name, workerIndex)}`)
    }
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // Still booting (connection refused), keep polling.
    }
    if (Date.now() > deadline) {
      throw new Error(`${name} not healthy at ${url} within ${READY_TIMEOUT_MS}ms; see ${logPath(name, workerIndex)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolve) => {
    // Register (and re-check) synchronously: an exit that lands between the
    // caller's check and this point must not leave the promise pending.
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    child.once("exit", () => resolve())
  })
  child.kill("SIGTERM")
  const timer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS)
  await exited
  clearTimeout(timer)
}

export const test = base.extend<{}, { harness: WorkerHarness }>({
  harness: [
    async ({}, use, workerInfo) => {
      const workerIndex = workerInfo.parallelIndex
      // Specs derive their module-scope mock URLs from TEST_PARALLEL_INDEX (set
      // by Playwright per worker). If that ever diverged from this worker's
      // index, specs would silently talk to another worker's servers: fail
      // loudly instead.
      if (e2eWorkerIndex() !== workerIndex) {
        throw new Error(
          `testInfo.parallelIndex=${workerIndex} but TEST_PARALLEL_INDEX=${process.env.TEST_PARALLEL_INDEX ?? "(unset)"}`,
        )
      }
      const scratchDir = e2eScratchDir(workerIndex)
      const mockPort = e2eMockPort(workerIndex)
      const bffPort = e2eBffPort(workerIndex)

      // A previous killed run must never leak SQLite, workspaces or tunnels into
      // this worker's run.
      await rm(scratchDir, { recursive: true, force: true })
      await mkdir(e2eDataDir(workerIndex), { recursive: true })
      await mkdir(e2eWorkspacesRoot(workerIndex), { recursive: true })
      await mkdir(logsDir, { recursive: true })

      const mock = startServer(
        "mock",
        path.join(e2eDir, "mock-opencode.ts"),
        e2eDir,
        { MOCK_PORT: String(mockPort) },
        workerIndex,
      )
      await waitForHealth(`http://127.0.0.1:${mockPort}/global/health`, mock, "mock opencode", workerIndex)

      const bff = startServer(
        "bff",
        path.join(repoRoot, "apps", "server", "src", "index.ts"),
        repoRoot,
        {
          PORT: String(bffPort),
          OPENCODE_URL: `http://127.0.0.1:${mockPort}`,
          MASTERHAND_PASSWORD: "e2e-password",
          SESSION_SECRET: "e2e-secret",
          COOKIE_SECURE: "false",
          // The mock provider is on 127.0.0.1; the guard is opt-in for local
          // providers (PROVIDERS_ALLOW_LOOPBACK).
          PROVIDERS_ALLOW_LOOPBACK: "true",
          DATA_DIR: e2eDataDir(workerIndex),
          OPENCODE_CUSTOM_PROVIDERS_FILE: e2eProvidersFile(workerIndex),
          WORKSPACES_ROOT: e2eWorkspacesRoot(workerIndex),
          PREVIEW_ORIGIN: "127.0.0.1",
          PREVIEW_PORT_RANGE: `${mockPort}-${mockPort}`,
          // The fake trycloudflare URL is not a real host, so the BFF must not
          // wait for it to become reachable.
          PREVIEW_READINESS_MS: "0",
          CLOUDFLARED_BIN: path.join(e2eDir, "fake-cloudflared.sh"),
          // Creating this file makes the fake tunnel exit on its own (#89).
          E2E_CLOUDFLARED_DIE_FILE: e2eDieFile(workerIndex),
        },
        workerIndex,
      )
      await waitForHealth(`http://127.0.0.1:${bffPort}/api/health`, bff, "BFF", workerIndex)

      await use({
        workerIndex,
        mockURL: `http://127.0.0.1:${mockPort}`,
        bffURL: `http://127.0.0.1:${bffPort}`,
        previewPort: mockPort,
      })

      await stopServer(bff)
      await stopServer(mock)
      await rm(scratchDir, { recursive: true, force: true })
    },
    { scope: "worker", auto: true },
  ],

  // Every spec navigates with `page.goto("/")` / relative `page.request` calls:
  // resolve them against this worker's BFF (the config-level `use.baseURL` is
  // global, so it cannot point at a per-worker port).
  baseURL: async ({ harness }, use) => {
    await use(harness.bffURL)
  },
})

export { expect } from "@playwright/test"
