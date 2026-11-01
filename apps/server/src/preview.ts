import { spawn, type ChildProcess } from "node:child_process"
import { chmod, readFile, rm, writeFile } from "node:fs/promises"
import { connect } from "node:net"
import { join } from "node:path"
import type { Config } from "./config.js"
import { isUniqueConstraint, type Store } from "./store.js"

export type PreviewStatus = "stopped" | "starting" | "running" | "error"

export interface PreviewState {
  status: PreviewStatus
  /** Public URL while the tunnel is running; null in every other state. */
  url: string | null
  /** Last URL the tunnel announced, retained after stop or failure for diagnosis. */
  lastUrl: string | null
  port: number | null
  error: string | null
}

export interface PreviewManager {
  status(sessionID: string): PreviewState
  portFor(sessionID: string): number
  start(sessionID: string): Promise<PreviewState>
  stop(sessionID: string): Promise<void>
  stopAll(): Promise<void>
  /** Port mappings are removed when the session disappears. */
  /**
   * Kills the tunnel (waiting for an in-flight start first, so a child that
   * appears after the call is still killed) and drops the reserved port.
   */
  forget(sessionID: string): Promise<void>
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
/** Tunnel PIDs are operational state; keep them owner-only like the data dir. */
const PID_FILE_MODE = 0o600

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

/** Asynchronous file I/O behind the tunnel PID file (injectable for tests). */
export interface PidFileIo {
  readFile(file: string): Promise<string>
  writeFile(file: string, data: string, mode: number): Promise<void>
  chmod(file: string, mode: number): Promise<void>
  rm(file: string): Promise<void>
}

const defaultPidFileIo: PidFileIo = {
  readFile: (file) => readFile(file, "utf8"),
  writeFile: async (file, data, mode) => {
    await writeFile(file, data, { encoding: "utf8", mode })
    // `mode` only applies when the file is created; tighten a legacy file too.
    await chmod(file, mode)
  },
  chmod: (file, mode) => chmod(file, mode),
  rm: (file) => rm(file, { force: true }),
}

export interface PidFileStore {
  list(): Promise<number[]>
  add(pid: number): Promise<void>
  remove(pid: number): Promise<void>
  clear(): Promise<void>
}

/**
 * Tunnel PIDs persisted for crash recovery (issue #200). Every
 * read-modify-write runs through one promise chain, so a track racing an
 * untrack cannot interleave into a lost update — and no synchronous
 * filesystem call ever freezes the event loop on a preview start/stop.
 * Operations throw; the manager treats them as best effort (a read-only
 * data dir must not break previews).
 */
export function createPidFileStore(file: string, io: PidFileIo = defaultPidFileIo): PidFileStore {
  let chain: Promise<unknown> = Promise.resolve()

  function run<T>(op: () => Promise<T>): Promise<T> {
    const next = chain.then(op, op)
    // A rejected op must not break the chain for the operations behind it.
    chain = next.then(
      () => {},
      () => {},
    )
    return next
  }

  function validPids(value: unknown): number[] {
    return Array.isArray(value) ? value.filter((pid): pid is number => Number.isInteger(pid) && pid > 1) : []
  }

  async function current(): Promise<number[]> {
    try {
      return validPids(JSON.parse(await io.readFile(file)))
    } catch {
      return []
    }
  }

  return {
    list: () => run(() => current()),
    add: (pid) =>
      run(async () => {
        const pids = await current()
        if (!pids.includes(pid)) await io.writeFile(file, JSON.stringify([...pids, pid]), PID_FILE_MODE)
      }),
    remove: (pid) =>
      run(async () => {
        const pids = await current()
        if (pids.includes(pid)) {
          await io.writeFile(file, JSON.stringify(pids.filter((value) => value !== pid)), PID_FILE_MODE)
        }
      }),
    clear: () => run(() => io.rm(file)),
  }
}

/** Reads a live process's executable name; null when it cannot be confirmed. */
async function defaultProcessName(pid: number): Promise<string | null> {
  if (process.platform !== "linux") return null
  try {
    return (await readFile(`/proc/${pid}/comm`, "utf8")).trim() || null
  } catch {
    return null
  }
}

export interface OrphanCleanupOptions {
  pidFile: string
  /** Overridable for tests: executable name of a live PID (null if unknown). */
  processName?: (pid: number) => string | null | Promise<string | null>
  /** Overridable for tests; defaults to SIGTERM via `process.kill`. */
  kill?: (pid: number) => void
  /** Overridable for tests: PID-file I/O (defaults to `fs/promises`). */
  io?: PidFileIo
}

/**
 * Best-effort cleanup of `cloudflared` processes orphaned by a crashed BFF
 * (SIGKILL, host power loss): kills only PIDs still confirmed to be a
 * cloudflared process, so PID reuse cannot take down an unrelated process.
 * Non-Linux hosts cannot verify the executable and skip — systemd's cgroup
 * reaping and Docker's container teardown already cover the common cases.
 */
export async function cleanupOrphanTunnels(options: OrphanCleanupOptions): Promise<number[]> {
  const store = createPidFileStore(options.pidFile, options.io)
  const readName = options.processName ?? defaultProcessName
  const kill = options.kill ?? ((pid: number) => process.kill(pid, "SIGTERM"))
  const killed: number[] = []
  for (const pid of await store.list()) {
    let name: string | null = null
    try {
      name = await readName(pid)
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
    await store.clear()
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
  /** Children spawned by an in-flight start, killable before readiness finishes. */
  const startingChildren = new Map<string, ChildProcess>()
  /** Bumped on every start and stop; stale launches abort instead of publishing. */
  const epochs = new Map<string, number>()
  /**
   * Monotonic epoch source. Entries are dropped when a session is forgotten or
   * every tunnel is stopped, and a launch unwinding at that moment must not
   * match a fresh start that reuses the map slot: never reuse an epoch value.
   */
  let nextEpoch = 0
  /** Children whose kill was already requested; stop and a stale abort share it. */
  const killed = new WeakSet<ChildProcess>()
  const failures = new Map<string, string>()
  /** Last URL announced by a tunnel; kept after stops and failures for support. */
  const lastUrls = new Map<string, string>()
  let availableCache: boolean | null = null
  let availableInFlight: Promise<boolean> | null = null
  const pidFile = tunnelPidFile(config.dataDir)
  const pidStore = createPidFileStore(pidFile)

  // Persist live tunnel PIDs so the next process can reap them after a crash
  // (see `cleanupOrphanTunnels`). Tests with fake children (no pid) skip it.
  // Best effort: a read-only data dir must not break previews.
  function track(child: ChildProcess): Promise<void> {
    const pid = child.pid
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) return Promise.resolve()
    return pidStore.add(pid).catch(() => {})
  }

  function untrack(child: ChildProcess): Promise<void> {
    const pid = child.pid
    if (typeof pid !== "number") return Promise.resolve()
    return pidStore.remove(pid).catch(() => {})
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

  function epochFor(sessionID: string): number | undefined {
    return epochs.get(sessionID)
  }

  function bumpEpoch(sessionID: string): number {
    nextEpoch += 1
    epochs.set(sessionID, nextEpoch)
    return nextEpoch
  }

  function allocatePort(): number {
    const { min, max } = config.previewPortRange
    const used = new Set(store.listPreviewPorts().map((record) => record.port))
    for (let port = min; port <= max; port += 1) {
      if (!used.has(port)) return port
    }
    // The pool is drained: drop the oldest mapping without a live tunnel. Ports
    // are persisted for stability, so restarts leave stale rows behind. A
    // session still starting already told the agent which port to bind and may
    // publish its URL later, so its reservation is not stale either.
    const live = (sessionID: string): boolean =>
      running.has(sessionID) || starting.has(sessionID) || startingChildren.has(sessionID)
    const stale = store.listPreviewPorts().find((record) => !live(record.sessionID))
    if (stale) {
      store.removePreviewPort(stale.sessionID)
      failures.delete(stale.sessionID)
      lastUrls.delete(stale.sessionID)
      return stale.port
    }
    throw new PreviewError("preview_ports_exhausted")
  }

  function portFor(sessionID: string): number {
    const existing = store.getPreviewPort(sessionID)
    if (existing !== null) return existing
    // Listing the pool and inserting are not atomic: a concurrent session can
    // take the port in between, violating UNIQUE(port). Retry with a fresh
    // choice instead of failing session creation/run start (issue #87b). The
    // store returns the persisted row, so a same-session replay keeps its
    // original port instead of the one this attempt picked.
    for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt += 1) {
      const port = allocatePort()
      try {
        return store.assignPreviewPort({ sessionID, port, createdAt: Date.now() }).port
      } catch (error) {
        // Only a UNIQUE collision means another session won the race; any
        // other constraint or storage failure is real and must surface.
        if (!isUniqueConstraint(error)) throw error
      }
    }
    throw new PreviewError("preview_ports_exhausted")
  }

  function state(sessionID: string): PreviewState {
    const lastUrl = lastUrls.get(sessionID) ?? null
    const active = running.get(sessionID)
    if (active) {
      return { status: "running", url: active.url, lastUrl: active.url, port: active.port, error: null }
    }
    if (starting.has(sessionID)) {
      return { status: "starting", url: null, lastUrl, port: portFor(sessionID), error: null }
    }
    const failure = failures.get(sessionID)
    if (failure) {
      return { status: "error", url: null, lastUrl, port: portFor(sessionID), error: failure }
    }
    const port = store.getPreviewPort(sessionID)
    return { status: "stopped", url: null, lastUrl, port, error: null }
  }

  function kill(child: ChildProcess): void {
    // stop(), a stale launch abort and a failure path can all target the same
    // child; the first kill owns the SIGTERM/SIGKILL timer.
    if (killed.has(child) || child.exitCode !== null || child.signalCode !== null) return
    killed.add(child)
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

  async function launch(sessionID: string, epoch: number): Promise<PreviewState> {
    const current = (): boolean => epochFor(sessionID) === epoch
    const stoppedError = (): PreviewError => new PreviewError("preview_stopped", "stop requested")
    let child: ChildProcess | null = null

    // A stop/forget bumps the epoch: a launch cancelled while parked in an
    // await (probe, PID write, URL, readiness) must never publish its tunnel.
    const abortIfStale = (): void => {
      if (current()) return
      if (child) kill(child)
      throw stoppedError()
    }

    try {
      const port = portFor(sessionID)
      const reachable = await probe(config.previewOrigin, port, PROBE_TIMEOUT_MS)
      abortIfStale()
      if (!reachable) {
        console.warn(`[preview] ${sessionID}: no server listening on ${config.previewOrigin}:${port}`)
        throw new PreviewError(
          "preview_not_running",
          `no server on ${config.previewOrigin}:${port}; ask the agent to start it first`,
        )
      }

      let proc: ChildProcess
      try {
        proc = spawnImpl(
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
      child = proc
      // Register the child before the first await so a stop crossing this start
      // kills it immediately instead of waiting out the URL+readiness budget.
      startingChildren.set(sessionID, proc)

      let failure: string | null = null
      proc.once("error", (error) => {
        failure = error.message
      })
      await track(proc)
      abortIfStale()
      // Keep cloudflared diagnostics flowing to the BFF logs for the whole
      // lifetime: post-URL connection failures are otherwise invisible.
      const logCloudflared = (chunk: Buffer): void => {
        for (const line of chunk.toString().split("\n")) {
          if (line.includes("ERR") || line.includes("WRN")) console.warn(`[preview] ${sessionID}: ${line.trim()}`)
        }
      }
      proc.stdout?.on("data", logCloudflared)
      proc.stderr?.on("data", logCloudflared)
      // Persist the reason once the tunnel was live: status flips to `error`.
      proc.once("exit", (code, signal) => {
        void untrack(proc)
        failure = failure ?? `cloudflared exited (${signal ?? code ?? "unknown"})`
        if (running.get(sessionID)?.child === proc) {
          running.delete(sessionID)
          failures.set(sessionID, failure)
          const lastUrl = lastUrls.get(sessionID)
          console.warn(`[preview] ${sessionID}: ${failure}${lastUrl ? ` (url ${lastUrl})` : ""}`)
        }
      })

      const bringUp = async (): Promise<string> => {
        let announced: string | null = null
        try {
          announced = await waitForUrl(proc)
          // A launch cancelled while waiting for the URL must abort before it
          // publishes: the slot may already belong to a newer start, and this
          // URL must never replace the one that start just retained.
          abortIfStale()
          // Retain the URL immediately: readiness can fail or the tunnel can die
          // right after announcing, and support still needs to see the last one.
          lastUrls.set(sessionID, announced)
          await waitUntilReachable(announced, () => failure)
          abortIfStale()
          return announced
        } catch (error) {
          if (!current()) {
            kill(proc)
            throw stoppedError()
          }
          const message = error instanceof Error ? error.message : String(error)
          console.warn(`[preview] ${sessionID}: ${message}${announced ? ` (url ${announced})` : ""}`)
          kill(proc)
          throw error
        }
      }
      const url = await bringUp()

      abortIfStale()
      running.set(sessionID, { child: proc, url, port })
      failures.delete(sessionID)
      console.info(`[preview] ${sessionID}: running at ${url} (port ${port})`)
      return { status: "running", url, lastUrl: url, port, error: null }
    } finally {
      // Only this launch's own child may be dropped: a newer start can already
      // own the slot while this one is still unwinding.
      if (child && startingChildren.get(sessionID) === child) startingChildren.delete(sessionID)
      // A cancelled/failed start never becomes `running`: drop its PID now
      // instead of waiting for an exit listener that may not exist yet.
      if (child && running.get(sessionID)?.child !== child) await untrack(child)
    }
  }

  return {
    status(sessionID) {
      return state(sessionID)
    },
    portFor,
    start(sessionID) {
      const active = running.get(sessionID)
      if (active) {
        return Promise.resolve({
          status: "running" as const,
          url: active.url,
          lastUrl: active.url,
          port: active.port,
          error: null,
        })
      }
      const pending = starting.get(sessionID)
      if (pending) return pending
      failures.delete(sessionID)
      const epoch = bumpEpoch(sessionID)
      const task = launch(sessionID, epoch).finally(() => {
        // Only the entry this start installed may be removed: a stop can clear
        // it and a new start can install a newer one while this unwinds.
        if (starting.get(sessionID) === task) starting.delete(sessionID)
      })
      starting.set(sessionID, task)
      return task
    },
    stop(sessionID) {
      bumpEpoch(sessionID)
      // Cancel a child that is still inside its URL/readiness budget. The
      // launch notices the stale epoch and rejects with `preview_stopped`.
      const pendingChild = startingChildren.get(sessionID)
      if (pendingChild) {
        kill(pendingChild)
        startingChildren.delete(sessionID)
      }
      // Do not reuse a cancelled start: the next start begins a fresh launch.
      starting.delete(sessionID)
      const active = running.get(sessionID)
      if (active) {
        kill(active.child)
        running.delete(sessionID)
      }
      failures.delete(sessionID)
      const lastUrl = lastUrls.get(sessionID)
      console.info(`[preview] ${sessionID}: stopped${lastUrl ? ` (last url ${lastUrl})` : ""}`)
      // State flips synchronously (as before); only the PID-file write waits.
      return active ? untrack(active.child) : Promise.resolve()
    },
    stopAll() {
      const sessions = new Set([...running.keys(), ...starting.keys(), ...startingChildren.keys()])
      for (const sessionID of sessions) bumpEpoch(sessionID)
      const children = new Set<ChildProcess>()
      for (const active of running.values()) children.add(active.child)
      for (const pending of startingChildren.values()) children.add(pending)
      for (const child of children) kill(child)
      running.clear()
      starting.clear()
      startingChildren.clear()
      failures.clear()
      lastUrls.clear()
      // Cancellation above is synchronous; the monotonic epoch source keeps a
      // launch still unwinding stale even though every map slot is gone.
      epochs.clear()
      return Promise.all([...children].map((child) => untrack(child))).then(() => {})
    },
    async forget(sessionID) {
      // An in-flight `start` is not tracked in `running` until its readiness
      // checks finish: cancel it so it unwinds promptly, then wait and kill the
      // child it produced. Otherwise the tunnel outlives the session with no
      // row left to find it by (#188).
      bumpEpoch(sessionID)
      const pending = starting.get(sessionID)
      const pendingChild = startingChildren.get(sessionID)
      if (pendingChild) {
        kill(pendingChild)
        startingChildren.delete(sessionID)
      }
      if (pending) await pending.catch(() => {})
      const active = running.get(sessionID)
      if (active) {
        kill(active.child)
        await untrack(active.child)
        running.delete(sessionID)
      }
      failures.delete(sessionID)
      lastUrls.delete(sessionID)
      // The in-flight start (if any) has settled above; a forgotten session
      // leaves no epoch behind.
      epochs.delete(sessionID)
      store.removePreviewPort(sessionID)
    },
    available,
  }
}
