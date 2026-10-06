import { spawn, type ChildProcess } from "node:child_process"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { connect } from "node:net"
import { join } from "node:path"
import type { Config } from "./config.js"
import { isStorageConflict, type Store } from "./store.js"

export type PreviewStatus = "stopped" | "starting" | "running" | "error"

export interface PreviewState {
  status: PreviewStatus
  url: string | null
  port: number | null
  error: string | null
}

export interface PreviewManager {
  status(sessionID: string): PreviewState
  portFor(sessionID: string): number
  start(sessionID: string): Promise<PreviewState>
  stop(sessionID: string): void
  stopAll(): void
  /** Port mappings are removed when the session disappears. */
  forget(sessionID: string): void
  /** Whether the `cloudflared` binary can be executed (cached, async probe). */
  available(): Promise<boolean>
}

export class PreviewError extends Error {
  constructor(
    public readonly code: string,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code)
    this.name = "PreviewError"
  }
}

export interface PreviewManagerDeps {
  config: Config
  store: Store
  /** Overridable for tests; defaults to `child_process.spawn`. */
  spawnImpl?: typeof spawn
  /** Overridable for tests: TCP reachability probe for the dev server. */
  probe?: (host: string, port: number, timeoutMs: number) => Promise<boolean>
  /** Overridable for tests: does the cloudflared binary exist? */
  availableImpl?: () => boolean | Promise<boolean>
  /** Overridable for tests: is the public URL reachable yet? */
  readinessImpl?: (url: string) => Promise<boolean>
  /** How long to wait for cloudflared to announce its public URL. */
  urlTimeoutMs?: number
  /** How long to wait for the tunnel's hostname to become reachable. */
  readinessTimeoutMs?: number
  readinessIntervalMs?: number
}

const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/
const PROBE_TIMEOUT_MS = 1500
const URL_TIMEOUT_MS = 30_000
const READINESS_INTERVAL_MS = 1_500
const READINESS_REQUEST_TIMEOUT_MS = 5_000
const KILL_GRACE_MS = 3000
/** Port-allocation retries on a UNIQUE(port) race before giving up. */
const MAX_PORT_ATTEMPTS = 5

interface RunningPreview {
  child: ChildProcess
  url: string
  port: number
}

function probeTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    const done = (reachable: boolean): void => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(reachable)
    }
    socket.setTimeout(timeoutMs)
    socket.once("connect", () => done(true))
    socket.once("timeout", () => done(false))
    socket.once("error", () => done(false))
  })
}

/**
 * Quick tunnels announce their URL before the DNS record and the edge
 * connection are ready, so a fresh URL can answer NXDOMAIN or a Cloudflare
 * 530/1033 for a few seconds. Anything below 500 means the tunnel is up and
 * the origin answered (its status is the app's business).
 */
export async function reachableOverHttp(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(READINESS_REQUEST_TIMEOUT_MS) })
    return response.status < 500
  } catch {
    return false
  }
}

/**
 * The instruction appended to every prompt of a session: a stable port is
 * reserved so the user can open a live preview of whatever the agent serves.
 */
export function previewSystemPrompt(port: number): string {
  return [
    `A live-preview port is reserved for this project: ${port}.`,
    `MasterHand's Run control starts the web server (declare it in .masterhand/run.json using "--port {port}"); do not start or stop it yourself.`,
    `A web server for this project must listen on host 0.0.0.0 and port ${port} (MasterHand passes PORT=${port}).`,
    `Never use a different port for a web server: the preview tunnel only forwards port ${port}.`,
    `If a process already listens on ${port}, reuse it instead of starting another one.`,
    `The user opens the preview through a public tunnel (a random *.trycloudflare.com host), so if the dev server`,
    `enforces a host/origin allowlist, configure it to accept tunnel hosts`,
    `(for example Vite: \`server.allowedHosts: ['.trycloudflare.com']\` or \`__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=.trycloudflare.com\`;`,
    `Next.js: add the tunnel pattern to \`allowedDevOrigins\`).`,
  ].join(" ")
}

/** File where tunnel PIDs are persisted for crash recovery. */
export function tunnelPidFile(dataDir: string): string {
  return join(dataDir, "preview-tunnels.json")
}

function readTrackedPids(file: string): number[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
    return Array.isArray(parsed) ? parsed.filter((pid): pid is number => Number.isInteger(pid) && pid > 1) : []
  } catch {
    return []
  }
}

function writeTrackedPids(file: string, pids: number[]): void {
  try {
    writeFileSync(file, JSON.stringify(pids), "utf8")
  } catch {
    // best effort: a read-only data dir must not break previews
  }
}

/** Reads a live process's executable name; null when it cannot be confirmed. */
function defaultProcessName(pid: number): string | null {
  if (process.platform !== "linux") return null
  try {
    return readFileSync(`/proc/${pid}/comm`, "utf8").trim() || null
  } catch {
    return null
  }
}

export interface OrphanCleanupOptions {
  pidFile: string
  /** Overridable for tests: executable name of a live PID (null if unknown). */
  processName?: (pid: number) => string | null
  /** Overridable for tests; defaults to SIGTERM via `process.kill`. */
  kill?: (pid: number) => void
}

/**
 * Best-effort cleanup of `cloudflared` processes orphaned by a crashed BFF
 * (SIGKILL, host power loss): kills only PIDs still confirmed to be a
 * cloudflared process, so PID reuse cannot take down an unrelated process.
 * Non-Linux hosts cannot verify the executable and skip — systemd's cgroup
 * reaping and Docker's container teardown already cover the common cases.
 */
export function cleanupOrphanTunnels(options: OrphanCleanupOptions): number[] {
  const readName = options.processName ?? defaultProcessName
  const kill = options.kill ?? ((pid: number) => process.kill(pid, "SIGTERM"))
  const killed: number[] = []
  for (const pid of readTrackedPids(options.pidFile)) {
    let name: string | null = null
    try {
      name = readName(pid)
    } catch {
      name = null
    }
    if (!name || !name.toLowerCase().includes("cloudflared")) continue
    try {
      kill(pid)
      killed.push(pid)
    } catch {
      // already gone
    }
  }
  try {
    rmSync(options.pidFile, { force: true })
  } catch {
    // best effort
  }
  return killed
}

export function createPreviewManager(deps: PreviewManagerDeps): PreviewManager {
  const { config, store } = deps
  const spawnImpl = deps.spawnImpl ?? spawn
  const probe = deps.probe ?? probeTcp
  const readiness = deps.readinessImpl ?? reachableOverHttp
  const urlTimeoutMs = deps.urlTimeoutMs ?? URL_TIMEOUT_MS
  const readinessTimeoutMs = deps.readinessTimeoutMs ?? config.previewReadinessMs
  const readinessIntervalMs = deps.readinessIntervalMs ?? READINESS_INTERVAL_MS
  const running = new Map<string, RunningPreview>()
  const starting = new Map<string, Promise<PreviewState>>()
  const failures = new Map<string, string>()
  let availableCache: boolean | null = null
  let availableInFlight: Promise<boolean> | null = null
  const pidFile = tunnelPidFile(config.dataDir)

  // Persist live tunnel PIDs so the next process can reap them after a crash
  // (see `cleanupOrphanTunnels`). Tests with fake children (no pid) skip it.
  function track(child: ChildProcess): void {
    const pid = child.pid
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) return
    const pids = readTrackedPids(pidFile)
    if (!pids.includes(pid)) writeTrackedPids(pidFile, [...pids, pid])
  }

  function untrack(child: ChildProcess): void {
    const pid = child.pid
    if (typeof pid !== "number") return
    const pids = readTrackedPids(pidFile)
    if (pids.includes(pid)) writeTrackedPids(pidFile, pids.filter((value) => value !== pid))
  }

  /** Async `spawn` probe with a kill timeout; never blocks the event loop. */
  function probeBinary(command: string, binaryTimeoutMs = 3000): Promise<boolean> {
    return new Promise((resolve) => {
      let child: ChildProcess
      try {
        child = spawn(command, ["--version"], { stdio: "ignore" })
      } catch {
        resolve(false)
        return
      }
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL")
        } catch {
          // already gone
        }
      }, binaryTimeoutMs)
      const finish = (value: boolean): void => {
        clearTimeout(timer)
        resolve(value)
      }
      child.once("error", () => finish(false))
      child.once("close", (code) => finish(code === 0))
    })
  }

  function available(): Promise<boolean> {
    if (availableCache !== null) return Promise.resolve(availableCache)
    // Concurrent /api/status polls share one probe instead of spawning per call.
    if (availableInFlight) return availableInFlight
    const check = (async (): Promise<boolean> => {
      try {
        if (deps.availableImpl) return Boolean(await deps.availableImpl())
        return await probeBinary(config.cloudflaredBin)
      } catch {
        return false
      }
    })()
    availableInFlight = check.then(
      (value) => {
        availableCache = value
        availableInFlight = null
        return value
      },
      () => {
        availableCache = false
        availableInFlight = null
        return false
      },
    )
    return availableInFlight
  }

  function allocatePort(): number {
    const { min, max } = config.previewPortRange
    const used = new Set(store.listPreviewPorts().map((record) => record.port))
    for (let port = min; port <= max; port += 1) {
      if (!used.has(port)) return port
    }
    // The pool is drained: drop the oldest mapping without a live tunnel. Ports
    // are persisted for stability, so restarts leave stale rows behind.
    const stale = store.listPreviewPorts().find((record) => !running.has(record.sessionID))
    if (stale) {
      store.removePreviewPort(stale.sessionID)
      failures.delete(stale.sessionID)
      return stale.port
    }
    throw new PreviewError("preview_ports_exhausted")
  }

  function portFor(sessionID: string): number {
    const existing = store.getPreviewPort(sessionID)
    if (existing !== null) return existing
    // Listing the pool and inserting are not atomic: a concurrent session can
    // take the port in between, violating UNIQUE(port). Retry with a fresh
    // choice instead of failing session creation/run start (issue #87b).
    for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt += 1) {
      const port = allocatePort()
      try {
        store.assignPreviewPort({ sessionID, port, createdAt: Date.now() })
        return port
      } catch (error) {
        if (!isStorageConflict(error)) throw error
      }
    }
    throw new PreviewError("preview_ports_exhausted")
  }

  function state(sessionID: string): PreviewState {
    const active = running.get(sessionID)
    if (active) return { status: "running", url: active.url, port: active.port, error: null }
    if (starting.has(sessionID)) return { status: "starting", url: null, port: portFor(sessionID), error: null }
    const failure = failures.get(sessionID)
    if (failure) return { status: "error", url: null, port: portFor(sessionID), error: failure }
    const port = store.getPreviewPort(sessionID)
    return { status: "stopped", url: null, port, error: null }
  }

  function kill(child: ChildProcess): void {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill("SIGTERM")
    const timer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS)
    timer.unref()
    child.once("exit", () => clearTimeout(timer))
  }

  function waitForUrl(child: ChildProcess): Promise<string> {
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (error: Error | null, url?: string): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.stdout?.removeListener("data", onData)
        child.stderr?.removeListener("data", onData)
        child.removeListener("exit", onExit)
        if (error) reject(error)
        else resolve(url!)
      }
      const onData = (chunk: Buffer): void => {
        const match = URL_PATTERN.exec(chunk.toString())
        if (match) finish(null, match[0])
      }
      const onExit = (code: number | null): void => {
        finish(new PreviewError("preview_tunnel_exited", `cloudflared exited (${code ?? "signal"})`))
      }
      const timer = setTimeout(
        () => finish(new PreviewError("preview_tunnel_timeout", "no trycloudflare URL")),
        urlTimeoutMs,
      )
      child.stdout?.on("data", onData)
      child.stderr?.on("data", onData)
      child.once("exit", onExit)
    })
  }

  async function waitUntilReachable(url: string, failure: () => string | null): Promise<void> {
    if (readinessTimeoutMs <= 0) return
    const deadline = Date.now() + readinessTimeoutMs
    while (Date.now() < deadline) {
      const exited = failure()
      if (exited) throw new PreviewError("preview_tunnel_exited", exited)
      if (await readiness(url)) return
      await new Promise((resolve) => setTimeout(resolve, readinessIntervalMs))
    }
    throw new PreviewError("preview_tunnel_unreachable", url)
  }

  async function launch(sessionID: string): Promise<PreviewState> {
    const port = portFor(sessionID)
    const reachable = await probe(config.previewOrigin, port, PROBE_TIMEOUT_MS)
    if (!reachable) {
      console.warn(`[preview] ${sessionID}: no server listening on ${config.previewOrigin}:${port}`)
      throw new PreviewError(
        "preview_not_running",
        `no server on ${config.previewOrigin}:${port}; ask the agent to start it first`,
      )
    }

    let child: ChildProcess
    try {
      child = spawnImpl(
        config.cloudflaredBin,
        [
          "tunnel",
          "--no-autoupdate",
          "--url",
          `http://${config.previewOrigin}:${port}`,
          // Rewrite the Host header: dev servers reject the tunnel hostname
          // (Vite's `server.allowedHosts` answers 403 otherwise), and localhost
          // is always an allowed origin.
          "--http-host-header",
          `localhost:${port}`,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      )
    } catch (error) {
      throw new PreviewError("preview_spawn_failed", error instanceof Error ? error.message : "spawn failed")
    }

    let failure: string | null = null
    child.once("error", (error) => {
      failure = error.message
    })
    track(child)
    // Keep cloudflared diagnostics flowing to the BFF logs for the whole
    // lifetime: post-URL connection failures are otherwise invisible.
    const logCloudflared = (chunk: Buffer): void => {
      for (const line of chunk.toString().split("\n")) {
        if (line.includes("ERR") || line.includes("WRN")) console.warn(`[preview] ${sessionID}: ${line.trim()}`)
      }
    }
    child.stdout?.on("data", logCloudflared)
    child.stderr?.on("data", logCloudflared)
    // Persist the reason once the tunnel was live: status flips to `error`.
    child.once("exit", (code, signal) => {
      untrack(child)
      failure = failure ?? `cloudflared exited (${signal ?? code ?? "unknown"})`
      if (running.get(sessionID)?.child === child) {
        running.delete(sessionID)
        failures.set(sessionID, failure)
      }
    })

    let url: string
    try {
      url = await waitForUrl(child)
      await waitUntilReachable(url, () => failure)
    } catch (error) {
      console.warn(`[preview] ${sessionID}: ${error instanceof Error ? error.message : String(error)}`)
      kill(child)
      throw error
    }

    running.set(sessionID, { child, url, port })
    failures.delete(sessionID)
    return { status: "running", url, port, error: null }
  }

  return {
    status(sessionID) {
      return state(sessionID)
    },
    portFor,
    start(sessionID) {
      const active = running.get(sessionID)
      if (active) return Promise.resolve({ status: "running" as const, url: active.url, port: active.port, error: null })
      const pending = starting.get(sessionID)
      if (pending) return pending
      failures.delete(sessionID)
      const task = launch(sessionID).finally(() => starting.delete(sessionID))
      starting.set(sessionID, task)
      return task
    },
    stop(sessionID) {
      const active = running.get(sessionID)
      if (active) {
        kill(active.child)
        untrack(active.child)
        running.delete(sessionID)
      }
      failures.delete(sessionID)
    },
    stopAll() {
      for (const active of running.values()) {
        kill(active.child)
        untrack(active.child)
      }
      running.clear()
      starting.clear()
      failures.clear()
    },
    forget(sessionID) {
      const active = running.get(sessionID)
      if (active) {
        kill(active.child)
        untrack(active.child)
        running.delete(sessionID)
      }
      failures.delete(sessionID)
      store.removePreviewPort(sessionID)
    },
    available,
  }
}
