import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { reconcileWorktrees } from "../src/worktrees.js"
import {
  createSqliteStore,
  type IsolatedSessionRecord,
  type Store,
} from "../src/store.js"
import {
  createFakeWorktreeManager,
  login,
  startTestApp,
  waitFor,
  type TestApp,
} from "./helpers.js"

/**
 * Every internal opencode call is bounded by `OPENCODE_TIMEOUT_MS` and mapped
 * to 504 `opencode_timeout` (never left to await forever). A missed deadline
 * on the non-idempotent isolated create is not proof of failure: the worktree
 * is preserved and the created session is reconciled by its `masterhand.create`
 * marker before rolling anything back (#185).
 */

let app: TestApp | null = null
let tempDir: string | null = null

afterEach(async () => {
  await app?.close()
  app = null
  if (tempDir) await rm(tempDir, { recursive: true, force: true })
  tempDir = null
})

/** Fetch stub that only settles when its abort signal fires, like a stalled socket. */
const stalledFetch: typeof fetch = (_input, init) =>
  new Promise((_resolve, reject) => {
    const signal = init?.signal
    const abort = (): void => reject(signal?.reason ?? new DOMException("aborted", "AbortError"))
    if (signal?.aborted) return abort()
    signal?.addEventListener("abort", abort, { once: true })
  })

async function stalledApp(): Promise<{ app: TestApp; cookie: string; calls: string[] }> {
  const worktrees = createFakeWorktreeManager()
  const started = await startTestApp({
    config: { opencodeTimeoutMs: 25 },
    fetchImpl: stalledFetch,
    worktrees,
  })
  started.store.createWorkspace({
    id: "ws_1",
    name: "app",
    path: "/tmp/masterhand-workspaces/app",
    createdAt: 1,
  })
  return { app: started, cookie: await login(started.url), calls: worktrees.calls }
}

interface MockSession {
  id: string
  metadata?: Record<string, unknown>
}

/**
 * opencode stand-in for the isolated-create deadline: `POST /api/session`
 * stalls (or fails) while `GET /api/session?directory=…` reports whether the
 * upstream session actually landed. Instruction/permission writes succeed.
 */
function isolatedCreateMock(options: { create: "stall" | "error"; landed: boolean }) {
  const sessions = new Map<string, MockSession[]>()
  const createBodies: Array<{
    location?: { directory?: string }
    metadata?: Record<string, unknown>
  }> = []

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? "GET"
    if (method === "POST" && url.pathname === "/api/session") {
      const body = JSON.parse(String(init?.body ?? "{}")) as (typeof createBodies)[number]
      createBodies.push(body)
      const directory = body.location?.directory ?? ""
      // Upstream may have created the session before its response stalled.
      if (options.landed) sessions.set(directory, [{ id: "ses_recovered", metadata: body.metadata }])
      if (options.create === "error") return new Response("boom", { status: 500 })
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        const abort = (): void => reject(signal?.reason ?? new DOMException("aborted", "AbortError"))
        if (signal?.aborted) return abort()
        signal?.addEventListener("abort", abort, { once: true })
      })
    }
    if (method === "GET" && url.pathname === "/api/session") {
      const directory = url.searchParams.get("directory") ?? ""
      return Response.json({ data: sessions.get(directory) ?? [], cursor: { next: null } })
    }
    return new Response(null, { status: 204 })
  }) as typeof fetch

  return { fetchImpl, sessions, createBodies }
}

async function isolatedApp(
  fetchImpl: typeof fetch,
  options: { worktreesRoot?: string; store?: Store; opencodeTimeoutMs?: number } = {},
): Promise<{ app: TestApp; cookie: string; calls: string[] }> {
  const worktrees = createFakeWorktreeManager()
  const started = await startTestApp({
    config: {
      opencodeTimeoutMs: options.opencodeTimeoutMs ?? 25,
      ...(options.worktreesRoot ? { worktreesRoot: options.worktreesRoot } : {}),
    },
    fetchImpl,
    worktrees,
    store: options.store,
  })
  started.store.createWorkspace({
    id: "ws_1",
    name: "app",
    path: "/tmp/masterhand-workspaces/app",
    createdAt: 1,
  })
  return { app: started, cookie: await login(started.url), calls: worktrees.calls }
}

describe("internal opencode call deadline", () => {
  it("answers 504 when the session listing stalls", { timeout: 3000 }, async () => {
    const started = await stalledApp()
    app = started.app

    const response = await fetch(`${started.app.url}/api/workspaces/ws_1/sessions`, {
      headers: { cookie: started.cookie },
    })
    expect(response.status).toBe(504)
    expect(await response.json()).toEqual({ error: "opencode_timeout" })
  })

  it("answers 504 when the command catalog stalls", { timeout: 3000 }, async () => {
    const started = await stalledApp()
    app = started.app

    const response = await fetch(`${started.app.url}/api/commands?directory=/tmp/app`, {
      headers: { cookie: started.cookie },
    })
    expect(response.status).toBe(504)
    expect(await response.json()).toEqual({ error: "opencode_timeout" })
  })

  it("answers 504 when session creation stalls", { timeout: 3000 }, async () => {
    const started = await stalledApp()
    app = started.app

    const response = await fetch(`${started.app.url}/api/workspaces/ws_1/sessions`, {
      method: "POST",
      headers: { cookie: started.cookie, "content-type": "application/json" },
      body: "{}",
    })
    expect(response.status).toBe(504)
    expect(await response.json()).toEqual({ error: "opencode_timeout" })
  })

  it("answers 504 when session deletion stalls", { timeout: 3000 }, async () => {
    const started = await stalledApp()
    app = started.app

    const response = await fetch(`${started.app.url}/api/workspaces/ws_1/sessions/ses_x`, {
      method: "DELETE",
      headers: { cookie: started.cookie },
    })
    expect(response.status).toBe(504)
    expect(await response.json()).toEqual({ error: "opencode_timeout" })
  })

  it("recovers the created isolated session after a timeout and keeps the worktree", { timeout: 3000 }, async () => {
    const opencode = isolatedCreateMock({ create: "stall", landed: true })
    const started = await isolatedApp(opencode.fetchImpl)
    app = started.app

    const response = await fetch(`${started.app.url}/api/workspaces/ws_1/sessions`, {
      method: "POST",
      headers: { cookie: started.cookie, "content-type": "application/json" },
      body: JSON.stringify({ isolated: true, marker: "marker_12345" }),
    })
    expect(response.status).toBe(201)
    const body = (await response.json()) as {
      session: { id: string; isolation: { branch: string; worktreePath: string; baseRef: string } }
      isolation: { branch: string; worktreePath: string; baseRef: string }
    }
    expect(body.session.id).toBe("ses_recovered")
    expect(body.session.isolation.branch).toMatch(/^masterhand\/app-[a-z0-9]+$/)
    expect(body.isolation).toEqual(body.session.isolation)

    // The create carried the marker into the worktree directory.
    const create = opencode.createBodies[0]
    expect(create?.metadata).toEqual({ "masterhand.create": "marker_12345" })
    expect(create?.location?.directory).toBe(body.isolation.worktreePath)

    // The record is persisted exactly like the success path…
    expect(app.store.getIsolatedSession("ses_recovered")).toMatchObject({
      sessionID: "ses_recovered",
      workspaceID: "ws_1",
      path: body.isolation.worktreePath,
      branch: body.isolation.branch,
      baseRef: "main",
      pushed: false,
      prUrl: null,
    })
    // …and the worktree is not rolled back (timeout ≠ failure).
    expect(started.calls.some((call) => call.startsWith("remove:"))).toBe(false)
  })

  it("answers 504 and preserves the worktree when the marker is absent", { timeout: 3000 }, async () => {
    const opencode = isolatedCreateMock({ create: "stall", landed: false })
    const started = await isolatedApp(opencode.fetchImpl)
    app = started.app

    const response = await fetch(`${started.app.url}/api/workspaces/ws_1/sessions`, {
      method: "POST",
      headers: { cookie: started.cookie, "content-type": "application/json" },
      body: JSON.stringify({ isolated: true, marker: "marker_12345" }),
    })
    expect(response.status).toBe(504)
    expect(await response.json()).toEqual({ error: "opencode_timeout" })
    // An unknown outcome must never destroy the resource it may belong to
    // (#79): the worktree is left for the startup quarantine/reconcile.
    expect(started.calls.some((call) => call.startsWith("remove:"))).toBe(false)
    expect(app.store.listIsolatedSessions()).toHaveLength(0)
  })

  it("quarantines the unknown worktree when the workspace vanished before the deadline", { timeout: 5000 }, async () => {
    const opencode = isolatedCreateMock({ create: "stall", landed: false })
    const started = await isolatedApp(opencode.fetchImpl, { opencodeTimeoutMs: 400 })
    app = started.app

    const creating = fetch(`${started.app.url}/api/workspaces/ws_1/sessions`, {
      method: "POST",
      headers: { cookie: started.cookie, "content-type": "application/json" },
      body: JSON.stringify({ isolated: true, marker: "marker_12345" }),
    })
    // The create passed the route's workspace lookup and is waiting upstream.
    await waitFor(() => opencode.createBodies.length === 1)
    // The workspace (and its row) disappears while that create is in flight:
    // no row means startup reconciliation will never walk this worktree.
    const deletion = await fetch(`${started.app.url}/api/workspaces/ws_1`, {
      method: "DELETE",
      headers: { cookie: started.cookie },
    })
    expect(deletion.status).toBe(200)

    const response = await creating
    // The deadline still answers "unknown"; the workspace deletion is what
    // changes the cleanup. Unknown work is never deleted: the worktree is
    // quarantined (renamed, branch kept) instead of being left unregistered.
    expect(response.status).toBe(504)
    expect(await response.json()).toEqual({ error: "opencode_timeout" })
    expect(started.calls.some((call) => call.startsWith("quarantine:"))).toBe(true)
    expect(started.calls.some((call) => call.startsWith("remove:"))).toBe(false)
    expect(app.store.listIsolatedSessions()).toHaveLength(0)
  })

  it("keeps the recovered record through a restart reconcile and the session list", { timeout: 5000 }, async () => {
    tempDir = await mkdtemp(join(tmpdir(), "masterhand-worktrees-"))
    const opencode = isolatedCreateMock({ create: "stall", landed: true })
    const started = await isolatedApp(opencode.fetchImpl, { worktreesRoot: tempDir })
    app = started.app

    const created = await fetch(`${started.app.url}/api/workspaces/ws_1/sessions`, {
      method: "POST",
      headers: { cookie: started.cookie, "content-type": "application/json" },
      body: JSON.stringify({ isolated: true, marker: "marker_12345" }),
    })
    expect(created.status).toBe(201)
    const body = (await created.json()) as {
      session: { id: string; isolation: { worktreePath: string; branch: string } }
    }
    // The git worktree is a real folder on the worktrees volume.
    await mkdir(body.session.isolation.worktreePath, { recursive: true })

    // A restart runs the quarantine-based reconcile: a live recorded path must
    // survive it, so the recovered session stays reachable after the restart.
    const reconciled = await reconcileWorktrees(app.store, createFakeWorktreeManager(), tempDir)
    expect(reconciled.droppedRecords).toEqual([])
    expect(app.store.getIsolatedSession(body.session.id)).not.toBeNull()

    const listed = await fetch(`${started.app.url}/api/workspaces/ws_1/sessions`, {
      headers: { cookie: started.cookie },
    })
    expect(listed.status).toBe(200)
    const list = (await listed.json()) as {
      sessions: Array<{ id: string; isolation?: { branch: string; worktreePath: string } }>
    }
    const recovered = list.sessions.find((session) => session.id === body.session.id)
    expect(recovered?.isolation).toEqual(body.session.isolation)
  })

  it("adopts the record a previous reconciliation of the same marker persisted", { timeout: 3000 }, async () => {
    const opencode = isolatedCreateMock({ create: "stall", landed: true })
    const store = createSqliteStore(":memory:")
    let winner: IsolatedSessionRecord | null = null
    store.createIsolatedSession = (record) => {
      // The first reconciliation of this marker already committed the row; the
      // retry hits the session's primary key instead of a writable slot.
      winner = record
      throw Object.assign(new Error("UNIQUE constraint failed: isolated_sessions.session_id"), {
        code: "SQLITE_CONSTRAINT_PRIMARYKEY",
      })
    }
    const readRecord = store.getIsolatedSession.bind(store)
    store.getIsolatedSession = (sessionID) =>
      winner && winner.sessionID === sessionID ? winner : readRecord(sessionID)
    const started = await isolatedApp(opencode.fetchImpl, { store })
    app = started.app

    const response = await fetch(`${started.app.url}/api/workspaces/ws_1/sessions`, {
      method: "POST",
      headers: { cookie: started.cookie, "content-type": "application/json" },
      body: JSON.stringify({ isolated: true, marker: "marker_12345" }),
    })
    // #191 must not turn the conflict into 503: the duplicate reconcile adopts
    // the existing record and answers exactly like the first one did.
    expect(response.status).toBe(201)
    const body = (await response.json()) as {
      session: { id: string; isolation: { branch: string; worktreePath: string } }
      isolation: { branch: string; worktreePath: string }
    }
    expect(body.session.id).toBe("ses_recovered")
    expect(winner).not.toBeNull()
    expect(body.isolation).toEqual(body.session.isolation)
    expect(body.isolation.branch).toBe(winner!.branch)
    expect(body.isolation.worktreePath).toBe(winner!.path)
    expect(started.calls.some((call) => call.startsWith("remove:"))).toBe(false)
  })

  it("rejects an adopted record that belongs to another worktree", { timeout: 3000 }, async () => {
    const opencode = isolatedCreateMock({ create: "stall", landed: true })
    const store = createSqliteStore(":memory:")
    let attempt: IsolatedSessionRecord | null = null
    store.createIsolatedSession = (record) => {
      attempt = record
      throw Object.assign(new Error("UNIQUE constraint failed: isolated_sessions.session_id"), {
        code: "SQLITE_CONSTRAINT_PRIMARYKEY",
      })
    }
    // Defensive mismatch: the row must not be adopted for a different path or
    // workspace (a real retry uses a new token/worktree, so this is a guard).
    store.getIsolatedSession = (sessionID) =>
      attempt && attempt.sessionID === sessionID ? { ...attempt, path: "/tmp/other-worktree" } : null
    const started = await isolatedApp(opencode.fetchImpl, { store })
    app = started.app

    const response = await fetch(`${started.app.url}/api/workspaces/ws_1/sessions`, {
      method: "POST",
      headers: { cookie: started.cookie, "content-type": "application/json" },
      body: JSON.stringify({ isolated: true, marker: "marker_12345" }),
    })
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: "storage_unavailable" })
    expect(started.calls.some((call) => call.startsWith("remove:"))).toBe(false)
  })

  it("answers 500 and rolls the worktree back on a non-timeout opencode error", { timeout: 3000 }, async () => {
    const opencode = isolatedCreateMock({ create: "error", landed: false })
    const started = await isolatedApp(opencode.fetchImpl)
    app = started.app

    const response = await fetch(`${started.app.url}/api/workspaces/ws_1/sessions`, {
      method: "POST",
      headers: { cookie: started.cookie, "content-type": "application/json" },
      body: JSON.stringify({ isolated: true, marker: "marker_12345" }),
    })
    expect(response.status).toBe(500)
    expect(started.calls.some((call) => call.startsWith("remove:"))).toBe(true)
    expect(app.store.listIsolatedSessions()).toHaveLength(0)
  })
})
