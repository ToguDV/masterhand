import { afterEach, describe, expect, it } from "vitest"
import {
  createFakeWorktreeManager,
  login,
  startTestApp,
  type TestApp,
} from "./helpers.js"

/**
 * Every internal opencode call is bounded by `OPENCODE_TIMEOUT_MS` and mapped
 * to 504 `opencode_timeout` (never left to await forever).
 */

let app: TestApp | null = null

afterEach(async () => {
  await app?.close()
  app = null
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

  it("cleans up the worktree and answers 504 when isolated creation stalls", { timeout: 3000 }, async () => {
    const started = await stalledApp()
    app = started.app

    const response = await fetch(`${started.app.url}/api/workspaces/ws_1/sessions`, {
      method: "POST",
      headers: { cookie: started.cookie, "content-type": "application/json" },
      body: JSON.stringify({ isolated: true }),
    })
    expect(response.status).toBe(504)
    expect(await response.json()).toEqual({ error: "opencode_timeout" })
    expect(started.calls.some((call) => call.startsWith("remove:"))).toBe(true)
  })
})
