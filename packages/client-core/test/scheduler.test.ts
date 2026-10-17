import { describe, expect, it } from "vitest"
import { ApiError } from "../src/client"
import { SCHEDULER_EVENT_TYPE, schedulerEventOf, type ScheduledTask } from "../src/scheduler"

function scheduledTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "st_1",
    name: "Nightly sweep",
    prompt: "Inspect the failing checks",
    model: { providerID: "anthropic", id: "claude" },
    schedule: { kind: "interval", intervalMinutes: 30 },
    timezone: "UTC",
    directory: "/workspace/app",
    paused: false,
    lastRunAt: null,
    nextRunAt: "2026-10-16T10:00:00.000Z",
    createdAt: "2026-10-15T10:00:00.000Z",
    ...overrides,
  }
}

describe("scheduler frames", () => {
  it("identifies scheduler.updated frames and their targeted task", () => {
    expect(schedulerEventOf({ type: SCHEDULER_EVENT_TYPE, data: { taskID: "st_1" } })).toEqual({
      taskID: "st_1",
    })
    // A generic frame (a task was added/removed) targets every task state.
    expect(schedulerEventOf({ type: SCHEDULER_EVENT_TYPE })).toEqual({ taskID: null })
    expect(schedulerEventOf({ type: SCHEDULER_EVENT_TYPE, data: {} })).toEqual({ taskID: null })
    expect(schedulerEventOf({ type: SCHEDULER_EVENT_TYPE, data: { taskID: 42 } })).toEqual({ taskID: null })
    // Top-level task ids are ignored: the payload rides inside `data` like goal/board.
    expect(schedulerEventOf({ type: SCHEDULER_EVENT_TYPE, taskID: "st_1" })).toEqual({ taskID: null })
  })

  it("rejects anything that is not a scheduler.updated frame", () => {
    expect(schedulerEventOf({ type: "goal.updated", taskId: "st_1" })).toBeNull()
    expect(schedulerEventOf({ type: "board.updated", data: { taskId: "st_1" } })).toBeNull()
    expect(schedulerEventOf({ nope: true })).toBeNull()
    expect(schedulerEventOf(null)).toBeNull()
    expect(schedulerEventOf("scheduler.updated")).toBeNull()
  })
})

describe("scheduler client", () => {
  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  }

  it("targets the scheduled-task routes and unwraps the payload wrappers", async () => {
    const task = scheduledTask()
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      const target = String(url)
      if (target === "/api/scheduled-tasks" && (init?.method ?? "GET") === "GET") {
        return jsonResponse({ tasks: [task] })
      }
      if (target === "/api/scheduled-tasks" && init?.method === "POST") {
        return jsonResponse({ task: scheduledTask({ id: "st_new", ...(JSON.parse(String(init.body)) as Partial<ScheduledTask>) }) }, 201)
      }
      if (target.endsWith("/run")) return jsonResponse({ task: scheduledTask({ lastRunAt: "2026-10-16T12:00:00.000Z" }) })
      if (target.endsWith("/runs")) return jsonResponse({ runs: [] })
      if (target.endsWith("/api/scheduled-tasks/st_1") && init?.method === "PATCH") {
        return jsonResponse({ task: scheduledTask({ paused: true }) })
      }
      return new Response(null, { status: 204 })
    }) as typeof fetch

    const { createClient } = await import("../src/client")
    const client = createClient({ baseUrl: "", fetchImpl })

    const input = {
      name: "Nightly sweep",
      prompt: "Inspect the failing checks",
      model: { providerID: "anthropic", id: "claude" },
      schedule: { kind: "cron" as const, cron: "30 4 * * *" },
      timezone: "Europe/Madrid",
      directory: "/workspace/app",
    }

    expect(await client.api.scheduler.list()).toEqual([task])
    const created = await client.api.scheduler.create(input)
    expect(created.id).toBe("st_new")
    expect((await client.api.scheduler.update("st_1", { paused: true })).paused).toBe(true)
    await client.api.scheduler.remove("st_1")
    const fired = await client.api.scheduler.runNow("st_1")
    expect(fired.lastRunAt).toBe("2026-10-16T12:00:00.000Z")
    expect(await client.api.scheduler.runs("st_1")).toEqual([])

    expect(calls.map((call) => `${call.init?.method ?? "GET"} ${call.url}`)).toEqual([
      "GET /api/scheduled-tasks",
      "POST /api/scheduled-tasks",
      "PATCH /api/scheduled-tasks/st_1",
      "DELETE /api/scheduled-tasks/st_1",
      "POST /api/scheduled-tasks/st_1/run",
      "GET /api/scheduled-tasks/st_1/runs",
    ])
    // The create body is the input as given (timezone included), the patch is partial.
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual(input)
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({ paused: true })
  })

  it("omits the optional timezone from the create body when absent", async () => {
    const calls: Array<{ init?: RequestInit }> = []
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push({ init })
      return jsonResponse({ task: scheduledTask() }, 201)
    }) as typeof fetch

    const { createClient } = await import("../src/client")
    const client = createClient({ baseUrl: "", fetchImpl })

    await client.api.scheduler.create({
      name: "Sweep",
      prompt: "Check",
      model: { providerID: "anthropic", id: "claude" },
      schedule: { kind: "interval", intervalMinutes: 30 },
      directory: "/workspace/app",
    })
    expect(JSON.parse(String(calls[0]?.init?.body))).not.toHaveProperty("timezone")
  })

  it("propagates typed errors (409 rejects a paused Run now)", async () => {
    const fetchImpl = (async () => new Response("task is paused", { status: 409 })) as typeof fetch
    const { createClient } = await import("../src/client")
    const client = createClient({ baseUrl: "", fetchImpl })

    const error = await client.api.scheduler.runNow("st_1").catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).status).toBe(409)
    expect((error as ApiError).message).toBe("task is paused")
  })

  it("returns 404 as a typed ApiError too", async () => {
    const fetchImpl = (async () => new Response("", { status: 404 })) as typeof fetch
    const { createClient } = await import("../src/client")
    const client = createClient({ baseUrl: "", fetchImpl })

    await expect(client.api.scheduler.update("st_missing", { paused: true })).rejects.toMatchObject({
      name: "ApiError",
      status: 404,
      message: "HTTP 404",
    })
  })
})
