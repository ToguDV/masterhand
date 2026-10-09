import { afterEach, describe, expect, it, vi } from "vitest"
import { login, startMockOpencode, startTestApp, waitFor, type MockOpencode, type TestApp } from "./helpers.js"

// Real timers + HTTP + SSE: give every case headroom so a loaded CI/hook run
// (parallel suites, coverage instrumentation) cannot fail on the 15s default.
vi.setConfig({ testTimeout: 30_000 })

const TEST_AUTH = `Basic ${Buffer.from("opencode:oc-secret").toString("base64")}`

let app: TestApp | null = null
let upstream: MockOpencode | null = null

/**
 * Waits until the BFF has actually prompted a phase session. The phase writes
 * its instruction a few awaits before its prompt baseline is persisted, so a
 * reply injected too early would be captured as the baseline and never seen as
 * the phase's answer (the run would stall until the watchdog).
 */
async function waitForPrompt(sessionID: string): Promise<void> {
  await waitFor(
    () =>
      upstream!.requests.some(
        (request) => request.method === "POST" && request.path === `/api/session/${sessionID}/prompt`,
      ),
    20_000,
  )
}

afterEach(async () => {
  await app?.close()
  await upstream?.close()
  app = null
  upstream = null
})

/**
 * Integration: the real goal manager drives the real opencode adapter through
 * the BFF routes, with the SSE hub as the event source (no fake manager).
 */
describe("goal integration", () => {
  it("runs a full loop: prompt -> report -> critique -> verdict -> approved", async () => {
    upstream = await startMockOpencode()
    upstream.addSession({ id: "ses_main", directory: "/e2e/workspace", model: "test/old-model" })
    app = await startTestApp({ config: { opencodeUrl: upstream.url, opencodeAuth: TEST_AUTH } })
    const cookie = await login(app.url)
    // The hub must be subscribed before events are emitted (SSE has no replay).
    await waitFor(() => upstream!.requests.some((request) => request.path === "/api/event"), 20_000)

    const started = await fetch(`${app.url}/api/sessions/ses_main/goal`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        goal: "Make the suite green",
        model: { providerID: "test", id: "test-model", variant: "high" },
        agent: "build",
      }),
    })
    expect(started.status).toBe(201)

    await waitFor(() => upstream!.requests.some((request) => request.path === "/api/session/ses_main/prompt"), 20_000)
    // The composer's agent/model are applied to the main session before the
    // goal prompt (regression: /goal used to keep the session's old model).
    const switchIndex = upstream.requests.findIndex(
      (request) => request.method === "POST" && request.path === "/api/session/ses_main/model",
    )
    const promptIndex = upstream.requests.findIndex((request) => request.path === "/api/session/ses_main/prompt")
    expect(switchIndex).toBeGreaterThanOrEqual(0)
    expect(switchIndex).toBeLessThan(promptIndex)
    expect(JSON.parse(upstream.requests[switchIndex]!.body!)).toEqual({
      model: { id: "test-model", providerID: "test", variant: "high" },
    })
    expect(
      upstream.requests.some((request) => request.method === "POST" && request.path === "/api/session/ses_main/agent"),
    ).toBe(true)
    expect(upstream.sessionWithInstruction("masterhand.goal")).toBe("ses_main")
    // The main prompt carries the goal delivery marker so a lost response can be reconciled.
    const mainPrompt = upstream.requests.find((request) => request.path === "/api/session/ses_main/prompt")
    expect(mainPrompt?.body).toContain("masterhand.goal.delivery")

    upstream.reply(
      "ses_main",
      'Finished.\n<masterhand:goal status="complete">{"summary": "green", "evidence": ["npm test"]}</masterhand:goal>',
    )
    upstream.emit({ type: "session.idle", data: { sessionID: "ses_main" } })

    await waitFor(() => Boolean(upstream!.sessionWithInstruction("masterhand.goal.critic")), 20_000)
    const critic = upstream.sessionWithInstruction("masterhand.goal.critic")!
    await waitForPrompt(critic)
    const criticCreate = upstream.requests.find(
      (request) => request.method === "POST" && request.path === "/api/session" && request.body?.includes("masterhand.goal.role"),
    )
    expect(JSON.parse(criticCreate!.body!)).toMatchObject({
      parentID: "ses_main",
      location: { directory: "/e2e/workspace" },
      // Stable role marker: the pinned opencode drops `parentID`, so this is
      // what lets the BFF hide the internal sessions from the lists.
      metadata: { "masterhand.goal.internal": "critic" },
    })

    upstream.reply(
      critic,
      '<masterhand:critique>{"argument": "No material issue found", "issues": []}</masterhand:critique>',
    )
    upstream.emit({ type: "session.idle", data: { sessionID: critic } })

    await waitFor(() => Boolean(upstream!.sessionWithInstruction("masterhand.goal.judge")), 20_000)
    const judge = upstream.sessionWithInstruction("masterhand.goal.judge")!
    await waitForPrompt(judge)
    upstream.reply(
      judge,
      '<masterhand:verdict>{"approved": true, "reasoning": "verified", "requiredChanges": []}</masterhand:verdict>',
    )
    upstream.emit({ type: "session.idle", data: { sessionID: judge } })

    await waitFor(() => app!.store.getGoalRun("ses_main")?.state === "approved", 20_000)
    const status = await fetch(`${app.url}/api/sessions/ses_main/goal`, { headers: { cookie } })
    expect(await status.json()).toMatchObject({
      goal: { state: "approved", round: 1, lastVerdict: { approved: true } },
    })
    // The completion instruction is removed once the run is over.
    expect(upstream.sessionWithInstruction("masterhand.goal")).toBeNull()
  })

  it("cancels a run through the route and cleans the internal sessions", async () => {
    upstream = await startMockOpencode()
    upstream.addSession({ id: "ses_main", directory: "/e2e/workspace", model: "test/test-model" })
    app = await startTestApp({ config: { opencodeUrl: upstream.url, opencodeAuth: TEST_AUTH } })
    const cookie = await login(app.url)
    await waitFor(() => upstream!.requests.some((request) => request.path === "/api/event"), 20_000)

    await fetch(`${app.url}/api/sessions/ses_main/goal`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ goal: "Make the suite green" }),
    })
    await waitFor(() => upstream!.requests.some((request) => request.path === "/api/session/ses_main/prompt"), 20_000)
    upstream.reply(
      "ses_main",
      '<masterhand:goal status="complete">{"summary": "done", "evidence": []}</masterhand:goal>',
    )
    upstream.emit({ type: "session.idle", data: { sessionID: "ses_main" } })
    await waitFor(() => Boolean(upstream!.sessionWithInstruction("masterhand.goal.critic")), 20_000)
    const critic = upstream.sessionWithInstruction("masterhand.goal.critic")!

    const cancelled = await fetch(`${app.url}/api/sessions/ses_main/goal/cancel`, {
      method: "POST",
      headers: { cookie },
    })
    expect(cancelled.status).toBe(200)
    expect(await cancelled.json()).toMatchObject({ goal: { state: "cancelled" } })
    await waitFor(
      () =>
        upstream!.requests.some(
          (request) => request.method === "DELETE" && request.path === `/api/session/${critic}`,
        ),
      20_000,
    )
  })

  it("reports settings validation failures through the route", async () => {
    upstream = await startMockOpencode()
    app = await startTestApp({ config: { opencodeUrl: upstream.url, opencodeAuth: TEST_AUTH } })
    const cookie = await login(app.url)

    const invalidModel = await fetch(`${app.url}/api/goal/settings`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ criticModel: "ghost/model" }),
    })
    expect(invalidModel.status).toBe(400)
    expect(await invalidModel.json()).toMatchObject({ error: "invalid_model" })

    const saved = await fetch(`${app.url}/api/goal/settings`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ maxRounds: 3, judgeModel: "test/judge-model" }),
    })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({ settings: { maxRounds: 3, judgeModel: "test/judge-model" } })
  })
})
