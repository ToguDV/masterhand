import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createFakeTunnel,
  createFakeWorktreeManager,
  login,
  startMockOpencode,
  startTestApp,
  type MockOpencode,
  type TestApp,
} from "./helpers.js"

let app: TestApp | null = null
let upstream: MockOpencode | null = null

afterEach(async () => {
  await app?.close()
  await upstream?.close()
  app = null
  upstream = null
})

describe("request validation", () => {
  it("rejects a non-JSON login body", async () => {
    app = await startTestApp()
    const response = await fetch(`${app.url}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    })
    expect(response.status).toBe(400)
  })

  it("rejects a device request with an invalid body", async () => {
    app = await startTestApp()
    const response = await fetch(`${app.url}/api/devices`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    })
    expect(response.status).toBe(400)
  })

  it("rejects a device request with an empty password", async () => {
    app = await startTestApp()
    const response = await fetch(`${app.url}/api/devices`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Phone" }),
    })
    expect(response.status).toBe(400)
  })

  it("falls back to a default device name", async () => {
    app = await startTestApp()
    const response = await fetch(`${app.url}/api/devices`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "secret", name: "   " }),
    })
    expect(response.status).toBe(201)
    expect((await response.json()) as { device: { name: string } }).toMatchObject({
      device: { name: "Device" },
    })
  })
})

describe("/api/status", () => {
  it("reports a healthy opencode upstream", async () => {
    upstream = await startMockOpencode()
    app = await startTestApp({ config: { opencodeUrl: upstream.url } })
    const cookie = await login(app.url)

    const response = await fetch(`${app.url}/api/status`, { headers: { cookie } })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ok: true,
      opencode: { healthy: true, version: "1.2.3" },
      preview: { enabled: true, available: true, portRange: { min: 32900, max: 32999 } },
    })
  })

  it("reports previews as disabled when configured off", async () => {
    app = await startTestApp({ config: { previewEnabled: false } })
    const cookie = await login(app.url)

    const response = await fetch(`${app.url}/api/status`, { headers: { cookie } })
    const body = (await response.json()) as { preview: { enabled: boolean; available: boolean } }
    expect(body.preview).toEqual({ enabled: false, available: false, portRange: { min: 32900, max: 32999 } })
  })

  it("flags an opencode that rejects the BFF credentials", async () => {
    const stub: typeof fetch = async () => new Response("unauthorized", { status: 401 })
    app = await startTestApp({ fetchImpl: stub })
    const cookie = await login(app.url)

    const response = await fetch(`${app.url}/api/status`, { headers: { cookie } })
    expect(await response.json()).toMatchObject({
      opencode: { healthy: false, error: "unauthorized" },
    })
  })

  it("flags an unreachable opencode", async () => {
    app = await startTestApp({ config: { opencodeUrl: "http://127.0.0.1:1" } })
    const cookie = await login(app.url)

    const response = await fetch(`${app.url}/api/status`, { headers: { cookie } })
    expect(await response.json()).toMatchObject({
      opencode: { healthy: false, error: "unreachable" },
    })
  })
})

describe("preview routes", () => {
  it("starts, reports and stops a session preview", async () => {
    const tunnel = createFakeTunnel()
    app = await startTestApp({
      previewOptions: { spawnImpl: tunnel.spawnImpl, probe: async () => true, available: () => true },
    })
    const cookie = await login(app.url)

    const initial = await fetch(`${app.url}/api/sessions/ses_1/preview`, { headers: { cookie } })
    expect(initial.status).toBe(200)
    expect(await initial.json()).toEqual({
      preview: { status: "stopped", url: null, port: null, error: null },
    })

    const started = await fetch(`${app.url}/api/sessions/ses_1/preview`, {
      method: "POST",
      headers: { cookie },
    })
    expect(started.status).toBe(200)
    expect(await started.json()).toEqual({
      preview: {
        status: "running",
        url: "https://fake-preview.trycloudflare.com",
        port: 32900,
        error: null,
      },
    })

    const listed = await fetch(`${app.url}/api/sessions/ses_1/preview`, { headers: { cookie } })
    expect(((await listed.json()) as { preview: { status: string } }).preview.status).toBe("running")

    const stopped = await fetch(`${app.url}/api/sessions/ses_1/preview`, {
      method: "DELETE",
      headers: { cookie },
    })
    expect(stopped.status).toBe(200)
    expect(tunnel.children[0]!.signalCode).toBe("SIGTERM")
  })

  it("returns 409 when the dev server is not listening", async () => {
    app = await startTestApp({ previewOptions: { probe: async () => false, available: () => true } })
    const cookie = await login(app.url)

    const response = await fetch(`${app.url}/api/sessions/ses_1/preview`, { method: "POST", headers: { cookie } })
    expect(response.status).toBe(409)
    expect(((await response.json()) as { error: string }).error).toBe("preview_not_running")
  })

  it("returns 503 when cloudflared is not installed", async () => {
    app = await startTestApp({ previewOptions: { available: () => false } })
    const cookie = await login(app.url)

    const response = await fetch(`${app.url}/api/sessions/ses_1/preview`, { method: "POST", headers: { cookie } })
    expect(response.status).toBe(503)
    expect(((await response.json()) as { error: string }).error).toBe("preview_unavailable")
  })

  it("returns 404 when previews are disabled", async () => {
    app = await startTestApp({ config: { previewEnabled: false } })
    const cookie = await login(app.url)

    const response = await fetch(`${app.url}/api/sessions/ses_1/preview`, { method: "POST", headers: { cookie } })
    expect(response.status).toBe(404)
  })

  it("reserves the port on session creation and forgets it on deletion", async () => {
    upstream = await startMockOpencode()
    app = await startTestApp({ config: { opencodeUrl: upstream.url } })
    const cookie = await login(app.url)

    app.store.createWorkspace({ id: "ws", name: "ws", path: "/tmp/masterhand-workspaces/ws", createdAt: Date.now() })
    const created = await fetch(`${app.url}/api/workspaces/ws/sessions`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(created.status).toBe(201)
    const { session } = (await created.json()) as { session: { id: string } }

    // The v2 instructions entry carries the reserved port to the agent.
    const instruction = upstream.requests.find((request) =>
      request.path.endsWith("/instructions/entries/masterhand.preview"),
    )
    expect(instruction?.method).toBe("PUT")
    expect(instruction?.path).toBe(
      `/api/experimental/session/${session.id}/instructions/entries/masterhand.preview`,
    )
    expect(JSON.parse(instruction?.body ?? "{}")).toMatchObject({ value: expect.stringContaining("0.0.0.0") })
    expect(app.store.getPreviewPort(session.id)).toBe(32900)

    const deleted = await fetch(`${app.url}/api/workspaces/ws/sessions/${session.id}`, {
      method: "DELETE",
      headers: { cookie },
    })
    expect(deleted.status).toBe(200)
    expect(app.store.getPreviewPort(session.id)).toBeNull()
  })

  it("applies the write and process guards plus the process instruction on session creation", async () => {
    upstream = await startMockOpencode()
    app = await startTestApp({ config: { opencodeUrl: upstream.url } })
    const cookie = await login(app.url)

    app.store.createWorkspace({ id: "ws", name: "ws", path: "/tmp/masterhand-workspaces/ws", createdAt: Date.now() })
    const created = await fetch(`${app.url}/api/workspaces/ws/sessions`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(created.status).toBe(201)
    const { session } = (await created.json()) as { session: { id: string } }

    const patch = upstream.requests.find(
      (request) => request.method === "PATCH" && request.path === `/api/session/${session.id}`,
    )
    const permissions = (JSON.parse(patch?.body ?? "{}") as { permissions?: unknown[] }).permissions ?? []
    expect(permissions).toContainEqual({ action: "edit", resource: "/*", effect: "deny" })
    expect(permissions).toContainEqual({ action: "shell", resource: "pkill*", effect: "deny" })
    expect(permissions).toContainEqual({ action: "shell", resource: "kill $*", effect: "deny" })

    const instruction = upstream.requests.find((request) =>
      request.path.endsWith("/instructions/entries/masterhand.process"),
    )
    expect(instruction?.method).toBe("PUT")
    expect(instruction?.path).toBe(`/api/experimental/session/${session.id}/instructions/entries/masterhand.process`)
    expect(JSON.parse(instruction?.body ?? "{}")).toMatchObject({
      value: expect.stringContaining("never stop processes by name"),
    })
  })

  it("keeps session creation working when the preview instruction is rejected", async () => {
    upstream = await startMockOpencode()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const failingFetch: typeof fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (url.includes("/instructions/entries/")) {
        return Promise.resolve(new Response(null, { status: 500 }))
      }
      return fetch(input, init)
    }

    try {
      app = await startTestApp({ config: { opencodeUrl: upstream.url }, fetchImpl: failingFetch })
      const cookie = await login(app.url)

      app.store.createWorkspace({ id: "ws", name: "ws", path: "/tmp/masterhand-workspaces/ws", createdAt: Date.now() })
      const created = await fetch(`${app.url}/api/workspaces/ws/sessions`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({}),
      })
      expect(created.status).toBe(201)
      const { session } = (await created.json()) as { session: { id: string } }
      // The port stays reserved even though the entry write failed; the agent
      // just does not get the instruction until the preview is started.
      expect(app.store.getPreviewPort(session.id)).toBe(32900)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("HTTP 500"))
    } finally {
      warn.mockRestore()
    }
  })
})

describe("managed run", () => {
  it("saves and validates the workspace run config", async () => {
    app = await startTestApp()
    const cookie = await login(app.url)
    app.store.createWorkspace({ id: "ws", name: "ws", path: "/tmp/masterhand-workspaces/ws", createdAt: Date.now() })

    const invalid = await fetch(`${app.url}/api/workspaces/ws/run`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ command: "bash", args: ["-c", "pkill node"] }),
    })
    expect(invalid.status).toBe(400)
    expect(((await invalid.json()) as { error: string }).error).toBe("command_not_allowed")

    const saved = await fetch(`${app.url}/api/workspaces/ws/run`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ command: "npm", args: ["run", "dev", "--", "--port", "{port}"] }),
    })
    expect(saved.status).toBe(200)
    expect(app.store.getWorkspaceRun("ws")).toMatchObject({ command: "npm", source: "user" })

    const listed = await fetch(`${app.url}/api/workspaces/ws/run`, { headers: { cookie } })
    expect(await listed.json()).toMatchObject({ run: { command: "npm" } })
  })

  it("detects an agent-proposed .masterhand/run.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mh-run-app-"))
    try {
      mkdirSync(join(dir, ".masterhand"))
      writeFileSync(
        join(dir, ".masterhand", "run.json"),
        JSON.stringify({ command: "pnpm", args: ["dev", "--port", "{port}"] }),
      )
      app = await startTestApp()
      const cookie = await login(app.url)
      app.store.createWorkspace({ id: "ws", name: "ws", path: dir, createdAt: Date.now() })
      app.store.createWorkspace({
        id: "empty",
        name: "empty",
        path: join(dir, "does-not-exist"),
        createdAt: Date.now(),
      })

      const detected = await fetch(`${app.url}/api/workspaces/ws/run/detect`, { method: "POST", headers: { cookie } })
      expect(detected.status).toBe(200)
      expect(await detected.json()).toMatchObject({ run: { command: "pnpm", source: "agent" } })

      const missing = await fetch(`${app.url}/api/workspaces/empty/run/detect`, {
        method: "POST",
        headers: { cookie },
      })
      expect(missing.status).toBe(404)
      expect(((await missing.json()) as { error: string }).error).toBe("run_not_found")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("starts and stops a session run through the PTY API", async () => {
    upstream = await startMockOpencode()
    app = await startTestApp({ config: { opencodeUrl: upstream.url } })
    const cookie = await login(app.url)
    app.store.createWorkspace({ id: "ws", name: "ws", path: "/tmp/masterhand-workspaces/ws", createdAt: Date.now() })
    app.store.saveWorkspaceRun({
      workspaceID: "ws",
      command: "npm",
      args: ["run", "dev", "--", "--port", "{port}"],
      cwd: null,
      source: "user",
      updatedAt: Date.now(),
    })

    const started = await fetch(`${app.url}/api/sessions/ses_run/run?workspace=ws`, {
      method: "POST",
      headers: { cookie },
    })
    expect(started.status).toBe(200)
    expect(await started.json()).toMatchObject({ run: { status: "running", port: 32900, pid: 5001 } })

    const ptyCall = upstream.requests.find((request) => request.method === "POST" && request.path === "/api/pty")
    expect(JSON.parse(ptyCall?.body ?? "{}")).toMatchObject({
      command: "npm",
      args: ["run", "dev", "--", "--port", "32900"],
      title: "masterhand:ses_run",
      env: { PORT: "32900" },
    })

    const status = await fetch(`${app.url}/api/sessions/ses_run/run?workspace=ws`, { headers: { cookie } })
    expect(await status.json()).toMatchObject({ run: { status: "running" } })

    const stopped = await fetch(`${app.url}/api/sessions/ses_run/run?workspace=ws`, {
      method: "DELETE",
      headers: { cookie },
    })
    expect(stopped.status).toBe(200)

    const after = await fetch(`${app.url}/api/sessions/ses_run/run?workspace=ws`, { headers: { cookie } })
    expect(await after.json()).toMatchObject({ run: { status: "stopped" } })
  })
})

describe("managed run errors", () => {
  it("requires a workspace and a saved config", async () => {
    app = await startTestApp()
    const cookie = await login(app.url)
    app.store.createWorkspace({ id: "ws", name: "ws", path: "/tmp/masterhand-workspaces/ws", createdAt: Date.now() })

    const noWorkspace = await fetch(`${app.url}/api/sessions/ses_1/run`, { headers: { cookie } })
    expect(noWorkspace.status).toBe(400)

    const noConfig = await fetch(`${app.url}/api/sessions/ses_1/run?workspace=ws`, {
      method: "POST",
      headers: { cookie },
    })
    expect(noConfig.status).toBe(404)
    expect(((await noConfig.json()) as { error: string }).error).toBe("run_not_configured")
  })

  it("reports a spawn failure", async () => {
    upstream = await startMockOpencode()
    app = await startTestApp({
      config: { opencodeUrl: upstream.url },
      fetchImpl: ((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        if (init?.method === "POST" && url.includes("/api/pty")) {
          return Promise.resolve(new Response("boom", { status: 500 }))
        }
        return fetch(input as RequestInfo, init)
      }) as typeof fetch,
    })
    const cookie = await login(app.url)
    app.store.createWorkspace({ id: "ws", name: "ws", path: "/tmp/masterhand-workspaces/ws", createdAt: Date.now() })
    app.store.saveWorkspaceRun({
      workspaceID: "ws",
      command: "npm",
      args: ["dev"],
      cwd: null,
      source: "user",
      updatedAt: 1,
    })

    const failed = await fetch(`${app.url}/api/sessions/ses_1/run?workspace=ws`, {
      method: "POST",
      headers: { cookie },
    })
    expect(failed.status).toBe(502)
    expect(((await failed.json()) as { error: string }).error).toBe("run_spawn_failed")
  })

  it("runs an isolated session in its worktree directory", async () => {
    upstream = await startMockOpencode()
    app = await startTestApp({ config: { opencodeUrl: upstream.url } })
    const cookie = await login(app.url)
    app.store.createWorkspace({ id: "ws", name: "ws", path: "/tmp/masterhand-workspaces/ws", createdAt: Date.now() })
    app.store.saveWorkspaceRun({
      workspaceID: "ws",
      command: "npm",
      args: ["dev"],
      cwd: null,
      source: "user",
      updatedAt: 1,
    })
    app.store.createIsolatedSession({
      sessionID: "ses_iso",
      workspaceID: "ws",
      path: "/tmp/masterhand-worktrees/ws/abc",
      branch: "b",
      baseRef: "main",
      pushed: false,
      prUrl: null,
      createdAt: 1,
    })

    const started = await fetch(`${app.url}/api/sessions/ses_iso/run?workspace=ws`, {
      method: "POST",
      headers: { cookie },
    })
    expect(started.status).toBe(200)
    const ptyCall = upstream.requests.find((request) => request.method === "POST" && request.path === "/api/pty")
    expect(decodeURIComponent(ptyCall?.query ?? "")).toContain("location[directory]=/tmp/masterhand-worktrees/ws/abc")
    expect(JSON.parse(ptyCall?.body ?? "{}")).toMatchObject({ cwd: "/tmp/masterhand-worktrees/ws/abc" })
  })
})

describe("/api/workspaces", () => {
  it("creates the folder under the root, lists and removes it", async () => {
    const createdPaths: string[] = []
    app = await startTestApp({ createDir: (path) => createdPaths.push(path) })
    const cookie = await login(app.url)

    const created = await fetch(`${app.url}/api/workspaces`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "my-app" }),
    })
    expect(created.status).toBe(201)
    const body = (await created.json()) as { workspace: { id: string; name: string; path: string } }
    expect(body.workspace).toMatchObject({
      name: "my-app",
      path: "/tmp/masterhand-workspaces/my-app",
    })
    expect(createdPaths).toEqual(["/tmp/masterhand-workspaces/my-app"])

    const listed = await fetch(`${app.url}/api/workspaces`, { headers: { cookie } })
    expect(listed.status).toBe(200)
    expect((await listed.json()) as { workspaces: unknown[] }).toMatchObject({
      workspaces: [{ id: body.workspace.id }],
    })

    const removed = await fetch(`${app.url}/api/workspaces/${body.workspace.id}`, {
      method: "DELETE",
      headers: { cookie },
    })
    expect(removed.status).toBe(200)
    const empty = await fetch(`${app.url}/api/workspaces`, { headers: { cookie } })
    expect((await empty.json()) as { workspaces: unknown[] }).toMatchObject({ workspaces: [] })
  })

  it("initializes the workspace as its own git root", async () => {
    const worktrees = createFakeWorktreeManager()
    app = await startTestApp({ worktrees })
    const cookie = await login(app.url)

    const created = await fetch(`${app.url}/api/workspaces`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "app" }),
    })
    expect(created.status).toBe(201)
    const { workspace } = (await created.json()) as { workspace: { path: string } }
    // A nested workspace must not resolve opencode's project root to MasterHand.
    expect(worktrees.calls).toEqual([`ensure:${workspace.path}`])
  })

  it("trims the given name", async () => {
    app = await startTestApp()
    const cookie = await login(app.url)
    const response = await fetch(`${app.url}/api/workspaces`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "  Cool app  " }),
    })
    const body = (await response.json()) as { workspace: { name: string; path: string } }
    expect(body.workspace).toMatchObject({ name: "Cool app", path: "/tmp/masterhand-workspaces/Cool app" })
  })

  it("rejects invalid and duplicate names", async () => {
    app = await startTestApp()
    const cookie = await login(app.url)

    const invalid = await fetch(`${app.url}/api/workspaces`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "../etc" }),
    })
    expect(invalid.status).toBe(400)

    const payload = JSON.stringify({ name: "app" })
    const first = await fetch(`${app.url}/api/workspaces`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: payload,
    })
    expect(first.status).toBe(201)
    const duplicate = await fetch(`${app.url}/api/workspaces`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: payload,
    })
    expect(duplicate.status).toBe(409)
  })

  it("deletes the folder when deleteFiles is set", async () => {
    const removedPaths: string[] = []
    app = await startTestApp({ removeDir: (path) => removedPaths.push(path) })
    const cookie = await login(app.url)
    const created = await fetch(`${app.url}/api/workspaces`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "app" }),
    })
    const { workspace } = (await created.json()) as { workspace: { id: string; path: string } }

    const response = await fetch(`${app.url}/api/workspaces/${workspace.id}?deleteFiles=1`, {
      method: "DELETE",
      headers: { cookie },
    })
    expect(response.status).toBe(200)
    expect(removedPaths).toEqual([workspace.path])
  })

  it("refuses to delete files outside the root but still forgets the workspace", async () => {
    const removedPaths: string[] = []
    app = await startTestApp({ removeDir: (path) => removedPaths.push(path) })
    const cookie = await login(app.url)
    app.store.createWorkspace({ id: "legacy", name: "legacy", path: "/etc", createdAt: Date.now() })

    const refused = await fetch(`${app.url}/api/workspaces/legacy?deleteFiles=1`, {
      method: "DELETE",
      headers: { cookie },
    })
    expect(refused.status).toBe(403)
    expect(removedPaths).toEqual([])

    const forgotten = await fetch(`${app.url}/api/workspaces/legacy`, {
      method: "DELETE",
      headers: { cookie },
    })
    expect(forgotten.status).toBe(200)
  })

  it("returns 404 when removing an unknown workspace", async () => {
    app = await startTestApp()
    const cookie = await login(app.url)
    const response = await fetch(`${app.url}/api/workspaces/missing`, {
      method: "DELETE",
      headers: { cookie },
    })
    expect(response.status).toBe(404)
  })

  it("requires authentication", async () => {
    app = await startTestApp()
    const response = await fetch(`${app.url}/api/workspaces`)
    expect(response.status).toBe(401)
  })
})

describe("origin checks", () => {
  it("allows requests whose origin matches the request host", async () => {
    app = await startTestApp()
    const response = await fetch(`${app.url}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: app.url },
      body: JSON.stringify({ password: "secret" }),
    })
    expect(response.status).toBe(200)
  })

  it("rejects an unparseable allowlisted origin", async () => {
    app = await startTestApp({ config: { allowedOrigins: ["not a url"] } })
    const response = await fetch(`${app.url}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "not a url" },
      body: JSON.stringify({ password: "secret" }),
    })
    expect(response.status).toBe(403)
  })
})

describe("login rate limiting", () => {
  it("cannot be bypassed by rotating X-Forwarded-For", async () => {
    app = await startTestApp()

    const statuses: number[] = []
    for (let i = 0; i < 6; i++) {
      const response = await fetch(`${app.url}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `10.0.0.${i}` },
        body: JSON.stringify({ password: "wrong" }),
      })
      statuses.push(response.status)
    }

    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401])
    expect(statuses[5]).toBe(429)
  })
})
