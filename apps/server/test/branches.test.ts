import { describe, expect, it } from "vitest"
import { createFakeWorktreeManager, login, startTestApp } from "./helpers.js"

/**
 * Minimal opencode stand-in for the branch routes: the busy guard lists the
 * workspace directory and checks it against the global active-session map.
 */
function createOpencodeStub() {
  const sessions: Array<{ id: string; directory: string }> = []
  const active = new Set<string>()
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    const method = init?.method ?? "GET"
    if (url.pathname === "/api/session" && method === "GET") {
      const directory = url.searchParams.get("directory")
      const data = sessions.filter((session) => !directory || session.directory === directory)
      return Response.json({ data, cursor: { next: null } })
    }
    if (url.pathname === "/api/session/active" && method === "GET") {
      const data = Object.fromEntries([...active].map((id) => [id, { type: "running" }]))
      return Response.json({ data })
    }
    return Response.json({ error: "not_found" }, { status: 404 })
  }
  return { fetchImpl, sessions, active }
}

async function startWorkspace(
  worktrees: ReturnType<typeof createFakeWorktreeManager>,
  stub: ReturnType<typeof createOpencodeStub>,
) {
  const app = await startTestApp({ worktrees, fetchImpl: stub.fetchImpl })
  const cookie = await login(app.url)
  const headers = { cookie, "content-type": "application/json" }
  const created = await fetch(`${app.url}/api/workspaces`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "app" }),
  })
  const { workspace } = (await created.json()) as { workspace: { id: string; path: string } }
  return { app, headers, workspace }
}

const BRANCHES = { current: "main", branches: ["main", "dev"] }

describe("/api/workspaces/:id/branches", () => {
  it("lists local branches for the workspace", async () => {
    const worktrees = createFakeWorktreeManager({ branches: async () => BRANCHES })
    const stub = createOpencodeStub()
    const { app, headers, workspace } = await startWorkspace(worktrees, stub)
    try {
      const response = await fetch(`${app.url}/api/workspaces/${workspace.id}/branches`, { headers })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(BRANCHES)
    } finally {
      await app.close()
    }
  })

  it("answers 404 for an unknown workspace and 502 when git fails", async () => {
    const worktrees = createFakeWorktreeManager({
      branches: async () => {
        throw new Error("fatal: not a git repository")
      },
    })
    const stub = createOpencodeStub()
    const { app, headers, workspace } = await startWorkspace(worktrees, stub)
    try {
      expect((await fetch(`${app.url}/api/workspaces/missing/branches`, { headers })).status).toBe(404)
      const failed = await fetch(`${app.url}/api/workspaces/${workspace.id}/branches`, { headers })
      expect(failed.status).toBe(502)
      expect(await failed.json()).toMatchObject({ error: "git_failed" })
    } finally {
      await app.close()
    }
  })

  it("creates and checks out a new branch, optionally from a base", async () => {
    const worktrees = createFakeWorktreeManager({
      branches: async () => ({ current: "main", branches: ["main", "dev"] }),
    })
    const stub = createOpencodeStub()
    const { app, headers, workspace } = await startWorkspace(worktrees, stub)
    try {
      const response = await fetch(`${app.url}/api/workspaces/${workspace.id}/branches`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "feature/x", base: "dev" }),
      })
      expect(response.status).toBe(201)
      expect(worktrees.calls).toContain(`create-branch:${workspace.path}:feature/x`)
      const body = (await response.json()) as { current: string }
      expect(body.current).toBe("main") // the fake keeps its static list
    } finally {
      await app.close()
    }
  })

  it("rejects invalid names, duplicates and unknown bases", async () => {
    const worktrees = createFakeWorktreeManager()
    const stub = createOpencodeStub()
    const { app, headers, workspace } = await startWorkspace(worktrees, stub)
    try {
      const post = (body: unknown) =>
        fetch(`${app.url}/api/workspaces/${workspace.id}/branches`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        })
      expect((await post({ name: "-bad" })).status).toBe(400)
      expect((await post({ name: "a..b" })).status).toBe(400)
      expect((await post({ name: "" })).status).toBe(400)
      expect((await post({ name: "feature/x", base: "nope..x" })).status).toBe(400)
      expect((await post({ name: "main" })).status).toBe(409)
      expect((await post({ name: "feature/x", base: "missing" })).status).toBe(404)
    } finally {
      await app.close()
    }
  })

  it("refuses to create while a session of the workspace is busy", async () => {
    const worktrees = createFakeWorktreeManager()
    const stub = createOpencodeStub()
    const { app, headers, workspace } = await startWorkspace(worktrees, stub)
    try {
      stub.sessions.push({ id: "ses_1", directory: workspace.path })
      stub.active.add("ses_1")
      const response = await fetch(`${app.url}/api/workspaces/${workspace.id}/branches`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "feature/x" }),
      })
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ error: "workspace_busy" })
      expect(worktrees.calls.some((call) => call.startsWith("create-branch:"))).toBe(false)
    } finally {
      await app.close()
    }
  })
})

describe("/api/workspaces/:id/checkout", () => {
  it("switches branches when the tree is clean and the branch exists", async () => {
    const worktrees = createFakeWorktreeManager({
      branches: async () => ({ current: "main", branches: ["main", "dev"] }),
    })
    const stub = createOpencodeStub()
    const { app, headers, workspace } = await startWorkspace(worktrees, stub)
    try {
      const response = await fetch(`${app.url}/api/workspaces/${workspace.id}/checkout`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "dev" }),
      })
      expect(response.status).toBe(200)
      expect(worktrees.calls).toContain(`checkout:${workspace.path}:dev`)
    } finally {
      await app.close()
    }
  })

  it("rejects a dirty working tree with a clear error", async () => {
    const worktrees = createFakeWorktreeManager({
      branches: async () => ({ current: "main", branches: ["main", "dev"] }),
      isDirty: async () => true,
    })
    const stub = createOpencodeStub()
    const { app, headers, workspace } = await startWorkspace(worktrees, stub)
    try {
      const response = await fetch(`${app.url}/api/workspaces/${workspace.id}/checkout`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "dev" }),
      })
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ error: "dirty_worktree" })
      expect(worktrees.calls.some((call) => call.startsWith("checkout:"))).toBe(false)
    } finally {
      await app.close()
    }
  })

  it("rejects unknown branches and busy workspaces", async () => {
    const worktrees = createFakeWorktreeManager({
      branches: async () => ({ current: "main", branches: ["main", "dev"] }),
    })
    const stub = createOpencodeStub()
    const { app, headers, workspace } = await startWorkspace(worktrees, stub)
    try {
      const post = (name: string) =>
        fetch(`${app.url}/api/workspaces/${workspace.id}/checkout`, {
          method: "POST",
          headers,
          body: JSON.stringify({ name }),
        })
      expect((await post("missing")).status).toBe(404)
      stub.sessions.push({ id: "ses_1", directory: workspace.path })
      stub.active.add("ses_1")
      expect((await post("dev")).status).toBe(409)
    } finally {
      await app.close()
    }
  })

  it("reports a timed-out checkout as a 504 so the client never auto-retries", async () => {
    const worktrees = createFakeWorktreeManager({
      branches: async () => ({ current: "main", branches: ["main", "dev"] }),
      checkout: async () => {
        throw new Error("git_checkout_failed: git timed out after 60000ms")
      },
    })
    const stub = createOpencodeStub()
    const { app, headers, workspace } = await startWorkspace(worktrees, stub)
    try {
      const response = await fetch(`${app.url}/api/workspaces/${workspace.id}/checkout`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "dev" }),
      })
      expect(response.status).toBe(504)
      expect(await response.json()).toMatchObject({ error: "git_timeout" })
    } finally {
      await app.close()
    }
  })
})
