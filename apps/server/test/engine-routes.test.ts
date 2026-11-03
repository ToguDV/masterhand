import { afterEach, describe, expect, it, vi } from "vitest"
import type { EngineMonitor, ResumeResult } from "../src/engine.js"
import { login, startTestApp, type TestApp } from "./helpers.js"

function fakeEngine(overrides: Partial<EngineMonitor> = {}): EngineMonitor {
  const base: EngineMonitor = {
    start: () => {},
    stop: () => {},
    status: async () => ({
      supervisor: true,
      healthy: true,
      restarting: false,
      circuitOpen: false,
      memoryWarning: false,
      state: "running",
      attempts: 0,
      maxAttempts: 3,
      lastIncident: null,
      memory: null,
      serverIncident: null,
      serverCircuitOpen: false,
      interruptedTurns: 0,
      autoResume: true,
      autoContinueChats: true,
    }),
    recover: async () => {},
    recoverNow: async () => {},
    resumeTurn: async () => ({ status: "skipped", reason: "no_turn" }) as ResumeResult,
    listTurns: () => [
      {
        sessionID: "ses_1",
        workspacePath: "/workspace/app",
        startedAt: 1,
        lastEventAt: 1,
        state: "interrupted",
        origin: "chat",
        reason: "engine",
        resumeAttempts: 0,
        lastResumeAt: null,
      },
    ],
    restartEngine: async () => ({ ok: true }),
    resetEngine: async () => ({ ok: true }),
    ...overrides,
  }
  return base
}

let app: TestApp | null = null
const apps: TestApp[] = []

async function start(engine: EngineMonitor): Promise<TestApp> {
  app = await startTestApp({ engine })
  apps.push(app)
  return app
}

afterEach(async () => {
  for (const testApp of apps.splice(0)) await testApp.close()
  app = null
})

describe("resilience routes", () => {
  it("requires auth for turns and resume", async () => {
    const testApp = await start(fakeEngine())
    expect((await fetch(`${testApp.url}/api/turns`)).status).toBe(401)
    expect((await fetch(`${testApp.url}/api/sessions/ses_1/resume`, { method: "POST" })).status).toBe(401)
  })

  it("lists only the public turn fields", async () => {
    const testApp = await start(fakeEngine())
    const cookie = await login(testApp.url)
    const response = await fetch(`${testApp.url}/api/turns`, { headers: { cookie } })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      turns: [{ sessionID: "ses_1", startedAt: 1, state: "interrupted", reason: "engine" }],
    })
  })

  it("sends a manual continuation and maps the outcomes", async () => {
    const resumeTurn = vi.fn<EngineMonitor["resumeTurn"]>()
    resumeTurn.mockResolvedValueOnce({ status: "resumed", automatic: false })
    resumeTurn.mockResolvedValueOnce({ status: "skipped", reason: "no_turn" })
    resumeTurn.mockResolvedValueOnce({ status: "skipped", reason: "session_busy" })
    resumeTurn.mockResolvedValueOnce({ status: "failed", reason: "ambiguous", ambiguous: true })
    resumeTurn.mockResolvedValueOnce({ status: "failed", reason: "rejected" })
    const testApp = await start(fakeEngine({ resumeTurn }))
    const cookie = await login(testApp.url)
    const resume = () =>
      fetch(`${testApp.url}/api/sessions/ses_1/resume`, { method: "POST", headers: { cookie } })

    const ok = await resume()
    expect(ok.status).toBe(202)
    expect(await ok.json()).toEqual({ resumed: true })
    expect(resumeTurn).toHaveBeenCalledWith("ses_1", { automatic: false })

    expect((await resume()).status).toBe(404)
    expect((await resume()).status).toBe(409)
    const ambiguous = await resume()
    expect(ambiguous.status).toBe(504)
    expect(await ambiguous.json()).toMatchObject({ error: "ambiguous", ambiguous: true })
    expect((await resume()).status).toBe(502)
  })

  it("rate-limits engine actions and maps supervisor failures", async () => {
    const testApp = await start(fakeEngine())
    const cookie = await login(testApp.url)
    const restart = () =>
      fetch(`${testApp.url}/api/engine/restart`, { method: "POST", headers: { cookie } })
    expect((await restart()).status).toBe(202)
    expect((await restart()).status).toBe(429)

    const failing = await start(
      fakeEngine({ restartEngine: async () => ({ ok: false, error: "supervisor_unavailable" }) }),
    )
    const failingCookie = await login(failing.url)
    const failed = await fetch(`${failing.url}/api/engine/restart`, {
      method: "POST",
      headers: { cookie: failingCookie },
    })
    expect(failed.status).toBe(503)
    expect(await failed.json()).toEqual({ error: "supervisor_unavailable" })
  })

  it("resets the budget through the supervisor route", async () => {
    const resetEngine = vi.fn(async () => ({ ok: true }))
    const testApp = await start(fakeEngine({ resetEngine }))
    const cookie = await login(testApp.url)
    const response = await fetch(`${testApp.url}/api/engine/reset`, { method: "POST", headers: { cookie } })
    expect(response.status).toBe(202)
    expect(resetEngine).toHaveBeenCalledTimes(1)
  })
})
