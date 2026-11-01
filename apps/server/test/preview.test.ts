import { describe, expect, it, vi } from "vitest"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, statSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AddressInfo } from "node:net"
import { createSqliteStore } from "../src/store.js"
import type { Store } from "../src/store.js"
import {
  cleanupOrphanTunnels,
  createPidFileStore,
  createPreviewManager,
  PreviewError,
  previewSystemPrompt,
  reachableOverHttp,
  tunnelPidFile,
} from "../src/preview.js"
import { createFakeTunnel, testConfig, waitFor } from "./helpers.js"

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function setup(overrides: Parameters<typeof testConfig>[0] = {}, tunnel = createFakeTunnel()) {
  const config = testConfig(overrides)
  const store = createSqliteStore(":memory:")
  const manager = createPreviewManager({
    config,
    store,
    spawnImpl: tunnel.spawnImpl,
    probe: async () => true,
    availableImpl: () => true,
    readinessImpl: async () => true,
  })
  return { config, store, manager, tunnel }
}

describe("preview port reservation", () => {
  it("assigns the lowest free port and persists it", () => {
    const { store, manager } = setup({ previewPortRange: { min: 33000, max: 33002 } })

    expect(manager.portFor("ses_a")).toBe(33000)
    expect(manager.portFor("ses_b")).toBe(33001)
    expect(manager.portFor("ses_a")).toBe(33000)
    expect(store.getPreviewPort("ses_a")).toBe(33000)
  })

  it("recycles the oldest stale mapping when the pool is drained", () => {
    const { store, manager } = setup({ previewPortRange: { min: 33000, max: 33001 } })

    manager.portFor("ses_a")
    manager.portFor("ses_b")
    expect(manager.portFor("ses_c")).toBe(33000)
    expect(store.getPreviewPort("ses_a")).toBeNull()
    expect(store.getPreviewPort("ses_c")).toBe(33000)
  })

  it("retries with a fresh port when a concurrent session takes the port", () => {
    const dir = mkdtempSync(join(tmpdir(), "masterhand-preview-"))
    const store = createSqliteStore(join(dir, "test.sqlite"))
    try {
      const config = testConfig({ previewPortRange: { min: 33000, max: 33002 } })
      const manager = createPreviewManager({
        config,
        store,
        probe: async () => true,
        availableImpl: () => true,
        readinessImpl: async () => true,
      })
      expect(manager.portFor("ses_a")).toBe(33000)

      // Reproduce the list/insert race against the real constraint: the second
      // allocation does not see ses_a's row, picks 33000 again and UNIQUE(port)
      // rejects the insert. The retry must choose a fresh port and keep both
      // rows, instead of silently replacing ses_a's reservation.
      let hideReserved = true
      const racing: Store = {
        ...store,
        listPreviewPorts: () => {
          if (!hideReserved) return store.listPreviewPorts()
          hideReserved = false
          return []
        },
      }
      const racer = createPreviewManager({
        config,
        store: racing,
        probe: async () => true,
        availableImpl: () => true,
        readinessImpl: async () => true,
      })

      expect(racer.portFor("ses_b")).toBe(33001)
      expect(store.listPreviewPorts().map(({ sessionID, port }) => [sessionID, port])).toEqual([
        ["ses_a", 33000],
        ["ses_b", 33001],
      ])
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("preview tunnel lifecycle", () => {
  it("starts cloudflared, reports the public URL and is idempotent", async () => {
    const { manager, tunnel } = setup()

    const started = await manager.start("ses_1")
    expect(started).toMatchObject({
      status: "running",
      url: "https://fake-preview.trycloudflare.com",
      lastUrl: "https://fake-preview.trycloudflare.com",
      port: 32900,
    })
    expect(tunnel.children).toHaveLength(1)
    expect(manager.status("ses_1")).toMatchObject({
      status: "running",
      url: "https://fake-preview.trycloudflare.com",
      lastUrl: "https://fake-preview.trycloudflare.com",
      error: null,
    })

    const again = await manager.start("ses_1")
    expect(again.url).toBe(started.url)
    expect(again.lastUrl).toBe(started.url)
    expect(tunnel.children).toHaveLength(1)
    expect(manager.status("ses_1")).toMatchObject({ status: "running", error: null })
  })

  it("logs the running URL after readiness", async () => {
    const { manager } = setup()
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    try {
      await manager.start("ses_1")
      expect(info).toHaveBeenCalledWith(
        "[preview] ses_1: running at https://fake-preview.trycloudflare.com (port 32900)",
      )
      await manager.stop("ses_1")
    } finally {
      info.mockRestore()
    }
  })

  it("returns the new URL after a stop and restart", async () => {
    const first = "https://first-preview.trycloudflare.com"
    const second = "https://second-preview.trycloudflare.com"
    const tunnel = createFakeTunnel(first, { urls: [first, second] })
    const { manager } = setup({}, tunnel)

    const started = await manager.start("ses_1")
    expect(started).toMatchObject({ status: "running", url: first, lastUrl: first })

    await manager.stop("ses_1")
    expect(manager.status("ses_1")).toMatchObject({ status: "stopped", url: null, lastUrl: first })

    const restarted = await manager.start("ses_1")
    expect(restarted).toMatchObject({ status: "running", url: second, lastUrl: second })
    expect(manager.status("ses_1")).toMatchObject({ status: "running", url: second, lastUrl: second })
    expect(tunnel.children).toHaveLength(2)
  })

  it("cancels a start that a stop crosses and restarts cleanly", async () => {
    const first = "https://first-preview.trycloudflare.com"
    const second = "https://second-preview.trycloudflare.com"
    const tunnel = createFakeTunnel(first, { urls: [first, second] })
    const release = deferred()
    let readinessEntered = false
    const manager = createPreviewManager({
      config: testConfig(),
      store: createSqliteStore(":memory:"),
      spawnImpl: tunnel.spawnImpl,
      probe: async () => true,
      availableImpl: () => true,
      readinessImpl: async () => {
        readinessEntered = true
        await release.promise
        return true
      },
    })

    const oldStart = manager.start("ses_1")
    await waitFor(() => readinessEntered)
    expect(manager.status("ses_1")).toMatchObject({ status: "starting", url: null, lastUrl: first })

    // The stop must not wait out the readiness budget: it kills the child now.
    await manager.stop("ses_1")
    expect(tunnel.children[0]!.signalCode).toBe("SIGTERM")

    release.resolve()
    await expect(oldStart).rejects.toMatchObject({ code: "preview_stopped" })
    expect(manager.status("ses_1")).toMatchObject({ status: "stopped", url: null, lastUrl: first })

    const restarted = await manager.start("ses_1")
    expect(restarted).toMatchObject({ status: "running", url: second, lastUrl: second })
    expect(tunnel.children).toHaveLength(2)
    expect(tunnel.children[1]!.signalCode).toBeNull()
  })

  it("rewrites the Host header so host-allowlisting dev servers accept the tunnel", async () => {
    const { manager, tunnel } = setup()
    await manager.start("ses_1")

    const args = tunnel.calls[0]!.args
    expect(args).toContain("--http-host-header")
    expect(args[args.indexOf("--http-host-header") + 1]).toBe("localhost:32900")
    expect(args).toContain("http://127.0.0.1:32900")
  })

  it("refuses to start when the dev server is not listening", async () => {
    const config = testConfig()
    const store = createSqliteStore(":memory:")
    const manager = createPreviewManager({
      config,
      store,
      probe: async () => false,
      spawnImpl: createFakeTunnel().spawnImpl,
      availableImpl: () => true,
    })

    await expect(manager.start("ses_1")).rejects.toMatchObject({ code: "preview_not_running" })
    expect(manager.status("ses_1").status).toBe("stopped")
  })

  it("fails when the tunnel exits before announcing a URL", async () => {
    const tunnel = createFakeTunnel("https://unused.trycloudflare.com", { fail: true })
    const { manager } = setup({}, tunnel)

    await expect(manager.start("ses_1")).rejects.toMatchObject({ code: "preview_tunnel_exited" })
  })

  it("times out when the tunnel never announces a URL", async () => {
    const config = testConfig()
    const store = createSqliteStore(":memory:")
    const tunnel = createFakeTunnel("https://unused.trycloudflare.com", { silent: true })
    const manager = createPreviewManager({
      config,
      store,
      spawnImpl: tunnel.spawnImpl,
      probe: async () => true,
      availableImpl: () => true,
      readinessImpl: async () => true,
      urlTimeoutMs: 20,
    })

    await expect(manager.start("ses_1")).rejects.toMatchObject({ code: "preview_tunnel_timeout" })
    expect(tunnel.children[0]!.signalCode).toBe("SIGTERM")
  })

  it("fails when the public URL never becomes reachable", async () => {
    const config = testConfig()
    const store = createSqliteStore(":memory:")
    const tunnel = createFakeTunnel()
    const manager = createPreviewManager({
      config,
      store,
      spawnImpl: tunnel.spawnImpl,
      probe: async () => true,
      availableImpl: () => true,
      readinessImpl: async () => false,
      readinessTimeoutMs: 30,
      readinessIntervalMs: 5,
    })

    await expect(manager.start("ses_1")).rejects.toMatchObject({ code: "preview_tunnel_unreachable" })
    expect(tunnel.children[0]!.signalCode).toBe("SIGTERM")
    // The announced URL survives the readiness failure for diagnosis.
    expect(manager.status("ses_1")).toMatchObject({
      status: "stopped",
      url: null,
      lastUrl: "https://fake-preview.trycloudflare.com",
    })
  })

  it("skips the readiness check when it is disabled", async () => {
    const config = testConfig({ previewReadinessMs: 0 })
    const store = createSqliteStore(":memory:")
    const tunnel = createFakeTunnel()
    const manager = createPreviewManager({
      config,
      store,
      spawnImpl: tunnel.spawnImpl,
      probe: async () => true,
      availableImpl: () => true,
      readinessImpl: async () => {
        throw new Error("readiness must not be called")
      },
    })

    await expect(manager.start("ses_1")).resolves.toMatchObject({ status: "running" })
  })

  it("reports an error when a running tunnel dies", async () => {
    const { manager, tunnel } = setup()
    await manager.start("ses_1")

    tunnel.children[0]!.kill("SIGKILL")
    expect(manager.status("ses_1")).toMatchObject({
      status: "error",
      url: null,
      lastUrl: "https://fake-preview.trycloudflare.com",
      error: "cloudflared exited (SIGKILL)",
    })
  })

  it("stops and forgets a preview", async () => {
    const { manager, tunnel, store } = setup()
    await manager.start("ses_1")

    // Contract pin for issue #200: stopping touches the PID file, so it is
    // asynchronous and never blocks the event loop.
    const stopped = manager.stop("ses_1")
    expect(stopped).toBeInstanceOf(Promise)
    await stopped
    expect(tunnel.children[0]!.signalCode).toBe("SIGTERM")
    // The last URL survives the stop; only the live URL is cleared.
    expect(manager.status("ses_1")).toMatchObject({
      status: "stopped",
      url: null,
      lastUrl: "https://fake-preview.trycloudflare.com",
    })
    // stop keeps the reserved port: the tunnel can be restarted.
    expect(store.getPreviewPort("ses_1")).toBe(32900)

    await manager.forget("ses_1")
    expect(manager.status("ses_1")).toMatchObject({ status: "stopped", lastUrl: null })
    expect(store.getPreviewPort("ses_1")).toBeNull()
  })

  it("waits for an in-flight start before forgetting, so the tunnel is killed and untracked", async () => {
    const gate = deferred()
    const config = testConfig()
    const store = createSqliteStore(":memory:")
    const tunnel = createFakeTunnel()
    const manager = createPreviewManager({
      config,
      store,
      spawnImpl: tunnel.spawnImpl,
      probe: async () => true,
      availableImpl: () => true,
      readinessImpl: async () => {
        await gate.promise
        return true
      },
    })

    const start = manager.start("ses_1")
    await waitFor(() => tunnel.children.length === 1)
    expect(store.getPreviewPort("ses_1")).toBe(32900)

    const forgotten = manager.forget("ses_1")
    gate.resolve()
    await forgotten
    await start.catch(() => {})

    expect(tunnel.children[0]!.signalCode).toBe("SIGTERM")
    expect(manager.status("ses_1").status).toBe("stopped")
    expect(store.getPreviewPort("ses_1")).toBeNull()
  })

  it("stopAll kills every tunnel", async () => {
    const { manager, tunnel } = setup()
    await manager.start("ses_1")
    await manager.start("ses_2")

    await manager.stopAll()
    expect(tunnel.children).toHaveLength(2)
    for (const child of tunnel.children) expect(child.signalCode).toBe("SIGTERM")
    expect(manager.status("ses_1").status).toBe("stopped")
    expect(manager.status("ses_2").status).toBe("stopped")
  })

  it("stopAll cancels a starting tunnel", async () => {
    const tunnel = createFakeTunnel()
    const release = deferred()
    let readinessEntered = false
    const manager = createPreviewManager({
      config: testConfig(),
      store: createSqliteStore(":memory:"),
      spawnImpl: tunnel.spawnImpl,
      probe: async () => true,
      availableImpl: () => true,
      readinessImpl: async () => {
        readinessEntered = true
        await release.promise
        return true
      },
    })

    const start = manager.start("ses_1")
    await waitFor(() => readinessEntered)
    await manager.stopAll()
    expect(tunnel.children[0]!.signalCode).toBe("SIGTERM")
    expect(manager.status("ses_1")).toMatchObject({ status: "stopped", url: null, lastUrl: null })

    release.resolve()
    await expect(start).rejects.toMatchObject({ code: "preview_stopped" })
  })
})

describe("tunnel PID file store", () => {
  it("serializes concurrent read-modify-writes so no tracking is lost", async () => {
    // A track racing an untrack must not lose an update (issue #200): every
    // RMW runs through one chain instead of touching the filesystem inline.
    let file = "[]"
    let reads = 0
    let releaseRead!: () => void
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    const store = createPidFileStore("/data/preview-tunnels.json", {
      readFile: async () => {
        reads += 1
        if (reads === 1) await readGate
        return file
      },
      writeFile: async (_file: string, data: string, _mode: number) => {
        file = data
      },
      chmod: async () => {},
      rm: async () => {},
    })

    const first = store.add(111)
    const second = store.add(222)
    await new Promise((resolve) => setTimeout(resolve, 20))
    // Serialized: the second add has not even read yet while the first is
    // still inside its read. Unserialized RMWs would both read here.
    expect(reads).toBe(1)
    releaseRead()
    await Promise.all([first, second])
    expect(JSON.parse(file).sort()).toEqual([111, 222])
  })
})

describe("orphan tunnel cleanup", () => {
  it("kills only PIDs confirmed to be cloudflared and removes the pid file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mh-tunnels-"))
    const file = tunnelPidFile(dir)
    writeFileSync(file, JSON.stringify([111, 222, 333]))
    const killed: number[] = []
    const names = new Map<number, string>([
      [111, "cloudflared"],
      [222, "node"],
      [333, "cloudflared"],
    ])
    try {
      const result = await cleanupOrphanTunnels({
        pidFile: file,
        processName: (pid) => names.get(pid) ?? null,
        kill: (pid) => killed.push(pid),
      })
      expect(result).toEqual([111, 333])
      expect(killed).toEqual([111, 333])
      expect(existsSync(file)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("tolerates a missing or malformed pid file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mh-tunnels-"))
    try {
      // Contract pin for issue #200: reaping never blocks the event loop.
      expect(cleanupOrphanTunnels({ pidFile: tunnelPidFile(dir) })).toBeInstanceOf(Promise)
      expect(await cleanupOrphanTunnels({ pidFile: tunnelPidFile(dir) })).toEqual([])
      writeFileSync(tunnelPidFile(dir), "{not json")
      expect(await cleanupOrphanTunnels({ pidFile: tunnelPidFile(dir) })).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("writes the tunnel PID file as 0600 and tightens an existing one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mh-tunnels-"))
    const file = tunnelPidFile(dir)
    // A file left by an older version is world-readable: tracking must fix it.
    writeFileSync(file, JSON.stringify([111]))
    chmodSync(file, 0o644)
    const tunnel = createFakeTunnel("https://fake-preview.trycloudflare.com", { pid: 4242 })
    const manager = createPreviewManager({
      config: testConfig({ dataDir: dir }),
      store: createSqliteStore(":memory:"),
      spawnImpl: tunnel.spawnImpl,
      probe: async () => true,
      availableImpl: () => true,
      readinessImpl: async () => true,
    })
    try {
      await manager.start("ses_1")
      expect(statSync(file).mode & 0o777).toBe(0o600)
      await manager.stop("ses_1")
      expect(statSync(file).mode & 0o777).toBe(0o600)
    } finally {
      await manager.stopAll()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("tracks a spawned tunnel PID and drops it on stop", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mh-tunnels-"))
    const tunnel = createFakeTunnel("https://fake-preview.trycloudflare.com", { pid: 4242 })
    const manager = createPreviewManager({
      config: testConfig({ dataDir: dir }),
      store: createSqliteStore(":memory:"),
      spawnImpl: tunnel.spawnImpl,
      probe: async () => true,
      availableImpl: () => true,
      readinessImpl: async () => true,
    })
    try {
      await manager.start("ses_1")
      expect(JSON.parse(readFileSync(tunnelPidFile(dir), "utf8"))).toEqual([4242])

      await manager.stop("ses_1")
      expect(JSON.parse(readFileSync(tunnelPidFile(dir), "utf8"))).toEqual([])

      await manager.start("ses_1")
      await manager.stopAll()
      expect(JSON.parse(readFileSync(tunnelPidFile(dir), "utf8"))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("preview availability", () => {
  it("uses the injected availability check and caches it", async () => {
    const config = testConfig()
    let calls = 0
    const manager = createPreviewManager({
      config,
      store: createSqliteStore(":memory:"),
      availableImpl: () => {
        calls += 1
        return false
      },
    })

    await expect(manager.available()).resolves.toBe(false)
    await expect(manager.available()).resolves.toBe(false)
    expect(calls).toBe(1)
  })

  it("reports unavailable when the binary does not exist", async () => {
    const manager = createPreviewManager({
      config: testConfig({ cloudflaredBin: "/nonexistent/cloudflared-xyz" }),
      store: createSqliteStore(":memory:"),
    })
    await expect(manager.available()).resolves.toBe(false)
  })
})

describe("previewSystemPrompt", () => {
  it("pins the port and the 0.0.0.0 bind", () => {
    const prompt = previewSystemPrompt(3200)
    expect(prompt).toContain("3200")
    expect(prompt).toContain("0.0.0.0")
  })

  it("warns about host/origin allowlists", () => {
    const prompt = previewSystemPrompt(3200)
    expect(prompt).toContain(".trycloudflare.com")
    expect(prompt).toContain("allowedHosts")
  })
})

describe("PreviewError", () => {
  it("carries a code and detail", () => {
    const error = new PreviewError("preview_failed", "boom")
    expect(error.code).toBe("preview_failed")
    expect(error.message).toBe("preview_failed: boom")
  })
})

describe("reachableOverHttp", () => {
  it("accepts non-5xx answers and rejects 5xx, DNS and connection errors", async () => {
    const server = createServer((req, res) => {
      res.writeHead(req.url === "/ok" ? 200 : 530)
      res.end("x")
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as AddressInfo).port
    try {
      expect(await reachableOverHttp(`http://127.0.0.1:${port}/ok`)).toBe(true)
      expect(await reachableOverHttp(`http://127.0.0.1:${port}/down`)).toBe(false)
      expect(await reachableOverHttp("http://127.0.0.1:1")).toBe(false)
      expect(await reachableOverHttp("http://no-such-host.invalid")).toBe(false)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
