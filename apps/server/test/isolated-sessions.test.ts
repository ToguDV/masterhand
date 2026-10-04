import { describe, expect, it, vi } from "vitest"
import { createFakeWorktreeManager, login, startMockOpencode, startTestApp, waitFor } from "./helpers.js"

interface MockSession {
  id: string
  directory: string
  parentID?: string
}

interface OpencodeCall {
  method: string
  path: string
  directory: string | null
  query: URLSearchParams
  body?: string
  parsedBody?: {
    location?: { directory?: string }
    value?: string
    permissions?: Array<{ action: string; resource: string; effect: string }>
  }
}

/** Minimal opencode v2 stand-in for the session endpoints the BFF calls. */
function createOpencodeMock(options: { pageSize?: number } = {}) {
  const sessions = new Map<string, MockSession[]>()
  const calls: OpencodeCall[] = []
  let counter = 0

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? "GET"
    const body = typeof init?.body === "string" ? init.body : undefined
    let parsedBody: OpencodeCall["parsedBody"]
    if (body) {
      try {
        parsedBody = JSON.parse(body) as OpencodeCall["parsedBody"]
      } catch {
        // non-JSON bodies are forwarded untouched
      }
    }
    const directory = url.searchParams.get("directory") ?? parsedBody?.location?.directory ?? null
    calls.push({ method, path: url.pathname, directory, query: url.searchParams, body, parsedBody })

    if (method === "GET" && url.pathname === "/api/session") {
      const list = sessions.get(directory ?? "") ?? []
      const limit = options.pageSize ?? Number(url.searchParams.get("limit") ?? "200")
      const offset = Number(url.searchParams.get("cursor") ?? "0")
      const page = list.slice(offset, offset + limit)
      const next = offset + limit < list.length ? String(offset + limit) : null
      return Response.json({ data: page, cursor: { previous: null, next } })
    }
    if (method === "POST" && url.pathname === "/api/session") {
      const session: MockSession = { id: `ses_${++counter}`, directory: directory ?? "" }
      const list = sessions.get(directory ?? "") ?? []
      list.push(session)
      sessions.set(directory ?? "", list)
      return Response.json({ data: session })
    }
    if (method === "PUT" && url.pathname.includes("/instructions/entries/")) {
      return new Response(null, { status: 204 })
    }
    if (method === "PATCH" && url.pathname.startsWith("/api/session/")) {
      return new Response(null, { status: 204 })
    }
    if (method === "DELETE" && url.pathname.startsWith("/api/session/")) {
      return new Response(null, { status: 204 })
    }
    return new Response("not found", { status: 404 })
  }) as typeof fetch

  return { fetchImpl, sessions, calls }
}

async function setupApp(
  mockOptions: { pageSize?: number } = {},
  appOptions: { sessionsCacheMs?: number } = {},
) {
  const opencode = createOpencodeMock(mockOptions)
  const worktrees = createFakeWorktreeManager()
  const app = await startTestApp({ worktrees, fetchImpl: opencode.fetchImpl, ...appOptions })
  const cookie = await login(app.url)
  const headers = { cookie, "content-type": "application/json" }

  const created = await fetch(`${app.url}/api/workspaces`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "app" }),
  })
  const { workspace } = (await created.json()) as { workspace: { id: string; path: string } }

  return { app, opencode, worktrees, headers, workspace }
}

describe("POST /api/workspaces/:id/sessions", () => {
  it("creates a standard session in the workspace folder", async () => {
    const { app, opencode, worktrees, headers, workspace } = await setupApp()
    try {
      const response = await fetch(`${app.url}/api/workspaces/${workspace.id}/sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      })
      expect(response.status).toBe(201)
      const body = (await response.json()) as {
        session: { id: string; isolation?: unknown }
        isolation: unknown
      }
      expect(body.session.isolation).toBeUndefined()
      expect(body.isolation).toBeNull()

      const creation = opencode.calls.find((call) => call.method === "POST" && call.path === "/api/session")
      expect(creation?.parsedBody).toEqual({ location: { directory: workspace.path } })
      expect(creation?.directory).toBe(workspace.path)
      expect(creation?.query.get("directory")).toBeNull()
      // The workspace is made its own git root so opencode resolves /init (and
      // the project root) to the workspace, never to an ancestor repo.
      expect(worktrees.calls).toContain(`ensure:${workspace.path}`)
      expect(worktrees.calls.some((call) => call.startsWith("create:"))).toBe(false)
      expect(app.store.getIsolatedSession(body.session.id)).toBeNull()

      const instruction = opencode.calls.find((call) =>
        call.path.endsWith("/instructions/entries/masterhand.workspace"),
      )
      expect(instruction?.method).toBe("PUT")
      expect(instruction?.parsedBody?.value).toContain(workspace.path)

      const guard = opencode.calls.find(
        (call) => call.method === "PATCH" && call.path === `/api/session/${body.session.id}`,
      )
      const permissions = guard?.parsedBody?.permissions as {
        action: string
        resource: string
        effect: string
      }[]
      expect(permissions).toEqual(
        expect.arrayContaining([
          { action: "external_directory", resource: "*", effect: "allow" },
          { action: "edit", resource: "/*", effect: "deny" },
          { action: "edit", resource: "?:/*", effect: "deny" },
          { action: "edit", resource: "../*", effect: "deny" },
          { action: "shell", resource: "pkill*", effect: "deny" },
          { action: "shell", resource: "kill $*", effect: "deny" },
        ]),
      )

      const processInstruction = opencode.calls.find((call) =>
        call.path.endsWith("/instructions/entries/masterhand.process"),
      )
      expect(processInstruction?.method).toBe("PUT")
      expect(processInstruction?.parsedBody?.value).toContain("never stop processes by name")
    } finally {
      await app.close()
    }
  })

  it("creates an isolated session in a new worktree", async () => {
    const { app, opencode, worktrees, headers, workspace } = await setupApp()
    try {
      const response = await fetch(`${app.url}/api/workspaces/${workspace.id}/sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ isolated: true }),
      })
      expect(response.status).toBe(201)
      const body = (await response.json()) as {
        session: { id: string; isolation: { branch: string; worktreePath: string; baseRef: string } }
      }
      const isolation = body.session.isolation
      expect(isolation.branch).toMatch(/^masterhand\/app-[a-z0-9]+$/)
      expect(isolation.baseRef).toBe("main")
      expect(worktrees.calls.some((call) => call.startsWith("create:"))).toBe(true)

      const record = app.store.getIsolatedSession(body.session.id)
      expect(record).toMatchObject({ workspaceID: workspace.id, branch: isolation.branch })

      const creation = opencode.calls.find((call) => call.method === "POST" && call.path === "/api/session")
      expect(creation?.parsedBody).toEqual({ location: { directory: isolation.worktreePath } })
      expect(creation?.directory).toBe(isolation.worktreePath)

      // The guard points at the worktree, the actual directory of this session.
      const instruction = opencode.calls.find((call) =>
        call.path.endsWith("/instructions/entries/masterhand.workspace"),
      )
      expect(instruction?.parsedBody?.value).toContain(isolation.worktreePath)
    } finally {
      await app.close()
    }
  })

  it("rolls the worktree back when opencode cannot create the session", async () => {
    const opencode = createOpencodeMock()
    const worktrees = createFakeWorktreeManager()
    const app = await startTestApp({
      worktrees,
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input))
        if ((init?.method ?? "GET") === "POST" && url.pathname === "/api/session") {
          return new Response("boom", { status: 500 })
        }
        return opencode.fetchImpl(input as string, init)
      }) as typeof fetch,
    })
    try {
      const cookie = await login(app.url)
      const headers = { cookie, "content-type": "application/json" }
      const created = await fetch(`${app.url}/api/workspaces`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "app" }),
      })
      const { workspace } = (await created.json()) as { workspace: { id: string } }

      const response = await fetch(`${app.url}/api/workspaces/${workspace.id}/sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ isolated: true }),
      })
      expect(response.status).toBe(500)
      expect(worktrees.calls.some((call) => call.startsWith("remove:"))).toBe(true)
      expect(app.store.listIsolatedSessions()).toHaveLength(0)
    } finally {
      await app.close()
    }
  })
})

describe("GET /api/workspaces/:id/sessions", () => {
  it("aggregates workspace and worktree sessions with isolation metadata", async () => {
    const { app, opencode, headers, workspace } = await setupApp()
    try {
      const standard = await fetch(`${app.url}/api/workspaces/${workspace.id}/sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      })
      const standardBody = (await standard.json()) as { session: { id: string } }
      const isolated = await fetch(`${app.url}/api/workspaces/${workspace.id}/sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ isolated: true }),
      })
      const isolatedBody = (await isolated.json()) as {
        session: { id: string; isolation: { worktreePath: string; branch: string } }
      }
      opencode.sessions.get(isolatedBody.session.isolation.worktreePath)?.push({
        id: "ses_child",
        directory: isolatedBody.session.isolation.worktreePath,
        parentID: isolatedBody.session.id,
      })

      const response = await fetch(`${app.url}/api/workspaces/${workspace.id}/sessions`, { headers })
      const body = (await response.json()) as {
        sessions: Array<{ id: string; isolation?: { branch: string } }>
      }
      const byID = new Map(body.sessions.map((session) => [session.id, session]))
      expect(byID.get(standardBody.session.id)?.isolation).toBeUndefined()
      expect(byID.get(isolatedBody.session.id)?.isolation?.branch).toBe(isolatedBody.session.isolation.branch)
      expect(byID.get("ses_child")?.isolation?.branch).toBe(isolatedBody.session.isolation.branch)
    } finally {
      await app.close()
    }
  })

  it("follows the v2 cursor pagination when listing sessions", async () => {
    const { app, opencode, headers, workspace } = await setupApp({ pageSize: 1 })
    try {
      opencode.sessions.set(workspace.path, [
        { id: "ses_a", directory: workspace.path },
        { id: "ses_b", directory: workspace.path },
      ])

      const response = await fetch(`${app.url}/api/workspaces/${workspace.id}/sessions`, { headers })
      const body = (await response.json()) as { sessions: Array<{ id: string }> }
      expect(body.sessions.map((session) => session.id).sort()).toEqual(["ses_a", "ses_b"])

      const lists = opencode.calls.filter((call) => call.method === "GET" && call.path === "/api/session")
      expect(lists).toHaveLength(2)
      expect(lists[0]?.query.get("limit")).toBe("200")
      expect(lists[0]?.query.get("cursor")).toBeNull()
      expect(lists[1]?.query.get("cursor")).toBe("1")
    } finally {
      await app.close()
    }
  })

  it("serves repeated listings from a short-lived per-directory cache", async () => {
    const { app, opencode, headers, workspace } = await setupApp()
    try {
      await fetch(`${app.url}/api/workspaces/${workspace.id}/sessions`, { headers })
      await fetch(`${app.url}/api/workspaces/${workspace.id}/sessions`, { headers })

      const lists = opencode.calls.filter((call) => call.method === "GET" && call.path === "/api/session")
      expect(lists).toHaveLength(1)
    } finally {
      await app.close()
    }
  })

  it("invalidates the aggregation cache when a session is created or deleted", async () => {
    const { app, opencode, headers, workspace } = await setupApp()
    try {
      const list = () => fetch(`${app.url}/api/workspaces/${workspace.id}/sessions`, { headers })
      await list()

      const created = await fetch(`${app.url}/api/workspaces/${workspace.id}/sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      })
      const { session } = (await created.json()) as { session: { id: string } }

      const afterCreate = await list()
      const body = (await afterCreate.json()) as { sessions: Array<{ id: string }> }
      expect(body.sessions.some((item) => item.id === session.id)).toBe(true)

      await fetch(`${app.url}/api/workspaces/${workspace.id}/sessions/${session.id}`, {
        method: "DELETE",
        headers,
      })
      await list()

      const lists = opencode.calls.filter((call) => call.method === "GET" && call.path === "/api/session")
      expect(lists).toHaveLength(3)
    } finally {
      await app.close()
    }
  })

  it("refetches after the per-directory cache TTL expires", async () => {
    const { app, opencode, headers, workspace } = await setupApp({}, { sessionsCacheMs: 20 })
    try {
      await fetch(`${app.url}/api/workspaces/${workspace.id}/sessions`, { headers })
      await new Promise((resolve) => setTimeout(resolve, 60))
      await fetch(`${app.url}/api/workspaces/${workspace.id}/sessions`, { headers })

      const lists = opencode.calls.filter((call) => call.method === "GET" && call.path === "/api/session")
      expect(lists).toHaveLength(2)
    } finally {
      await app.close()
    }
  })

  it("invalidates the cache when opencode reports a session event", async () => {
    const upstream = await startMockOpencode()
    const app = await startTestApp({ config: { opencodeUrl: upstream.url } })
    try {
      const cookie = await login(app.url)
      const headers = { cookie, "content-type": "application/json" }
      const created = await fetch(`${app.url}/api/workspaces`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "app" }),
      })
      const { workspace } = (await created.json()) as { workspace: { id: string } }

      const list = () => fetch(`${app.url}/api/workspaces/${workspace.id}/sessions`, { headers })
      const lists = () =>
        upstream.requests.filter((request) => request.method === "GET" && request.path === "/api/session")

      await waitFor(() => upstream.requests.some((request) => request.path === "/api/event"))
      await list()
      await list()
      expect(lists()).toHaveLength(1)

      let seen = false
      app.hub.subscribe((event) => {
        if ((event as { type?: string }).type === "session.created") seen = true
      })
      upstream.emit({ id: "evt_1", type: "session.created", data: { sessionID: "ses_x" } })
      await waitFor(() => seen)

      await list()
      expect(lists()).toHaveLength(2)
    } finally {
      await app.close()
      await upstream.close()
    }
  })

  it("returns 502 when opencode is unreachable", async () => {
    const app = await startTestApp({ fetchImpl: (async () => {
      throw new Error("offline")
    }) as typeof fetch })
    try {
      const cookie = await login(app.url)
      const response = await fetch(`${app.url}/api/workspaces/missing/sessions`, { headers: { cookie } })
      expect(response.status).toBe(404)

      const created = await fetch(`${app.url}/api/workspaces`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "app" }),
      })
      const { workspace } = (await created.json()) as { workspace: { id: string } }
      const failing = await fetch(`${app.url}/api/workspaces/${workspace.id}/sessions`, { headers: { cookie } })
      expect(failing.status).toBe(502)
    } finally {
      await app.close()
    }
  })
})

describe("GET /api/workspaces/:id/directories", () => {
  it("lists the workspace folder plus every worktree", async () => {
    const { app, headers, workspace } = await setupApp()
    try {
      await fetch(`${app.url}/api/workspaces/${workspace.id}/sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ isolated: true }),
      })
      const response = await fetch(`${app.url}/api/workspaces/${workspace.id}/directories`, { headers })
      const body = (await response.json()) as { directories: string[] }
      expect(body.directories[0]).toBe(workspace.path)
      expect(body.directories).toHaveLength(2)
    } finally {
      await app.close()
    }
  })
})

describe("DELETE /api/workspaces/:id/sessions/:sessionID", () => {
  it("removes an isolated session together with its worktree", async () => {
    const { app, opencode, worktrees, headers, workspace } = await setupApp()
    try {
      const created = await fetch(`${app.url}/api/workspaces/${workspace.id}/sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ isolated: true }),
      })
      const { session } = (await created.json()) as { session: { id: string; isolation: { worktreePath: string } } }

      const response = await fetch(`${app.url}/api/workspaces/${workspace.id}/sessions/${session.id}`, {
        method: "DELETE",
        headers,
      })
      expect(response.status).toBe(200)

      const deletion = opencode.calls.find((call) => call.method === "DELETE")
      expect(deletion?.path).toBe(`/api/session/${session.id}`)
      expect(deletion?.directory).toBeNull()
      expect(deletion?.query.get("directory")).toBeNull()
      expect(worktrees.calls.some((call) => call.startsWith("remove:"))).toBe(true)
      expect(app.store.getIsolatedSession(session.id)).toBeNull()
    } finally {
      await app.close()
    }
  })

  it("deletes a session without a directory query", async () => {
    const { app, opencode, headers, workspace } = await setupApp()
    try {
      const created = await fetch(`${app.url}/api/workspaces/${workspace.id}/sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      })
      const { session } = (await created.json()) as { session: { id: string } }

      const response = await fetch(
        `${app.url}/api/workspaces/${workspace.id}/sessions/${session.id}?directory=${encodeURIComponent("/etc")}`,
        { method: "DELETE", headers },
      )
      expect(response.status).toBe(200)
      const deletion = opencode.calls.find((call) => call.method === "DELETE")
      expect(deletion?.path).toBe(`/api/session/${session.id}`)
      expect(deletion?.query.get("directory")).toBeNull()
    } finally {
      await app.close()
    }
  })
})

describe("POST /api/isolated-sessions/:sessionID/finish", () => {
  it("commits locally when there is no remote", async () => {
    const { app, worktrees, headers, workspace } = await setupApp()
    try {
      const created = await fetch(`${app.url}/api/workspaces/${workspace.id}/sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ isolated: true }),
      })
      const { session } = (await created.json()) as { session: { id: string } }

      const response = await fetch(`${app.url}/api/isolated-sessions/${session.id}/finish`, {
        method: "POST",
        headers,
      })
      const body = (await response.json()) as {
        committed: boolean
        pushed: boolean
        prUrl: string | null
      }
      expect(body).toMatchObject({ committed: true, pushed: false, prUrl: null })
      expect(worktrees.calls.some((call) => call.startsWith("commit:"))).toBe(true)
      expect(app.store.getIsolatedSession(session.id)?.pushed).toBe(false)
    } finally {
      await app.close()
    }
  })

  it("pushes and reports the PR URL when a remote and CLI exist", async () => {
    const worktrees = createFakeWorktreeManager({
      hasRemote: () => true,
      remoteUrl: () => "git@github.com:org/repo.git",
      pullRequest: () => "https://github.com/org/repo/pull/1",
    })
    const opencode = createOpencodeMock()
    const app = await startTestApp({ worktrees, fetchImpl: opencode.fetchImpl })
    try {
      const cookie = await login(app.url)
      const headers = { cookie, "content-type": "application/json" }
      const created = await fetch(`${app.url}/api/workspaces`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "app" }),
      })
      const { workspace } = (await created.json()) as { workspace: { id: string } }
      const sessionResponse = await fetch(`${app.url}/api/workspaces/${workspace.id}/sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ isolated: true }),
      })
      const { session } = (await sessionResponse.json()) as { session: { id: string } }

      const response = await fetch(`${app.url}/api/isolated-sessions/${session.id}/finish`, {
        method: "POST",
        headers,
      })
      const body = (await response.json()) as { pushed: boolean; prUrl: string | null }
      expect(body.pushed).toBe(true)
      expect(body.prUrl).toBe("https://github.com/org/repo/pull/1")
      expect(worktrees.calls.some((call) => call.startsWith("push:"))).toBe(true)
      const record = app.store.getIsolatedSession(session.id)
      expect(record?.pushed).toBe(true)
      expect(record?.prUrl).toBe("https://github.com/org/repo/pull/1")
    } finally {
      await app.close()
    }
  })

  it("falls back to a compare URL without a provider CLI", async () => {
    const worktrees = createFakeWorktreeManager({
      hasRemote: () => true,
      remoteUrl: () => "git@github.com:org/repo.git",
    })
    const opencode = createOpencodeMock()
    const app = await startTestApp({ worktrees, fetchImpl: opencode.fetchImpl })
    try {
      const cookie = await login(app.url)
      const headers = { cookie, "content-type": "application/json" }
      const created = await fetch(`${app.url}/api/workspaces`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "app" }),
      })
      const { workspace } = (await created.json()) as { workspace: { id: string } }
      const sessionResponse = await fetch(`${app.url}/api/workspaces/${workspace.id}/sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ isolated: true }),
      })
      const { session } = (await sessionResponse.json()) as { session: { id: string } }

      const response = await fetch(`${app.url}/api/isolated-sessions/${session.id}/finish`, {
        method: "POST",
        headers,
      })
      const body = (await response.json()) as { prUrl: string | null }
      expect(body.prUrl).toMatch(/^https:\/\/github\.com\/org\/repo\/compare\/main\.\.\./)
    } finally {
      await app.close()
    }
  })

  it("reports a push failure and keeps the local commit", async () => {
    const worktrees = createFakeWorktreeManager({
      hasRemote: () => true,
      remoteUrl: () => "git@github.com:org/repo.git",
      push: vi.fn(() => {
        throw new Error("authentication failed")
      }),
    })
    const opencode = createOpencodeMock()
    const app = await startTestApp({ worktrees, fetchImpl: opencode.fetchImpl })
    try {
      const cookie = await login(app.url)
      const headers = { cookie, "content-type": "application/json" }
      const created = await fetch(`${app.url}/api/workspaces`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "app" }),
      })
      const { workspace } = (await created.json()) as { workspace: { id: string } }
      const sessionResponse = await fetch(`${app.url}/api/workspaces/${workspace.id}/sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ isolated: true }),
      })
      const { session } = (await sessionResponse.json()) as { session: { id: string } }

      const response = await fetch(`${app.url}/api/isolated-sessions/${session.id}/finish`, {
        method: "POST",
        headers,
      })
      const body = (await response.json()) as { committed: boolean; pushed: boolean; error: string | null }
      expect(body.committed).toBe(true)
      expect(body.pushed).toBe(false)
      expect(body.error).toContain("authentication failed")
    } finally {
      await app.close()
    }
  })

  it("returns 404 for a session without isolation", async () => {
    const { app, headers } = await setupApp()
    try {
      const response = await fetch(`${app.url}/api/isolated-sessions/unknown/finish`, {
        method: "POST",
        headers,
      })
      expect(response.status).toBe(404)
    } finally {
      await app.close()
    }
  })
})

describe("DELETE /api/workspaces/:id", () => {
  it("cleans up worktrees and records when the workspace goes away", async () => {
    const { app, worktrees, headers, workspace } = await setupApp()
    try {
      await fetch(`${app.url}/api/workspaces/${workspace.id}/sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ isolated: true }),
      })
      const response = await fetch(`${app.url}/api/workspaces/${workspace.id}`, {
        method: "DELETE",
        headers,
      })
      expect(response.status).toBe(200)
      expect(worktrees.calls.some((call) => call.startsWith("remove:"))).toBe(true)
      expect(app.store.listIsolatedSessions()).toHaveLength(0)
    } finally {
      await app.close()
    }
  })
})
