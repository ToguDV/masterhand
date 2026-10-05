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
  close(): Promise<void>
}

export async function startMockOpencode(): Promise<MockOpencode> {
  const requests: MockOpencode["requests"] = []
  const sseClients = new Set<import("node:http").ServerResponse>()
  const ptys: Array<{ id: string; title: string; status: string; pid: number; command: string; args: string[]; cwd: string }> = []
  let sessionCounter = 0
  let ptyCounter = 0

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
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ data: [], cursor: { previous: null, next: null } }))
        return
      }

      if (req.method === "POST" && path === "/api/session") {
        sessionCounter += 1
        let directory = ""
        try {
          directory = (JSON.parse(body) as { location?: { directory?: string } }).location?.directory ?? ""
        } catch {
          // an empty body is fine for the mock
        }
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ data: { id: `ses_mock_${sessionCounter}`, directory } }))
        return
      }

      if (req.method === "PUT" && path.includes("/instructions/entries/")) {
        res.writeHead(204)
        res.end()
        return
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
    ...overrides,
  }
}

/** In-memory `git` stand-in: records calls and answers like a clean repo. */
export interface FakeWorktrees extends WorktreeManager {
  calls: string[]
  branches: Set<string>
}

export function createFakeWorktreeManager(overrides: Partial<WorktreeManager> = {}): FakeWorktrees {
  const calls: string[] = []
  const branches = new Set<string>()
  const manager: FakeWorktrees = {
    calls,
    branches,
    isRepoRoot: () => true,
    ensureRepo: (path) => {
      calls.push(`ensure:${path}`)
    },
    headBranch: () => "main",
    create: (repo, path, branch) => {
      calls.push(`create:${repo}:${path}:${branch}`)
      branches.add(branch)
    },
    remove: (repo, path, branch) => {
      calls.push(`remove:${repo}:${path}:${branch}`)
      branches.delete(branch)
    },
    quarantine: (repo, path) => {
      calls.push(`quarantine:${repo}:${path}`)
      return `${path}.orphaned-test`
    },
    list: () => [],
    commitAll: (path) => {
      calls.push(`commit:${path}`)
      return true
    },
    hasRemote: () => false,
    remoteUrl: () => null,
    push: (path, branch) => {
      calls.push(`push:${path}:${branch}`)
    },
    pullRequest: () => null,
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
  options: { fail?: boolean; silent?: boolean } = {},
): FakeTunnel {
  const children: ChildProcess[] = []
  const calls: FakeTunnel["calls"] = []
  const spawnImpl = ((command: string, args: string[]): ChildProcess => {
    calls.push({ command, args })
    const child = new EventEmitter() as unknown as FakeChildProcess
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
    createDir?: (path: string) => void
    removeDir?: (path: string) => void
    worktrees?: WorktreeManager
    fetchImpl?: typeof fetch
    preview?: PreviewManager
    sessionsCacheMs?: number
    sseQueueMax?: number
    previewOptions?: {
      spawnImpl?: typeof import("node:child_process").spawn
      probe?: (host: string, port: number, timeoutMs: number) => Promise<boolean>
      available?: () => boolean
      readinessImpl?: (url: string) => Promise<boolean>
      urlTimeoutMs?: number
      readinessTimeoutMs?: number
      readinessIntervalMs?: number
    }
  } = {},
): Promise<TestApp> {
  const config = testConfig(options.config)
  const store = createMemoryStore()
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
    createDir: options.createDir ?? (() => {}),
    removeDir: options.removeDir ?? (() => {}),
    worktrees: options.worktrees ?? createFakeWorktreeManager(),
    fetchImpl: options.fetchImpl,
    preview,
    sessionsCacheMs: options.sessionsCacheMs,
    sseQueueMax: options.sseQueueMax,
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
