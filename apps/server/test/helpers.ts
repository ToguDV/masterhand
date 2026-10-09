import { createServer } from "node:http"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import type { AddressInfo } from "node:net"
import type { ChildProcess } from "node:child_process"
import { serve } from "@hono/node-server"
import { createApp } from "../src/app.js"
import type { Config } from "../src/config.js"
import { createEventHub, type EventHub } from "../src/events.js"
import { createPreviewManager, type PreviewManager } from "../src/preview.js"
import { createMemoryStore, type DeviceRecord, type Store } from "../src/store.js"
import type { CustomProviderStore } from "../src/providers.js"
import type { WorktreeManager } from "../src/worktrees.js"

export async function waitFor(predicate: () => boolean, timeoutMs = 8000, intervalMs = 25): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error("waitFor: timed out waiting for the condition")
}

export interface MockOpencode {
  url: string
  requests: {
    method: string
    path: string
    query?: string
    authorization?: string
    headers: Record<string, string>
    body?: string
  }[]
  emit(event: unknown): void
  /** Makes the next `times` requests whose path contains `fragment` answer `status`. */
  failNext(fragment: string, times: number, status?: number): void
  /** Registers a session the adapter can resolve with `GET /api/session/:id`. */
  addSession(input: { id: string; directory?: string; model?: string | null }): void
  /** Appends an assistant reply to a session's history (no event emitted). */
  reply(sessionID: string, text: string): void
  /** First session id with an instruction entry under `key`, or null. */
  sessionWithInstruction(key: string): string | null
  /** Sessions reported as running by `GET /api/session/active`. */
  setActive(sessionIDs: string[]): void
  close(): Promise<void>
}

export async function startMockOpencode(): Promise<MockOpencode> {
  const requests: MockOpencode["requests"] = []
  const sseClients = new Set<import("node:http").ServerResponse>()
  const ptys: Array<{ id: string; title: string; status: string; pid: number; command: string; args: string[]; cwd: string }> = []
  const messagesBySession = new Map<
    string,
    Array<{ id: string; type: string; metadata?: Record<string, unknown>; text?: string; content?: Array<{ type: string; text: string }> }>
  >()
  const sessions = new Map<
    string,
    { id: string; parentID?: string; metadata?: Record<string, unknown>; location: { directory: string }; model: { id: string; providerID: string } | null }
  >()
  const instructions = new Map<string, Map<string, string>>()
  const active = new Set<string>()
  const failures: Array<{ fragment: string; remaining: number; status: number }> = []
  let sessionCounter = 0
  let ptyCounter = 0
  let messageCounter = 0

  const server = createServer((req, res) => {
    let body = ""
    req.on("data", (chunk) => {
      body += chunk
    })
    req.on("end", () => {
      const [path = "/", search] = (req.url ?? "").split("?")
      const headers: Record<string, string> = {}
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers[name] = value
      }
      requests.push({
        method: req.method ?? "",
        path,
        query: search,
        authorization: req.headers.authorization,
        headers,
        body: body || undefined,
      })

      const failure = failures.find((entry) => entry.remaining > 0 && path.includes(entry.fragment))
      if (failure) {
        failure.remaining -= 1
        res.writeHead(failure.status, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "scripted_failure" }))
        return
      }

      // Prompt + history (proxy retry reconciliation).
      if (req.method === "POST" && path.startsWith("/api/session/") && path.endsWith("/prompt")) {
        messageCounter += 1
        let metadata: Record<string, unknown> | undefined
        let text = ""
        try {
          const parsed = JSON.parse(body) as { metadata?: Record<string, unknown>; text?: string }
          metadata = parsed.metadata
          text = typeof parsed.text === "string" ? parsed.text : ""
        } catch {
          // keep the defaults
        }
        const sessionID = decodeURIComponent(path.split("/")[3] ?? "")
        const id = `msg_mock_${messageCounter}`
        messagesBySession.set(sessionID, [...(messagesBySession.get(sessionID) ?? []), { id, type: "user", metadata, text }])
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ data: { id, sessionID, type: "user", payload: { text }, delivery: "steer" } }))
        return
      }
      if (req.method === "GET" && path.startsWith("/api/session/") && path.endsWith("/message")) {
        const sessionID = decodeURIComponent(path.split("/")[3] ?? "")
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ data: [...(messagesBySession.get(sessionID) ?? [])].reverse() }))
        return
      }
      if (
        req.method === "POST" &&
        path.startsWith("/api/session/") &&
        (path.endsWith("/model") || path.endsWith("/agent"))
      ) {
        res.writeHead(204)
        res.end()
        return
      }

      if (req.method === "GET" && path === "/api/info") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            version: "1.2.3",
            pid: 4242,
            urls: ["http://127.0.0.1:4096"],
            paths: { home: "/root", data: "/root/.local/share/opencode" },
          }),
        )
        return
      }

      if (req.method === "GET" && path === "/api/session") {
        const parentID = new URLSearchParams(search).get("parentID")
        const data = [...sessions.values()].filter((session) => !parentID || session.parentID === parentID)
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ data, cursor: { previous: null, next: null } }))
        return
      }

      if (req.method === "POST" && path === "/api/session") {
        sessionCounter += 1
        let input: {
          location?: { directory?: string }
          parentID?: string
          metadata?: Record<string, unknown>
        } = {}
        try {
          input = JSON.parse(body) as typeof input
        } catch {
          // an empty body is fine for the mock
        }
        const session = {
          id: `ses_mock_${sessionCounter}`,
          ...(input.parentID ? { parentID: input.parentID } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
          location: { directory: input.location?.directory ?? "" },
          model: null,
        }
        sessions.set(session.id, session)
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ data: session }))
        return
      }

      if (req.method === "GET" && path === "/api/session/active") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ data: Object.fromEntries([...active].map((id) => [id, { type: "running" }])) }))
        return
      }

      if (req.method === "GET" && path === "/api/model") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            data: [
              { id: "test-model", providerID: "test" },
              { id: "critic-model", providerID: "test" },
              { id: "judge-model", providerID: "test" },
            ],
          }),
        )
        return
      }

      if (
        req.method === "POST" &&
        path.startsWith("/api/session/") &&
        path.endsWith("/interrupt")
      ) {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ interrupted: true }))
        return
      }

      // One session detail: /api/session/:id (no sub-path).
      if (req.method === "GET" && /^\/api\/session\/[^/]+$/.test(path)) {
        const sessionID = decodeURIComponent(path.split("/")[3] ?? "")
        const session = sessions.get(sessionID)
        if (!session) {
          res.writeHead(404, { "content-type": "application/json" })
          res.end(JSON.stringify({ error: "not_found" }))
          return
        }
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ data: session }))
        return
      }

      if (path.includes("/instructions/entries/")) {
        const segments = path.split("/")
        const sessionID = decodeURIComponent(segments[4] ?? "")
        const key = decodeURIComponent(segments[7] ?? "")
        if (req.method === "PUT") {
          const entries = instructions.get(sessionID) ?? new Map<string, string>()
          let value = ""
          try {
            value = String((JSON.parse(body) as { value?: unknown }).value ?? "")
          } catch {
            // keep the empty value
          }
          entries.set(key, value)
          instructions.set(sessionID, entries)
          res.writeHead(204)
          res.end()
          return
        }
        if (req.method === "DELETE") {
          instructions.get(sessionID)?.delete(key)
          res.writeHead(204)
          res.end()
          return
        }
      }

      if (path === "/api/pty") {
        if (req.method === "GET") {
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ data: ptys.filter((pty) => pty.status === "running") }))
          return
        }
        if (req.method === "POST") {
          ptyCounter += 1
          let input: { command?: string; args?: string[]; cwd?: string; title?: string } = {}
          try {
            input = JSON.parse(body) as typeof input
          } catch {
            // an empty body is fine: the mock answers with defaults
          }
          const pty = {
            id: `pty_mock_${ptyCounter}`,
            pid: 5000 + ptyCounter,
            status: "running",
            title: input.title ?? "",
            command: input.command ?? "",
            args: input.args ?? [],
            cwd: input.cwd ?? "",
          }
          ptys.push(pty)
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ data: pty }))
          return
        }
      }

      if (req.method === "DELETE" && path.startsWith("/api/pty/")) {
        const ptyID = decodeURIComponent(path.slice("/api/pty/".length))
        const index = ptys.findIndex((pty) => pty.id === ptyID)
        if (index >= 0) ptys.splice(index, 1)
        res.writeHead(204)
        res.end()
        return
      }

      if (req.method === "PATCH" && path.startsWith("/api/session/")) {
        res.writeHead(204)
        res.end()
        return
      }

      if (req.method === "DELETE" && path.startsWith("/api/session/")) {
        sessions.delete(decodeURIComponent(path.split("/")[3] ?? ""))
        res.writeHead(204)
        res.end()
        return
      }

      if (req.method === "POST" && path.includes("/session/") && path.endsWith("/prompt_async")) {
        res.writeHead(204)
        res.end()
        return
      }

      if (req.method === "GET" && path === "/api/event") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
        res.write(
          `data: ${JSON.stringify({ id: "evt_connected", type: "server.connected", data: {} })}\n\n`,
        )
        sseClients.add(res)
        res.on("close", () => sseClients.delete(res))
        return
      }

      if (req.method === "GET" && path === "/api/command") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            location: { directory: "/e2e" },
            data: [
              { name: "review", description: "review changes [commit|branch|pr], defaults to uncommitted" },
              { name: "create-file", description: "Create a file with content" },
              { name: "init", description: "guided AGENTS.md setup" },
            ],
          }),
        )
        return
      }

      if (req.method === "GET" && path === "/api/config") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(
          JSON.stringify([
            {
              type: "document",
              info: {
                commands: {
                  "create-file": { template: "Create a file named $1 in directory $2 with content: $3" },
                  init: { template: "Say hello." },
                },
              },
            },
          ]),
        )
        return
      }

      res.writeHead(404, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "not_found" }))
    })
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    emit(event) {
      for (const client of sseClients) {
        client.write(`data: ${JSON.stringify(event)}\n\n`)
      }
    },
    failNext(fragment, times, status = 503) {
      failures.push({ fragment, remaining: times, status })
    },
    addSession(input) {
      const [providerID = "", id = ""] = input.model ? input.model.split("/") : []
      sessions.set(input.id, {
        id: input.id,
        location: { directory: input.directory ?? "/e2e" },
        model: input.model ? { id, providerID } : null,
      })
    },
    reply(sessionID, text) {
      messageCounter += 1
      const messages = messagesBySession.get(sessionID) ?? []
      messages.push({ id: `msg_mock_${messageCounter}`, type: "assistant", content: [{ type: "text", text }] })
      messagesBySession.set(sessionID, messages)
    },
    sessionWithInstruction(key) {
      for (const [sessionID, entries] of instructions) {
        if (entries.has(key)) return sessionID
      }
      return null
    },
    setActive(sessionIDs) {
      active.clear()
      for (const id of sessionIDs) active.add(id)
    },
    close: () =>
      new Promise((resolve) => {
        for (const client of sseClients) client.end()
        server.close(() => resolve())
      }),
  }
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    opencodeUrl: "http://127.0.0.1:1",
    opencodeAuth: null,
    opencodeTimeoutMs: 10_000,
    masterhandPassword: "secret",
    sessionSecret: "test-secret",
    sessionTtlHours: 720,
    cookieSecure: false,
    dataDir: "/tmp/masterhand-test",
    webDist: null,
    allowedOrigins: [],
    workspacesRoot: "/tmp/masterhand-workspaces",
    worktreesRoot: "/tmp/masterhand-worktrees",
    gitUserName: "MasterHand Tests",
    gitUserEmail: "tests@masterhand.local",
    previewEnabled: true,
    previewOrigin: "127.0.0.1",
    previewPortRange: { min: 32900, max: 32999 },
    previewReadinessMs: 25_000,
    cloudflaredBin: "cloudflared",
    diskLowWatermarkMb: 512,
    customProvidersFile: "/tmp/masterhand-test/masterhand-providers.json",
    ...overrides,
  }
}

/** In-memory `git` stand-in: records calls and answers like a clean repo. */
export interface FakeWorktrees extends WorktreeManager {
  calls: string[]
  /** Branch names currently "created" by the fake. */
  knownBranches: Set<string>
}

export function createFakeWorktreeManager(overrides: Partial<WorktreeManager> = {}): FakeWorktrees {
  const calls: string[] = []
  const branches = new Set<string>()
  const manager: FakeWorktrees = {
    calls,
    knownBranches: branches,
    isRepoRoot: async () => true,
    ensureRepo: async (path) => {
      calls.push(`ensure:${path}`)
    },
    headBranch: async () => "main",
    create: async (repo, path, branch) => {
      calls.push(`create:${repo}:${path}:${branch}`)
      branches.add(branch)
    },
    remove: async (repo, path, branch) => {
      calls.push(`remove:${repo}:${path}:${branch}`)
      branches.delete(branch)
    },
    quarantine: async (repo, path) => {
      calls.push(`quarantine:${repo}:${path}`)
      return `${path}.orphaned-test`
    },
    list: async () => [],
    commitAll: async (path) => {
      calls.push(`commit:${path}`)
      return true
    },
    hasRemote: async () => false,
    remoteUrl: async () => null,
    push: async (path, branch) => {
      calls.push(`push:${path}:${branch}`)
    },
    pullRequest: async () => null,
    branches: async () => ({ current: "main", branches: ["main"] }),
    isDirty: async () => false,
    createBranch: async (repo, name) => {
      calls.push(`create-branch:${repo}:${name}`)
      branches.add(name)
    },
    checkout: async (repo, name) => {
      calls.push(`checkout:${repo}:${name}`)
    },
    ...overrides,
  }
  return manager
}

export interface TestApp {
  url: string
  config: Config
  store: Store
  hub: EventHub
  preview: PreviewManager
  close(): Promise<void>
}

export interface FakeTunnel {
  spawnImpl: typeof import("node:child_process").spawn
  /** Every spawned fake process, in order. */
  children: ChildProcess[]
  /** Command and args of every spawn call. */
  calls: { command: string; args: string[] }[]
  url: string
}

interface FakeChildProcess extends EventEmitter {
  pid?: number
  stdout: PassThrough
  stderr: PassThrough
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  kill(signal?: NodeJS.Signals): boolean
}

/**
 * Stand-in for the `cloudflared` process: emits a trycloudflare URL and stays
 * alive until killed. Set `fail` to make it exit before announcing a URL.
 */
export function createFakeTunnel(
  url = "https://fake-preview.trycloudflare.com",
  options: { fail?: boolean; silent?: boolean; pid?: number } = {},
): FakeTunnel {
  const children: ChildProcess[] = []
  const calls: FakeTunnel["calls"] = []
  const spawnImpl = ((command: string, args: string[]): ChildProcess => {
    calls.push({ command, args })
    const child = new EventEmitter() as unknown as FakeChildProcess
    child.pid = options.pid
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.exitCode = null
    child.signalCode = null
    child.kill = (signal?: NodeJS.Signals) => {
      if (child.exitCode !== null || child.signalCode !== null) return true
      child.exitCode = 0
      child.signalCode = signal ?? "SIGTERM"
      child.emit("exit", 0, child.signalCode)
      return true
    }
    children.push(child as unknown as ChildProcess)
    if (!options.silent) {
      setTimeout(() => {
        if (options.fail) {
          child.exitCode = 1
          child.emit("exit", 1, null)
          return
        }
        child.stderr.write(`Your quick Tunnel has been created! Visit it at ${url}\n`)
      }, 5)
    }
    return child as unknown as ChildProcess
  }) as unknown as typeof import("node:child_process").spawn
  return { spawnImpl, children, calls, url }
}

export async function startTestApp(
  options: {
    config?: Partial<Config>
    store?: Store
    createDir?: (path: string) => Promise<void>
    removeDir?: (path: string) => Promise<void>
    worktrees?: WorktreeManager
    providers?: CustomProviderStore
    goals?: import("../src/goal.js").GoalManager
    proxyRetry?: import("../src/proxy.js").ProxyRetryOptions
    fetchImpl?: typeof fetch
    preview?: PreviewManager
    sessionsCacheMs?: number
    sseQueueMax?: number
    diskFreeBytes?: (path: string) => number | null
    previewOptions?: {
      spawnImpl?: typeof import("node:child_process").spawn
      probe?: (host: string, port: number, timeoutMs: number) => Promise<boolean>
      available?: () => boolean | Promise<boolean>
      readinessImpl?: (url: string) => Promise<boolean>
      urlTimeoutMs?: number
      readinessTimeoutMs?: number
      readinessIntervalMs?: number
    }
  } = {},
): Promise<TestApp> {
  const config = testConfig(options.config)
  const store = options.store ?? createMemoryStore()
  const hub = createEventHub({
    url: new URL("/api/event", config.opencodeUrl).toString(),
    authHeader: config.opencodeAuth,
    reconnectBaseMs: 50,
    reconnectMaxMs: 200,
  })
  const preview =
    options.preview ??
    createPreviewManager({
      config,
      store,
      availableImpl: options.previewOptions?.available ?? (() => true),
      probe: options.previewOptions?.probe ?? (async () => true),
      readinessImpl: options.previewOptions?.readinessImpl ?? (async () => true),
      spawnImpl: options.previewOptions?.spawnImpl,
      urlTimeoutMs: options.previewOptions?.urlTimeoutMs,
      readinessTimeoutMs: options.previewOptions?.readinessTimeoutMs,
      readinessIntervalMs: options.previewOptions?.readinessIntervalMs,
    })
  const app = createApp({
    config,
    store,
    hub,
    createDir: options.createDir ?? (async () => {}),
    removeDir: options.removeDir ?? (async () => {}),
    worktrees: options.worktrees ?? createFakeWorktreeManager(),
    providers: options.providers,
    goals: options.goals,
    proxyRetry: options.proxyRetry ?? { baseDelayMs: 1, jitter: false },
    fetchImpl: options.fetchImpl,
    preview,
    sessionsCacheMs: options.sessionsCacheMs,
    sseQueueMax: options.sseQueueMax,
    diskFreeBytes: options.diskFreeBytes,
  })
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" })
  await new Promise<void>((resolve) => server.once("listening", resolve))
  const address = server.address() as AddressInfo

  hub.start()

  return {
    url: `http://127.0.0.1:${address.port}`,
    config,
    store,
    hub,
    preview,
    close: async () => {
      preview.stopAll()
      hub.stop()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

export async function login(baseUrl: string, password = "secret"): Promise<string> {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  })
  const setCookie = response.headers.getSetCookie()[0] ?? ""
  return setCookie.split(";")[0] ?? ""
}

export interface IssuedDevice {
  token: string
  device: DeviceRecord
}

export async function createDevice(baseUrl: string, name = "Test device", password = "secret"): Promise<IssuedDevice> {
  const response = await fetch(`${baseUrl}/api/devices`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, password }),
  })
  if (!response.ok) throw new Error(`device creation failed: HTTP ${response.status}`)
  return (await response.json()) as IssuedDevice
}

export async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  needle: string,
  timeoutMs = 8000,
): Promise<string> {
  const decoder = new TextDecoder()
  let accumulated = ""
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    const result = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), remaining),
      ),
    ])
    if (result.done) break
    accumulated += decoder.decode(result.value, { stream: true })
    if (accumulated.includes(needle)) break
  }

  await reader.cancel().catch(() => {})
  return accumulated
}
