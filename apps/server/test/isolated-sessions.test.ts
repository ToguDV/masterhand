import { describe, expect, it, vi } from "vitest"
import { createFakeWorktreeManager, login, startMockOpencode, startTestApp, waitFor } from "./helpers.js"
import { mapLimit } from "../src/app.js"
import { pullRequestUrl } from "../src/worktrees.js"
import type { RunManager } from "../src/runs.js"
import { createSqliteStore, type GoalRunRecord } from "../src/store.js"

/** Promise a test can resolve explicitly to hold a request mid-operation. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

interface MockSession {
  id: string
  directory: string
  parentID?: string
  metadata?: Record<string, unknown>
}

function goalRun(overrides: Partial<GoalRunRecord> = {}): GoalRunRecord {
  return {
    sessionID: "ses_main",
    runToken: "tok_1",
    goal: "g",
    state: "running",
    round: 1,
    maxRounds: 5,
    mainModel: null,
    criticModel: null,
    judgeModel: null,
    criticSessionID: null,
    judgeSessionID: null,
    lastReport: null,
    lastCritique: null,
    lastVerdict: null,
    history: [],
    error: null,
    awaitingKind: null,
    awaitingSessionID: null,
    awaitingAssistantID: null,
    attempt: 0,
    nudged: false,
    lastError: null,
    pausedPhase: null,
    promptSerial: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
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
  const ptys: Array<{ id: string; title: string; status: string; pid: number; command: string; args: string[]; cwd: string }> = []
  const active = new Set<string>()
  const calls: OpencodeCall[] = []
  /** Signal handed to every session-list fetch, so tests can assert abort wiring. */
  const listSignals: Array<AbortSignal | null | undefined> = []
  let counter = 0
  let ptyCounter = 0
  let nextCreateGate: Promise<void> | null = null
  let nextActiveGate: Promise<void> | null = null
  let nextListGate: Promise<void> | null = null

  /** Resolves when `signal` aborts, so a held request can release its handler. */
  function waitForAbort(signal?: AbortSignal | null): Promise<void> {
    if (!signal || signal.aborted) return Promise.resolve()
    return new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true })
    })
  }

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
      listSignals.push(init?.signal)
      if (nextListGate) {
        const gate = nextListGate
        nextListGate = null
        // A held list must also settle when its caller's budget aborts, so the
        // production abort path is observable without waiting for the gate.
        await Promise.race([gate, waitForAbort(init?.signal)])
      }
      if (init?.signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError")
      }
      const list = sessions.get(directory ?? "") ?? []
      const limit = options.pageSize ?? Number(url.searchParams.get("limit") ?? "200")
      const offset = Number(url.searchParams.get("cursor") ?? "0")
      const page = list.slice(offset, offset + limit)
      const next = offset + limit < list.length ? String(offset + limit) : null
      return Response.json({ data: page, cursor: { previous: null, next } })
    }
    if (method === "POST" && url.pathname === "/api/session") {
      if (nextCreateGate) {
        const gate = nextCreateGate
        nextCreateGate = null
        await gate
      }
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
    if (method === "GET" && url.pathname === "/api/session/active") {
      if (nextActiveGate) {
        const gate = nextActiveGate
        nextActiveGate = null
        await gate
      }
      return Response.json({
        data: Object.fromEntries([...active].map((id) => [id, { type: "running" }])),
      })
    }
    if (url.pathname === "/api/pty") {
      if (method === "GET") return Response.json({ data: ptys.filter((pty) => pty.status === "running") })
      if (method === "POST") {
        const pty = {
          id: `pty_mock_${++ptyCounter}`,
          pid: 5000 + ptyCounter,
          status: "running",
          title: "",
          command: "",
          args: [] as string[],
          cwd: "",
        }
        ptys.push(pty)
        return Response.json({ data: pty })
      }
    }
    if (method === "DELETE" && url.pathname.startsWith("/api/pty/")) {
      const ptyID = decodeURIComponent(url.pathname.slice("/api/pty/".length))
      const index = ptys.findIndex((pty) => pty.id === ptyID)
      if (index >= 0) ptys.splice(index, 1)
      return new Response(null, { status: 204 })
    }
    return new Response("not found", { status: 404 })
  }) as typeof fetch

  return {
    fetchImpl,
    sessions,
    ptys,
    calls,
    listSignals,
    holdNextCreate(gate: Promise<void>) {
      nextCreateGate = gate
    },
    holdNextActive(gate: Promise<void>) {
      nextActiveGate = gate
    },
    holdNextList(gate: Promise<void>) {
      nextListGate = gate
    },
    setActive(sessionIDs: string[]) {
      active.clear()
      for (const id of sessionIDs) active.add(id)
    },
  }
}

async function setupApp(
  mockOptions: { pageSize?: number } = {},
  appOptions: {
    sessionsCacheMs?: number
    workspaceDeleteBudgetMs?: number
    workspaceDeleteBackgroundMs?: number
  } = {},
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

  it("rejects a standard create whose workspace was deleted while opencode was creating it", async () => {
    const gate = deferred()
    const { app, opencode, worktrees, headers, workspace } = await setupApp()
    try {
      opencode.holdNextCreate(gate.promise)
      const creating = fetch(`${app.url}/api/workspaces/${workspace.id}/sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      })
      await waitFor(() =>
        opencode.calls.some((call) => call.method === "POST" && call.path === "/api/session"),
      )

      // The create passed the route's workspace lookup and is inside the
      // upstream call; the delete removes the row before it returns.
      const deletion = await fetch(`${app.url}/api/workspaces/${workspace.id}`, {
        method: "DELETE",
        headers,
      })
      expect(deletion.status).toBe(200)

      gate.resolve()
      const response = await creating
      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({ error: "workspace_busy" })
      // A standard session has no isolation record to reconcile later: the
      // upstream session must not survive the removed folder.
      expect(
        opencode.calls.some(
          (call) => call.method === "DELETE" && call.path === `/api/session/ses_1`,
        ),
      ).toBe(true)
      expect(worktrees.calls.some((call) => call.startsWith("create:"))).toBe(false)
    } finally {
      gate.resolve()
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

  it("answers 503 and keeps the worktree when persisting the isolation record fails", async () => {
    const opencode = createOpencodeMock()
    const worktrees = createFakeWorktreeManager()
    const store = {
      ...createSqliteStore(":memory:"),
      createIsolatedSession: () => {
        throw Object.assign(new Error("disk full"), { code: "SQLITE_FULL" })
      },
    }
    const app = await startTestApp({ worktrees, fetchImpl: opencode.fetchImpl, store })
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {})
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
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error: "storage_unavailable" })

      // The session and its worktree are healthy: a storage failure while
      // persisting the record must never roll them back.
      expect(worktrees.calls.some((call) => call.startsWith("create:"))).toBe(true)
      expect(worktrees.calls.some((call) => call.startsWith("remove:"))).toBe(false)
      expect(opencode.calls.some((call) => call.method === "DELETE")).toBe(false)
    } finally {
      errorLog.mockRestore()
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

  it("annotates Goal Mode's internal sessions so clients hide them from the list", async () => {
    const { app, opencode, headers, workspace } = await setupApp()
    try {
      opencode.sessions.set(workspace.path, [
        { id: "ses_main", directory: workspace.path },
        // The pinned opencode drops `parentID`: the stable role marker is the
        // source of truth for sessions created after this change…
        { id: "ses_critic", directory: workspace.path, metadata: { "masterhand.goal.internal": "critic" } },
        // …and the legacy reconciliation marker for sessions created before it.
        {
          id: "ses_judge",
          directory: workspace.path,
          metadata: { "masterhand.goal.role": "judge_abcdef123456_1_1" },
        },
        { id: "ses_plain", directory: workspace.path },
      ])
      // The run store covers sessions whose metadata never made it upstream.
      app.store.saveGoalRun(goalRun({ sessionID: "ses_main", judgeSessionID: "ses_store_judge" }))
      opencode.sessions.get(workspace.path)!.push({ id: "ses_store_judge", directory: workspace.path })

      const response = await fetch(`${app.url}/api/workspaces/${workspace.id}/sessions`, { headers })
      const body = (await response.json()) as {
        sessions: Array<{ id: string; goalRole?: string; parentID?: string }>
      }
      const byID = new Map(body.sessions.map((session) => [session.id, session]))
      expect(byID.get("ses_critic")?.goalRole).toBe("critic")
      expect(byID.get("ses_judge")?.goalRole).toBe("judge")
      expect(byID.get("ses_store_judge")?.goalRole).toBe("judge")
      expect(byID.get("ses_plain")?.goalRole).toBeUndefined()
      expect(byID.get("ses_main")?.goalRole).toBeUndefined()
      // The pinned opencode drops `parentID`: the run store supplies the link
      // back to the main session so clients can return to it.
      expect(byID.get("ses_store_judge")?.parentID).toBe("ses_main")
      expect(byID.get("ses_main")?.parentID).toBeUndefined()
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

  it("pages the aggregated list with limit/cursor and keeps the default shape", async () => {
    const { app, opencode, headers, workspace } = await setupApp()
    try {
      opencode.sessions.set(workspace.path, [
        { id: "ses_a", directory: workspace.path },
        { id: "ses_b", directory: workspace.path },
        { id: "ses_c", directory: workspace.path },
      ])

      const defaultResponse = await fetch(`${app.url}/api/workspaces/${workspace.id}/sessions`, { headers })
      const defaultBody = (await defaultResponse.json()) as Record<string, unknown>
      expect(Object.keys(defaultBody)).toEqual(["sessions"])

      const first = await fetch(`${app.url}/api/workspaces/${workspace.id}/sessions?limit=2`, { headers })
      const firstBody = (await first.json()) as {
        sessions: Array<{ id: string }>
        truncated?: boolean
        nextCursor?: string
      }
      expect(firstBody.sessions.map((session) => session.id)).toEqual(["ses_a", "ses_b"])
      expect(firstBody.truncated).toBe(true)
      expect(firstBody.nextCursor).toBe("2")

      const second = await fetch(
        `${app.url}/api/workspaces/${workspace.id}/sessions?limit=2&cursor=2`,
        { headers },
      )
      const secondBody = (await second.json()) as {
        sessions: Array<{ id: string }>
        truncated?: boolean
        nextCursor?: string
      }
      expect(secondBody.sessions.map((session) => session.id)).toEqual(["ses_c"])
      expect(secondBody.truncated).toBeUndefined()
      expect(secondBody.nextCursor).toBeUndefined()
    } finally {
      await app.close()
    }
  })

  it("coalesces concurrent misses into one upstream fetch per directory", async () => {
    const { app, opencode, headers, workspace } = await setupApp()
    try {
      opencode.sessions.set(workspace.path, [{ id: "ses_a", directory: workspace.path }])
      // Hold the first upstream list so the other four route handlers arrive
      // while it is still in flight: without per-directory coalescing each
      // misses the (not yet filled) cache and fetches on its own.
      let release!: () => void
      opencode.holdNextList(new Promise<void>((resolve) => (release = resolve)))
      const list = () => fetch(`${app.url}/api/workspaces/${workspace.id}/sessions`, { headers })
      const pending = Promise.all([list(), list(), list(), list(), list()])
      await new Promise((resolve) => setTimeout(resolve, 100))
      release()
      const bodies = await pending
      for (const response of bodies) expect(response.status).toBe(200)

      const lists = opencode.calls.filter((call) => call.method === "GET" && call.path === "/api/session")
      expect(lists).toHaveLength(1)
    } finally {
      await app.close()
    }
  })

  it("fans out across directories with a bounded pool", async () => {
    // Ten slow directories through a pool of three: the peak in-flight count
    // never exceeds the bound, results keep input order, and a rejection
    // propagates (the route maps the base failure to 502 — unlike eachLimit's
    // log-and-continue releases).
    let inflight = 0
    let peak = 0
    const results = await mapLimit(Array.from({ length: 10 }, (_, index) => index), 3, async (index) => {
      inflight += 1
      peak = Math.max(peak, inflight)
      await new Promise((resolve) => setTimeout(resolve, 10))
      inflight -= 1
      return index * 2
    })
    expect(results).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18])
    expect(peak).toBeLessThanOrEqual(3)
    await expect(
      mapLimit([1, 2, 3], 2, async (index) => {
        if (index === 2) throw new Error("base unreachable")
        return index
      }),
    ).rejects.toThrow("base unreachable")
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

  it("waits for an in-flight finish before removing the worktree", async () => {
    const gate = deferred()
    let commits = 0
    const worktrees = createFakeWorktreeManager({
      remoteUrl: async () => "git@github.com:org/repo.git",
      commitAll: vi.fn(async () => {
        commits += 1
        await gate.promise
        return true
      }),
      push: async () => {},
      pullRequest: async () => "https://github.com/org/repo/pull/11",
    })
    const removeStarted = deferred()
    const originalRemove = worktrees.remove
    worktrees.remove = async (repo, path, branch) => {
      removeStarted.resolve()
      await originalRemove(repo, path, branch)
    }
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

      const finish = fetch(`${app.url}/api/isolated-sessions/${session.id}/finish`, {
        method: "POST",
        headers,
      })
      await waitFor(() => commits === 1)

      const deletion = fetch(`${app.url}/api/workspaces/${workspace.id}/sessions/${session.id}`, {
        method: "DELETE",
        headers,
      })
      // The DELETE reaches opencode before releaseSession; if the worktree is
      // removed in the same tick the branch disappears between commit and push.
      await waitFor(() => opencode.calls.some((call) => call.method === "DELETE"))
      const early = await Promise.race([
        removeStarted.promise.then(() => "removed" as const),
        new Promise<"waiting">((resolve) => setImmediate(() => resolve("waiting"))),
      ])
      expect(early).toBe("waiting")

      gate.resolve()
      const [finishResponse, deletionResponse] = await Promise.all([finish, deletion])
      expect(finishResponse.status).toBe(200)
      expect(deletionResponse.status).toBe(200)
      expect(
        worktrees.calls.findIndex((call) => call.startsWith("commit:")),
      ).toBeLessThan(worktrees.calls.findIndex((call) => call.startsWith("remove:")))
      expect(app.store.getIsolatedSession(session.id)).toBeNull()
    } finally {
      gate.resolve()
      await app.close()
    }
  })

  it("waits for an in-flight finish when opencode reports the session deleted", async () => {
    const gate = deferred()
    let commits = 0
    const worktrees = createFakeWorktreeManager({
      remoteUrl: async () => "git@github.com:org/repo.git",
      commitAll: vi.fn(async () => {
        commits += 1
        await gate.promise
        return true
      }),
      push: async () => {},
      pullRequest: async () => "https://github.com/org/repo/pull/12",
    })
    const removeStarted = deferred()
    const originalRemove = worktrees.remove
    worktrees.remove = async (repo, path, branch) => {
      removeStarted.resolve()
      await originalRemove(repo, path, branch)
    }
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

      const finish = fetch(`${app.url}/api/isolated-sessions/${session.id}/finish`, {
        method: "POST",
        headers,
      })
      await waitFor(() => commits === 1)

      app.hub.emit({ type: "session.deleted", data: { sessionID: session.id } })
      const early = await Promise.race([
        removeStarted.promise.then(() => "removed" as const),
        new Promise<"waiting">((resolve) => setImmediate(() => resolve("waiting"))),
      ])
      expect(early).toBe("waiting")

      gate.resolve()
      expect((await finish).status).toBe(200)
      await waitFor(() => app.store.getIsolatedSession(session.id) === null)
      expect(
        worktrees.calls.findIndex((call) => call.startsWith("commit:")),
      ).toBeLessThan(worktrees.calls.findIndex((call) => call.startsWith("remove:")))
    } finally {
      gate.resolve()
      await app.close()
    }
  })

  it("refuses a finish that starts after the session release began", async () => {
    const removeStarted = deferred()
    const removeGate = deferred()
    const commitAll = vi.fn(async () => true)
    const push = vi.fn(async () => {})
    const worktrees = createFakeWorktreeManager({
      remoteUrl: async () => "git@github.com:org/repo.git",
      commitAll,
      push,
      pullRequest: async () => "https://github.com/org/repo/pull/13",
    })
    const originalRemove = worktrees.remove
    worktrees.remove = async (repo, path, branch) => {
      removeStarted.resolve()
      await removeGate.promise
      await originalRemove(repo, path, branch)
    }
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

      const deletion = fetch(`${app.url}/api/workspaces/${workspace.id}/sessions/${session.id}`, {
        method: "DELETE",
        headers,
      })
      // The release already sampled the finish map and is removing the
      // worktree: a finish registered from here on would commit/push into the
      // branch being deleted under it.
      await removeStarted.promise

      const finish = await fetch(`${app.url}/api/isolated-sessions/${session.id}/finish`, {
        method: "POST",
        headers,
      })
      // The release is in flight, so the session is being removed: a finish
      // cannot be answered as "busy but retryable" (there is nothing to retry).
      expect(finish.status).toBe(404)
      expect(await finish.json()).toEqual({ error: "not_found" })
      expect(commitAll).not.toHaveBeenCalled()
      expect(push).not.toHaveBeenCalled()
      expect(worktrees.calls.some((call) => call.startsWith("commit:"))).toBe(false)

      removeGate.resolve()
      expect((await deletion).status).toBe(200)
      expect(app.store.getIsolatedSession(session.id)).toBeNull()
    } finally {
      removeGate.resolve()
      await app.close()
    }
  })

  it("coalesces overlapping releases so a finish cannot start while the first removes the worktree", async () => {
    const removeStarted = deferred()
    const removeGate = deferred()
    let removals = 0
    const commitAll = vi.fn(async () => true)
    const push = vi.fn(async () => {})
    const worktrees = createFakeWorktreeManager({
      remoteUrl: async () => "git@github.com:org/repo.git",
      commitAll,
      push,
      pullRequest: async () => "https://github.com/org/repo/pull/14",
    })
    const originalRemove = worktrees.remove
    worktrees.remove = async (repo, path, branch) => {
      removals += 1
      removeStarted.resolve()
      await removeGate.promise
      await originalRemove(repo, path, branch)
    }
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

      // First release: the route DELETE. Its worktree removal is held so the
      // release marker is observably still active.
      const deletion = fetch(`${app.url}/api/workspaces/${workspace.id}/sessions/${session.id}`, {
        method: "DELETE",
        headers,
      })
      await removeStarted.promise

      // Second release: opencode reports the same session deleted. It must join
      // the first release instead of clearing its marker while the worktree is
      // still being removed, which would let a finish start.
      app.hub.emit({ type: "session.deleted", data: { sessionID: session.id } })

      const finish = await fetch(`${app.url}/api/isolated-sessions/${session.id}/finish`, {
        method: "POST",
        headers,
      })
      expect(finish.status).toBe(404)
      expect(await finish.json()).toEqual({ error: "not_found" })
      expect(commitAll).not.toHaveBeenCalled()
      expect(push).not.toHaveBeenCalled()

      removeGate.resolve()
      expect((await deletion).status).toBe(200)
      expect(removals).toBe(1)
      expect(app.store.getIsolatedSession(session.id)).toBeNull()
    } finally {
      removeGate.resolve()
      await app.close()
    }
  })

  it("stops the run when a later release supplies the directory", async () => {
    const gate = deferred()
    const entered = deferred()
    const stop = vi.fn(async (_sessionID: string, _directory: string) => {})
    const runs: RunManager = {
      status: async () => ({ status: "stopped", command: null, args: [], port: null, pid: null, error: null }),
      start: async () => ({ status: "stopped", command: null, args: [], port: null, pid: null, error: null }),
      stop,
      forget: vi.fn(),
    }
    const opencode = createOpencodeMock()
    const app = await startTestApp({ runs, fetchImpl: opencode.fetchImpl })
    try {
      const cookie = await login(app.url)
      const headers = { cookie, "content-type": "application/json" }
      const created = await fetch(`${app.url}/api/workspaces`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "app" }),
      })
      const { workspace } = (await created.json()) as { workspace: { id: string; path: string } }
      // A base-folder session has no isolation record, so the out-of-band event
      // cannot know its directory: only the later route release can supply it.
      const sessionResponse = await fetch(`${app.url}/api/workspaces/${workspace.id}/sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      })
      const { session } = (await sessionResponse.json()) as { session: { id: string } }

      const forget = app.preview.forget
      app.preview.forget = vi.fn(async () => {
        entered.resolve()
        await gate.promise
      })

      // First release: the opencode event, with no directory.
      app.hub.emit({ type: "session.deleted", data: { sessionID: session.id } })
      await entered.promise

      // Second release: the route, which knows the workspace path and joins the
      // in-flight entry. The shared cleanup must still stop that run.
      const deletion = fetch(`${app.url}/api/workspaces/${workspace.id}/sessions/${session.id}`, {
        method: "DELETE",
        headers,
      })
      await waitFor(() =>
        opencode.calls.some((call) => call.method === "DELETE" && call.path === `/api/session/${session.id}`),
      )
      // Let the route reach `releaseSession` and join the parked entry.
      await new Promise((resolve) => setImmediate(resolve))
      gate.resolve()
      expect((await deletion).status).toBe(200)
      const stopped = stop.mock.calls.some(
        ([sessionID, directory]) => sessionID === session.id && directory === workspace.path,
      )
      expect(stopped).toBe(true)
      app.preview.forget = forget
    } finally {
      gate.resolve()
      await app.close()
    }
  })

  it("keeps the isolated record and answers 503 when dropping it fails", async () => {
    const { app, worktrees, headers, workspace } = await setupApp()
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const created = await fetch(`${app.url}/api/workspaces/${workspace.id}/sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ isolated: true }),
      })
      const { session } = (await created.json()) as { session: { id: string } }
      const dropRecord = app.store.removeIsolatedSession.bind(app.store)
      app.store.removeIsolatedSession = () => {
        throw Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" })
      }

      // The upstream session is already gone, but the record row (and the
      // reserved port) survive a failed cleanup: answering 200 would leave no
      // retry path, so the storage failure is rethrown to app.onError (503).
      const response = await fetch(`${app.url}/api/workspaces/${workspace.id}/sessions/${session.id}`, {
        method: "DELETE",
        headers,
      })
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error: "storage_unavailable" })
      expect(worktrees.calls.some((call) => call.startsWith("remove:"))).toBe(true)
      expect(app.store.getIsolatedSession(session.id)).not.toBeNull()

      // A retry (nothing upstream left to delete) drops the surviving row.
      app.store.removeIsolatedSession = dropRecord
      const retry = await fetch(`${app.url}/api/workspaces/${workspace.id}/sessions/${session.id}`, {
        method: "DELETE",
        headers,
      })
      expect(retry.status).toBe(200)
      expect(await retry.json()).toEqual({ ok: true })
      expect(app.store.getIsolatedSession(session.id)).toBeNull()
    } finally {
      errorLog.mockRestore()
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
      remoteUrl: async () => "git@github.com:org/repo.git",
      pullRequest: async () => "https://github.com/org/repo/pull/1",
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

  it("falls back to a compare URL without a provider CLI but never persists it", async () => {
    const worktrees = createFakeWorktreeManager({
      remoteUrl: async () => "git@github.com:org/repo.git",
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
      // The compare URL is a response-only convenience: it is not proof that a
      // pull request exists, so it must never win over a later real lookup.
      expect(app.store.getIsolatedSession(session.id)?.prUrl).toBeNull()
    } finally {
      await app.close()
    }
  })

  it("replaces a legacy persisted compare URL with the real PR", async () => {
    const worktrees = createFakeWorktreeManager({
      remoteUrl: async () => "git@github.com:org/repo.git",
      pullRequest: async () => "https://github.com/org/repo/pull/12",
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

      const record = app.store.getIsolatedSession(session.id)!
      const legacy = pullRequestUrl("git@github.com:org/repo.git", record.branch, record.baseRef)!
      app.store.updateIsolatedSession(session.id, { prUrl: legacy })

      const response = await fetch(`${app.url}/api/isolated-sessions/${session.id}/finish`, {
        method: "POST",
        headers,
      })
      const body = (await response.json()) as { prUrl: string | null }
      expect(body.prUrl).toBe("https://github.com/org/repo/pull/12")
      expect(app.store.getIsolatedSession(session.id)?.prUrl).toBe("https://github.com/org/repo/pull/12")
    } finally {
      await app.close()
    }
  })

  it("coalesces concurrent finishes into one commit, push and PR", async () => {
    const gate = deferred()
    let commits = 0
    const commitAll = vi.fn(async () => {
      commits += 1
      await gate.promise
      return true
    })
    const push = vi.fn(async () => {})
    const pullRequest = vi.fn(async () => "https://github.com/org/repo/pull/5")
    const worktrees = createFakeWorktreeManager({
      remoteUrl: async () => "git@github.com:org/repo.git",
      commitAll,
      push,
      pullRequest,
    })
    const opencode = createOpencodeMock()
    let finishRequests = 0
    const secondRequestArrived = deferred()
    const app = await startTestApp({
      worktrees,
      fetchImpl: opencode.fetchImpl,
      onRequest: (request) => {
        if (request.method === "POST" && new URL(request.url).pathname.endsWith("/finish")) {
          finishRequests += 1
          if (finishRequests === 2) secondRequestArrived.resolve()
        }
      },
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
      const sessionResponse = await fetch(`${app.url}/api/workspaces/${workspace.id}/sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ isolated: true }),
      })
      const { session } = (await sessionResponse.json()) as { session: { id: string } }

      const finish = () =>
        fetch(`${app.url}/api/isolated-sessions/${session.id}/finish`, { method: "POST", headers })
      const first = finish()
      await waitFor(() => commits === 1)
      const second = finish()
      // The second request is received while the first commit is held, so it
      // must coalesce with it. One event-loop turn lets the BFF route it before
      // the gate opens (never a wall-clock guess: under load a fixed delay can
      // release the first finish before the second request even arrives, which
      // would make this test fail for the wrong reason).
      await secondRequestArrived.promise
      await new Promise((resolve) => setImmediate(resolve))
      gate.resolve()

      const [firstResponse, secondResponse] = await Promise.all([first, second])
      const bodies = (await Promise.all([firstResponse.json(), secondResponse.json()])) as Array<{
        prUrl: string | null
      }>
      expect(firstResponse.status).toBe(200)
      expect(secondResponse.status).toBe(200)
      expect(bodies[0]?.prUrl).toBe("https://github.com/org/repo/pull/5")
      expect(bodies[1]?.prUrl).toBe("https://github.com/org/repo/pull/5")
      expect(commitAll).toHaveBeenCalledTimes(1)
      expect(push).toHaveBeenCalledTimes(1)
      expect(pullRequest).toHaveBeenCalledTimes(1)
      expect(app.store.getIsolatedSession(session.id)?.prUrl).toBe("https://github.com/org/repo/pull/5")
    } finally {
      gate.resolve()
      await app.close()
    }
  })

  it("reports a push failure and keeps the local commit", async () => {
    const worktrees = createFakeWorktreeManager({
      remoteUrl: async () => "git@github.com:org/repo.git",
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

  it("answers ambiguous 504 when the finish budget expires instead of hanging (issue #204)", async () => {
    const pushGate = deferred()
    const push = vi.fn(async () => {
      await pushGate.promise
    })
    const worktrees = createFakeWorktreeManager({
      remoteUrl: async () => "git@github.com:org/repo.git",
      push,
      pullRequest: async () => null,
    })
    const opencode = createOpencodeMock()
    const app = await startTestApp({ worktrees, fetchImpl: opencode.fetchImpl, finishBudgetMs: 200 })
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

      // The push stays held past the budget; the gate opens later so the
      // background operation can still land for the record reconciliation.
      setTimeout(() => pushGate.resolve(), 1000)
      const response = await fetch(`${app.url}/api/isolated-sessions/${session.id}/finish`, {
        method: "POST",
        headers,
      })
      // Ambiguous, never a hard failure: the push may still have applied.
      expect(response.status).toBe(504)
      expect(await response.json()).toEqual({ error: "finish_timeout" })
      // No auto-retry: the push ran exactly once, and the record still
      // reconciles once the background operation settles.
      await waitFor(() => app.store.getIsolatedSession(session.id)?.pushed === true)
      expect(push).toHaveBeenCalledTimes(1)
    } finally {
      pushGate.resolve()
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
  it("fails the active-session guard closed when the delete budget expires before any mutation (issue #225)", async () => {
    const { app, opencode, worktrees, headers, workspace } = await setupApp(
      {},
      { workspaceDeleteBudgetMs: 100 },
    )
    const gate = deferred()
    opencode.holdNextList(gate.promise)
    // A guard refusal must also resume the schedules this request paused.
    app.store.createScheduledTask({
      id: "task_guard",
      name: "Guard",
      prompt: "check",
      model: { providerID: "test", id: "test-model" },
      schedule: { kind: "interval", intervalMinutes: 60 },
      timezone: "",
      directory: workspace.path,
      paused: false,
      lastRunAt: null,
      nextRunAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(),
    })
    // A slow upstream must not hold the route past its budget. The fallback
    // keeps the pre-fix run terminating (it would otherwise wait forever).
    const fallback = setTimeout(() => gate.resolve(), 400)
    try {
      const response = await fetch(`${app.url}/api/workspaces/${workspace.id}?deleteFiles=1`, {
        method: "DELETE",
        headers,
      })
      expect(response.status).toBe(502)
      expect(await response.json()).toMatchObject({ error: "busy_check_failed" })
      // The guard failed closed: nothing was removed, so a retry is safe.
      expect(app.store.getWorkspace(workspace.id)).not.toBeNull()
      expect(worktrees.calls.some((call) => call.startsWith("remove:"))).toBe(false)
      expect(app.store.getScheduledTask("task_guard")?.paused).toBe(false)
    } finally {
      clearTimeout(fallback)
      gate.resolve()
      await app.close()
    }
  })

  it("aborts the base-folder listing at the cleanup cap and stops pagination (issue #225)", async () => {
    const { app, opencode, headers, workspace } = await setupApp(
      { pageSize: 1 },
      { workspaceDeleteBudgetMs: 100, workspaceDeleteBackgroundMs: 1000 },
    )
    opencode.sessions.set(workspace.path, [
      { id: "ses_a", directory: workspace.path },
      { id: "ses_b", directory: workspace.path },
    ])
    const gate = deferred()
    opencode.holdNextList(gate.promise)
    try {
      const response = await fetch(`${app.url}/api/workspaces/${workspace.id}`, {
        method: "DELETE",
        headers,
      })
      expect(response.status).toBe(504)
      expect(await response.json()).toEqual({ error: "delete_timeout" })
      // The base listing belongs to the detached cleanup, not to the response
      // deadline: a 504 must still release base sessions. Its own cap bounds
      // it and aborts the fetch.
      expect(opencode.listSignals[0]?.aborted).toBe(false)
      await waitFor(() => opencode.listSignals[0]?.aborted === true, 2000)
      gate.resolve()
      await new Promise((resolve) => setTimeout(resolve, 100))
      const lists = opencode.calls.filter((call) => call.method === "GET" && call.path === "/api/session")
      expect(lists).toHaveLength(1)
    } finally {
      gate.resolve()
      await app.close()
    }
  })

  it("stops starting new releases at the cleanup cap and keeps the remaining record (issue #225)", async () => {
    const removeGate = deferred()
    const started: string[] = []
    const finished: string[] = []
    const worktrees = createFakeWorktreeManager({
      remove: async (_repo, _path, branch) => {
        started.push(branch)
        await removeGate.promise
        finished.push(branch)
      },
    })
    const opencode = createOpencodeMock()
    const app = await startTestApp({
      worktrees,
      fetchImpl: opencode.fetchImpl,
      workspaceDeleteBudgetMs: 600,
      workspaceDeleteBackgroundMs: 100,
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
      const sessionIDs: string[] = []
      for (let i = 0; i < 5; i += 1) {
        const sessionResponse = await fetch(`${app.url}/api/workspaces/${workspace.id}/sessions`, {
          method: "POST",
          headers,
          body: JSON.stringify({ isolated: true }),
        })
        const { session } = (await sessionResponse.json()) as { session: { id: string } }
        sessionIDs.push(session.id)
      }
      const forgetPreview = vi.spyOn(app.preview, "forget")

      const deletion = fetch(`${app.url}/api/workspaces/${workspace.id}`, {
        method: "DELETE",
        headers,
      })
      await waitFor(() => started.length === 4, 5000)
      const response = await deletion
      expect(response.status).toBe(504)
      removeGate.resolve()
      await waitFor(() => finished.length === 4)
      // The skipped release keeps its isolated record (and worktree) rather
      // than dropping the record and leaving an untracked worktree behind,
      // but its lifecycles still release: no preview tunnel or PTY survives.
      expect(started).toHaveLength(4)
      expect(app.store.listIsolatedSessions()).toHaveLength(1)
      await waitFor(
        () => forgetPreview.mock.calls.filter(([id]) => sessionIDs.includes(id)).length === 5,
        2000,
      )
    } finally {
      removeGate.resolve()
      await app.close()
    }
  })

  it("releases base sessions when an isolated release outlives the response budget (issue #225)", async () => {
    const removeGate = deferred()
    const worktrees = createFakeWorktreeManager({
      remove: async () => {
        await removeGate.promise
      },
    })
    const opencode = createOpencodeMock()
    const app = await startTestApp({
      worktrees,
      fetchImpl: opencode.fetchImpl,
      workspaceDeleteBudgetMs: 100,
      workspaceDeleteBackgroundMs: 5000,
    })
    try {
      const cookie = await login(app.url)
      const headers = { cookie, "content-type": "application/json" }
      const created = await fetch(`${app.url}/api/workspaces`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "app" }),
      })
      const { workspace } = (await created.json()) as { workspace: { id: string; path: string } }
      await fetch(`${app.url}/api/workspaces/${workspace.id}/sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ isolated: true }),
      })
      // A base-folder session owns a preview/PTY lifecycle too: the base
      // listing must not be starved by an isolated release that outlives the
      // response deadline (it used to start after it with an aborted signal).
      opencode.sessions.set(workspace.path, [{ id: "ses_base", directory: workspace.path }])
      const forgetPreview = vi.spyOn(app.preview, "forget")

      const response = await fetch(`${app.url}/api/workspaces/${workspace.id}`, {
        method: "DELETE",
        headers,
      })
      expect(response.status).toBe(504)
      await waitFor(() => forgetPreview.mock.calls.some(([id]) => id === "ses_base"), 2000)
    } finally {
      removeGate.resolve()
      await app.close()
    }
  })

  it("keeps releasing worktrees that start after the response budget (issue #225)", async () => {
    const removeGate = deferred()
    const started: string[] = []
    const finished: string[] = []
    const abortedAtStart: boolean[] = []
    const worktrees = createFakeWorktreeManager({
      remove: async (_repo, _path, branch, options) => {
        started.push(branch)
        abortedAtStart.push(options?.signal?.aborted ?? false)
        await removeGate.promise
        finished.push(branch)
      },
    })
    const opencode = createOpencodeMock()
    const app = await startTestApp({ worktrees, fetchImpl: opencode.fetchImpl, workspaceDeleteBudgetMs: 200 })
    try {
      const cookie = await login(app.url)
      const headers = { cookie, "content-type": "application/json" }
      const created = await fetch(`${app.url}/api/workspaces`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "app" }),
      })
      const { workspace } = (await created.json()) as { workspace: { id: string } }
      // Five records with concurrency 4: the fifth release starts only after
      // the response budget expired, which is the case that used to receive an
      // already-aborted signal and silently skip the git work.
      for (let i = 0; i < 5; i += 1) {
        await fetch(`${app.url}/api/workspaces/${workspace.id}/sessions`, {
          method: "POST",
          headers,
          body: JSON.stringify({ isolated: true }),
        })
      }

      const deletion = fetch(`${app.url}/api/workspaces/${workspace.id}`, {
        method: "DELETE",
        headers,
      })
      // Parallel, not sequential: the first batch starts while none finished.
      await waitFor(() => started.length === 4, 5000)
      expect(finished).toEqual([])
      const response = await deletion
      // Ambiguous, never a hard failure: the row is already gone, so the
      // client reconciles by refetching the workspace list.
      expect(response.status).toBe(504)
      expect(await response.json()).toEqual({ error: "delete_timeout" })
      const list = (await (await fetch(`${app.url}/api/workspaces`, { headers })).json()) as {
        workspaces: Array<{ id: string }>
      }
      expect(list.workspaces.some((entry) => entry.id === workspace.id)).toBe(false)
      // The detached cleanup continues: the fifth removal is not cancelled by
      // the 504 (removals have no signal of their own) and nothing is dropped
      // from the store before its worktree attempt.
      // Anti-regression guard: before #225 the fifth removal received the
      // already-aborted request signal (the real manager then refused to spawn
      // git). Removals now carry no signal at all, so every entry is false.
      removeGate.resolve()
      await waitFor(() => finished.length === 5)
      expect(abortedAtStart).toEqual([false, false, false, false, false])
      expect(app.store.listIsolatedSessions()).toHaveLength(0)
    } finally {
      removeGate.resolve()
      await app.close()
    }
  })

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

  it("keeps releasing the other children when one cleanup fails after the row removal", async () => {
    const { app, worktrees, headers, workspace } = await setupApp()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const created = await fetch(`${app.url}/api/workspaces/${workspace.id}/sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ isolated: true }),
      })
      const { session } = (await created.json()) as { session: { id: string } }

      // The row is already gone when cleanup runs. A storage failure in one
      // child release must not become a 503 with no retry path: the remaining
      // worktree/record cleanup still runs and the delete answers 200.
      app.preview.forget = vi.fn(async () => {
        throw Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" })
      })

      const response = await fetch(`${app.url}/api/workspaces/${workspace.id}`, {
        method: "DELETE",
        headers,
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true })
      expect(app.preview.forget).toHaveBeenCalledWith(session.id)
      expect(worktrees.calls.some((call) => call.startsWith("remove:"))).toBe(true)
      expect(app.store.getIsolatedSession(session.id)).toBeNull()
      expect(app.store.getWorkspace(workspace.id)).toBeNull()
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
      await app.close()
    }
  })

  it("stops the managed run, forgets the goal and cascades the run config", async () => {
    const { app, opencode, headers, workspace } = await setupApp()
    try {
      const created = await fetch(`${app.url}/api/workspaces/${workspace.id}/sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ isolated: true }),
      })
      const { session } = (await created.json()) as { session: { id: string } }
      app.store.saveWorkspaceRun({
        workspaceID: workspace.id,
        command: "npm",
        args: ["run", "dev"],
        cwd: null,
        source: "user",
        updatedAt: 1,
      })
      app.store.saveGoalRun(goalRun({ sessionID: session.id }))

      const started = await fetch(`${app.url}/api/sessions/${session.id}/run?workspace=${workspace.id}`, {
        method: "POST",
        headers,
      })
      expect(started.status).toBe(200)
      expect(opencode.ptys).toHaveLength(1)
      const ptyID = opencode.ptys[0]!.id

      const response = await fetch(`${app.url}/api/workspaces/${workspace.id}`, {
        method: "DELETE",
        headers,
      })
      expect(response.status).toBe(200)

      // The PTY was stopped through opencode before its worktree disappeared.
      expect(
        opencode.calls.some((call) => call.method === "DELETE" && call.path === `/api/pty/${ptyID}`),
      ).toBe(true)
      expect(opencode.ptys).toHaveLength(0)
      expect(app.store.getGoalRun(session.id)).toBeNull()
      expect(app.store.getIsolatedSession(session.id)).toBeNull()
      expect(app.store.getWorkspaceRun(workspace.id)).toBeNull()
      expect(app.store.getWorkspace(workspace.id)).toBeNull()
    } finally {
      await app.close()
    }
  })

  it("stops the managed run of a base-folder session and drops its board rows", async () => {
    const { app, opencode, headers, workspace } = await setupApp()
    try {
      const created = await fetch(`${app.url}/api/workspaces/${workspace.id}/sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      })
      const { session } = (await created.json()) as { session: { id: string } }
      app.store.saveWorkspaceRun({
        workspaceID: workspace.id,
        command: "npm",
        args: ["run", "dev"],
        cwd: null,
        source: "user",
        updatedAt: 1,
      })
      app.store.createBoardColumn({ id: "col_1", workspaceID: workspace.id, title: "Todo" })

      // `sessionRunContext` resolves base-folder sessions too, so their PTY is
      // just as real as an isolated one.
      const started = await fetch(`${app.url}/api/sessions/${session.id}/run?workspace=${workspace.id}`, {
        method: "POST",
        headers,
      })
      expect(started.status).toBe(200)
      expect(opencode.ptys).toHaveLength(1)
      const ptyID = opencode.ptys[0]!.id

      const response = await fetch(`${app.url}/api/workspaces/${workspace.id}`, {
        method: "DELETE",
        headers,
      })
      expect(response.status).toBe(200)

      expect(
        opencode.calls.some((call) => call.method === "DELETE" && call.path === `/api/pty/${ptyID}`),
      ).toBe(true)
      expect(opencode.ptys).toHaveLength(0)
      expect(app.store.getWorkspaceRun(workspace.id)).toBeNull()
      expect(app.store.getBoard(workspace.id).columns).toHaveLength(0)
    } finally {
      await app.close()
    }
  })

  it("rejects an isolated create whose workspace was deleted while opencode was creating it", async () => {
    const gate = deferred()
    const { app, opencode, worktrees, headers, workspace } = await setupApp()
    try {
      opencode.holdNextCreate(gate.promise)
      const creating = fetch(`${app.url}/api/workspaces/${workspace.id}/sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ isolated: true }),
      })
      await waitFor(() =>
        opencode.calls.some((call) => call.method === "POST" && call.path === "/api/session"),
      )

      // The create passed the route's workspace lookup and is inside the
      // upstream call. Deleting the row first must make the create roll back.
      const deletion = await fetch(`${app.url}/api/workspaces/${workspace.id}`, {
        method: "DELETE",
        headers,
      })
      expect(deletion.status).toBe(200)

      gate.resolve()
      const response = await creating
      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({ error: "workspace_busy" })
      expect(app.store.listIsolatedSessions()).toHaveLength(0)
      expect(worktrees.calls.some((call) => call.startsWith("remove:"))).toBe(true)
      expect(
        opencode.calls.some((call) => call.method === "DELETE" && call.path.startsWith("/api/session/")),
      ).toBe(true)
    } finally {
      gate.resolve()
      await app.close()
    }
  })

  it("removes the worktree directory directly when a deleteFiles rollback lost its repo", async () => {
    const gate = deferred()
    const worktrees = createFakeWorktreeManager()
    let worktreePath = ""
    const originalCreate = worktrees.create
    worktrees.create = async (repo, path, branch, baseRef) => {
      worktreePath = path
      await originalCreate(repo, path, branch, baseRef)
    }
    const removedPaths: string[] = []
    const opencode = createOpencodeMock()
    const app = await startTestApp({
      worktrees,
      fetchImpl: opencode.fetchImpl,
      removeDir: async (path) => {
        removedPaths.push(path)
      },
    })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const cookie = await login(app.url)
      const headers = { cookie, "content-type": "application/json" }
      const created = await fetch(`${app.url}/api/workspaces`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "app" }),
      })
      const { workspace } = (await created.json()) as { workspace: { id: string; path: string } }

      // With deleteFiles=1 the repo folder disappears during the create. Git can
      // no longer remove the worktree, and reconcile only walks existing
      // workspaces, so the directory itself must be removed.
      worktrees.remove = async () => {
        throw new Error("not a git repository")
      }
      opencode.holdNextCreate(gate.promise)
      const creating = fetch(`${app.url}/api/workspaces/${workspace.id}/sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ isolated: true }),
      })
      await waitFor(() =>
        opencode.calls.some((call) => call.method === "POST" && call.path === "/api/session"),
      )

      const deletion = await fetch(`${app.url}/api/workspaces/${workspace.id}?deleteFiles=1`, {
        method: "DELETE",
        headers,
      })
      expect(deletion.status).toBe(200)
      expect(removedPaths).toContain(workspace.path)

      gate.resolve()
      const response = await creating
      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({ error: "workspace_busy" })
      expect(worktreePath).not.toBe("")
      expect(removedPaths).toContain(worktreePath)
      expect(app.store.listIsolatedSessions()).toHaveLength(0)
    } finally {
      gate.resolve()
      warn.mockRestore()
      await app.close()
    }
  })

  it("releases an isolated record created while the delete guard was in flight", async () => {
    const gate = deferred()
    const { app, opencode, worktrees, headers, workspace } = await setupApp()
    try {
      // A base session makes the guard consult `/api/session/active`; the
      // route snapshotted the (empty) isolated list before it. The isolated
      // create lands while that guard is held, so only a re-list after the row
      // removal can find and release it.
      const base = await fetch(`${app.url}/api/workspaces/${workspace.id}/sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      })
      expect(base.status).toBe(201)
      opencode.holdNextActive(gate.promise)
      const deletion = fetch(`${app.url}/api/workspaces/${workspace.id}?deleteFiles=1`, {
        method: "DELETE",
        headers,
      })
      await waitFor(() =>
        opencode.calls.some((call) => call.method === "GET" && call.path === "/api/session/active"),
      )
      const created = await fetch(`${app.url}/api/workspaces/${workspace.id}/sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ isolated: true }),
      })
      expect(created.status).toBe(201)
      expect(app.store.listIsolatedSessions(workspace.id)).toHaveLength(1)

      gate.resolve()
      const response = await deletion
      expect(response.status).toBe(200)
      expect(app.store.listIsolatedSessions()).toHaveLength(0)
      expect(worktrees.calls.some((call) => call.startsWith("remove:"))).toBe(true)
      expect(app.store.getWorkspace(workspace.id)).toBeNull()
    } finally {
      gate.resolve()
      await app.close()
    }
  })

  it("pauses scheduled tasks for the folder before removing it and refuses a later run", async () => {
    let pausedAtRemove: boolean | null = null
    const store = createSqliteStore(":memory:")
    const opencode = createOpencodeMock()
    const app = await startTestApp({
      store,
      fetchImpl: opencode.fetchImpl,
      removeDir: async () => {
        pausedAtRemove = store.getScheduledTask("task_ws")?.paused ?? null
      },
    })
    try {
      const cookie = await login(app.url)
      const headers = { cookie, "content-type": "application/json" }
      const created = await fetch(`${app.url}/api/workspaces`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "app" }),
      })
      const { workspace } = (await created.json()) as { workspace: { id: string; path: string } }
      store.createScheduledTask({
        id: "task_ws",
        name: "Nightly",
        prompt: "check",
        model: { providerID: "test", id: "test-model" },
        schedule: { kind: "interval", intervalMinutes: 60 },
        timezone: "",
        directory: workspace.path,
        paused: false,
        lastRunAt: null,
        nextRunAt: new Date(Date.now() + 3_600_000).toISOString(),
        createdAt: new Date().toISOString(),
      })

      const deletion = await fetch(`${app.url}/api/workspaces/${workspace.id}?deleteFiles=1`, {
        method: "DELETE",
        headers,
      })
      expect(deletion.status).toBe(200)
      expect(pausedAtRemove).toBe(true)
      expect(store.getScheduledTask("task_ws")?.paused).toBe(true)

      const createsBefore = opencode.calls.filter(
        (call) => call.method === "POST" && call.path === "/api/session",
      ).length
      const run = await fetch(`${app.url}/api/scheduled-tasks/task_ws/run`, {
        method: "POST",
        headers,
      })
      expect(run.status).toBe(409)
      expect(((await run.json()) as { error: string }).error).toBe("task_paused")
      expect(
        opencode.calls.filter((call) => call.method === "POST" && call.path === "/api/session").length,
      ).toBe(createsBefore)
      expect(store.listScheduledRuns("task_ws")).toHaveLength(0)
    } finally {
      await app.close()
    }
  })

  it("pauses a due task before the active-session guard so an in-flight fire is seen", async () => {
    const opencode = createOpencodeMock()
    const removedPaths: string[] = []
    const createGate = deferred()
    const app = await startTestApp({
      fetchImpl: opencode.fetchImpl,
      removeDir: async (path) => {
        removedPaths.push(path)
      },
    })
    try {
      const cookie = await login(app.url)
      const headers = { cookie, "content-type": "application/json" }
      const created = await fetch(`${app.url}/api/workspaces`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "app" }),
      })
      const { workspace } = (await created.json()) as { workspace: { id: string; path: string } }
      app.store.createScheduledTask({
        id: "task_due",
        name: "Due now",
        prompt: "check",
        model: { providerID: "test", id: "test-model" },
        schedule: { kind: "interval", intervalMinutes: 60 },
        timezone: "",
        directory: workspace.path,
        paused: false,
        lastRunAt: null,
        nextRunAt: new Date(Date.now() - 60_000).toISOString(),
        createdAt: new Date().toISOString(),
      })
      // The fire's session will be the mock's first one.
      opencode.setActive(["ses_1"])

      const pauseCalled = deferred()
      const originalPause = app.scheduler.pauseTask.bind(app.scheduler)
      app.scheduler.pauseTask = (taskID) => {
        pauseCalled.resolve()
        return originalPause(taskID)
      }

      opencode.holdNextCreate(createGate.promise)
      const tick = app.scheduler.tick()
      await waitFor(() =>
        opencode.calls.some((call) => call.method === "POST" && call.path === "/api/session"),
      )

      const deletion = fetch(`${app.url}/api/workspaces/${workspace.id}?deleteFiles=1`, {
        method: "DELETE",
        headers,
      })
      // This resolves as soon as the route calls pauseTask. With the guard
      // first, the guard already ran against a session list that predates the
      // fire (the create is still held), so the delete would proceed under it.
      await pauseCalled.promise
      createGate.resolve()
      await tick

      const response = await deletion
      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({ error: "workspace_busy" })
      expect(removedPaths).toEqual([])
      expect(app.store.getWorkspace(workspace.id)).not.toBeNull()
      // The refusal did not delete the workspace, so the task it paused must be
      // resumed (with a recomputed future slot), not silently left disabled.
      const task = app.store.getScheduledTask("task_due")
      expect(task?.paused).toBe(false)
      expect(new Date(task!.nextRunAt!).getTime()).toBeGreaterThan(Date.now())
    } finally {
      createGate.resolve()
      await app.close()
    }
  })

  it("refuses a destructive delete while an isolated session is active and deletes nothing", async () => {
    const removedPaths: string[] = []
    const opencode = createOpencodeMock()
    const worktrees = createFakeWorktreeManager()
    const app = await startTestApp({
      worktrees,
      fetchImpl: opencode.fetchImpl,
      removeDir: async (path) => {
        removedPaths.push(path)
      },
    })
    try {
      const cookie = await login(app.url)
      const headers = { cookie, "content-type": "application/json" }
      const created = await fetch(`${app.url}/api/workspaces`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "app" }),
      })
      const { workspace } = (await created.json()) as { workspace: { id: string; path: string } }
      const sessionResponse = await fetch(`${app.url}/api/workspaces/${workspace.id}/sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ isolated: true }),
      })
      const { session } = (await sessionResponse.json()) as { session: { id: string } }
      opencode.setActive([session.id])
      app.store.createScheduledTask({
        id: "task_refused",
        name: "Nightly",
        prompt: "check",
        model: { providerID: "test", id: "test-model" },
        schedule: { kind: "interval", intervalMinutes: 60 },
        timezone: "",
        directory: workspace.path,
        paused: false,
        lastRunAt: null,
        nextRunAt: new Date(Date.now() + 3_600_000).toISOString(),
        createdAt: new Date().toISOString(),
      })
      const pauseTask = vi.spyOn(app.scheduler, "pauseTask")
      const resumeTask = vi.spyOn(app.scheduler, "resumeTask")

      const response = await fetch(`${app.url}/api/workspaces/${workspace.id}?deleteFiles=1`, {
        method: "DELETE",
        headers,
      })
      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({ error: "workspace_busy" })
      expect(removedPaths).toEqual([])
      expect(worktrees.calls.some((call) => call.startsWith("remove:"))).toBe(false)
      expect(app.store.getIsolatedSession(session.id)).not.toBeNull()
      expect(app.store.getWorkspace(workspace.id)).not.toBeNull()
      // The refusal paused the task (to let an in-flight fire settle before the
      // guard) and then resumed exactly the task it paused, so the schedule is
      // not silently disabled by a delete that deleted nothing.
      expect(pauseTask).toHaveBeenCalledTimes(1)
      expect(pauseTask).toHaveBeenCalledWith("task_refused")
      expect(resumeTask).toHaveBeenCalledTimes(1)
      expect(resumeTask).toHaveBeenCalledWith("task_refused")
      expect(app.store.getScheduledTask("task_refused")?.paused).toBe(false)
    } finally {
      await app.close()
    }
  })

  it("waits for an in-flight finish before removing the worktree", async () => {
    const gate = deferred()
    let commits = 0
    const events: string[] = []
    const commitAll = vi.fn(async () => {
      commits += 1
      events.push("commit")
      await gate.promise
      events.push("commit:done")
      return true
    })
    const worktrees = createFakeWorktreeManager({
      remoteUrl: async () => "git@github.com:org/repo.git",
      commitAll,
      push: async () => {},
      pullRequest: async () => "https://github.com/org/repo/pull/9",
    })
    const originalRemove = worktrees.remove
    worktrees.remove = async (repo, path, branch) => {
      events.push("remove")
      await originalRemove(repo, path, branch)
    }
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

      const finish = fetch(`${app.url}/api/isolated-sessions/${session.id}/finish`, {
        method: "POST",
        headers,
      })
      await waitFor(() => commits === 1)
      const deletion = fetch(`${app.url}/api/workspaces/${workspace.id}`, {
        method: "DELETE",
        headers,
      })
      // The row is removed synchronously immediately before the child-release
      // loop. One event-loop turn later the release must be parked on
      // `awaitFinish`: a release that skipped it has already recorded `remove`.
      await waitFor(() => app.store.getWorkspace(workspace.id) === null)
      await new Promise((resolve) => setImmediate(resolve))
      expect(events).not.toContain("remove")
      gate.resolve()

      const [finishResponse, deletionResponse] = await Promise.all([finish, deletion])
      expect(finishResponse.status).toBe(200)
      expect(deletionResponse.status).toBe(200)
      expect(events.indexOf("remove")).toBeGreaterThan(events.indexOf("commit:done"))
      expect(app.store.getIsolatedSession(session.id)).toBeNull()
    } finally {
      gate.resolve()
      await app.close()
    }
  })
})
