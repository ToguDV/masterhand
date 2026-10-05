import { describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AddressInfo } from "node:net"
import { createMemoryStore } from "../src/store.js"
import {
  cleanupOrphanTunnels,
  createPreviewManager,
  PreviewError,
  previewSystemPrompt,
  reachableOverHttp,
  tunnelPidFile,
} from "../src/preview.js"
import { createFakeTunnel, testConfig } from "./helpers.js"

function setup(overrides: Parameters<typeof testConfig>[0] = {}, tunnel = createFakeTunnel()) {
  const config = testConfig(overrides)
  const store = createMemoryStore()
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
})

describe("preview tunnel lifecycle", () => {
  it("starts cloudflared, reports the public URL and is idempotent", async () => {
    const { manager, tunnel } = setup()

    const started = await manager.start("ses_1")
    expect(started).toMatchObject({
      status: "running",
      url: "https://fake-preview.trycloudflare.com",
      port: 32900,
    })
    expect(tunnel.children).toHaveLength(1)

    const again = await manager.start("ses_1")
    expect(again.url).toBe(started.url)
    expect(tunnel.children).toHaveLength(1)
    expect(manager.status("ses_1")).toMatchObject({ status: "running", error: null })
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
    const store = createMemoryStore()
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
    const store = createMemoryStore()
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
    const store = createMemoryStore()
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
    expect(manager.status("ses_1").status).toBe("stopped")
  })

  it("skips the readiness check when it is disabled", async () => {
    const config = testConfig({ previewReadinessMs: 0 })
    const store = createMemoryStore()
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
    expect(manager.status("ses_1")).toMatchObject({ status: "error", error: "cloudflared exited (SIGKILL)" })
  })

  it("stops and forgets a preview", async () => {
    const { manager, tunnel, store } = setup()
    await manager.start("ses_1")

    manager.stop("ses_1")
    expect(tunnel.children[0]!.signalCode).toBe("SIGTERM")
    expect(manager.status("ses_1").status).toBe("stopped")
    // stop keeps the reserved port: the tunnel can be restarted.
    expect(store.getPreviewPort("ses_1")).toBe(32900)

    manager.forget("ses_1")
    expect(store.getPreviewPort("ses_1")).toBeNull()
  })

  it("stopAll kills every tunnel", async () => {
    const { manager, tunnel } = setup()
    await manager.start("ses_1")
    await manager.start("ses_2")

    manager.stopAll()
    expect(tunnel.children).toHaveLength(2)
    for (const child of tunnel.children) expect(child.signalCode).toBe("SIGTERM")
    expect(manager.status("ses_1").status).toBe("stopped")
    expect(manager.status("ses_2").status).toBe("stopped")
  })
})

describe("orphan tunnel cleanup", () => {
  it("kills only PIDs confirmed to be cloudflared and removes the pid file", () => {
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
      const result = cleanupOrphanTunnels({
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

  it("tolerates a missing or malformed pid file", () => {
    const dir = mkdtempSync(join(tmpdir(), "mh-tunnels-"))
    try {
      expect(cleanupOrphanTunnels({ pidFile: tunnelPidFile(dir) })).toEqual([])
      writeFileSync(tunnelPidFile(dir), "{not json")
      expect(cleanupOrphanTunnels({ pidFile: tunnelPidFile(dir) })).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("tracks a spawned tunnel PID and drops it on stop", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mh-tunnels-"))
    const tunnel = createFakeTunnel("https://fake-preview.trycloudflare.com", { pid: 4242 })
    const manager = createPreviewManager({
      config: testConfig({ dataDir: dir }),
      store: createMemoryStore(),
      spawnImpl: tunnel.spawnImpl,
      probe: async () => true,
      availableImpl: () => true,
      readinessImpl: async () => true,
    })
    try {
      await manager.start("ses_1")
      expect(JSON.parse(readFileSync(tunnelPidFile(dir), "utf8"))).toEqual([4242])

      manager.stop("ses_1")
      expect(JSON.parse(readFileSync(tunnelPidFile(dir), "utf8"))).toEqual([])

      await manager.start("ses_1")
      manager.stopAll()
      expect(JSON.parse(readFileSync(tunnelPidFile(dir), "utf8"))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("preview availability", () => {
  it("uses the injected availability check and caches it", () => {
    const config = testConfig()
    let calls = 0
    const manager = createPreviewManager({
      config,
      store: createMemoryStore(),
      availableImpl: () => {
        calls += 1
        return false
      },
    })

    expect(manager.available()).toBe(false)
    expect(manager.available()).toBe(false)
    expect(calls).toBe(1)
  })

  it("reports unavailable when the binary does not exist", () => {
    const manager = createPreviewManager({
      config: testConfig({ cloudflaredBin: "/nonexistent/cloudflared-xyz" }),
      store: createMemoryStore(),
    })
    expect(manager.available()).toBe(false)
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
