import { afterEach, describe, expect, it } from "vitest"
import type { ScheduledRun, ScheduledTask } from "../src/store.js"
import {
  login,
  readUntil,
  startMockOpencode,
  startTestApp,
  waitFor,
  type MockOpencode,
  type TestApp,
} from "./helpers.js"

const DIRECTORY = "/e2e/demo"

function taskInput(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    name: "Nightly sweep",
    prompt: "Check the workspace",
    directory: DIRECTORY,
    model: { providerID: "test", id: "test-model" },
    schedule: { kind: "interval", intervalMinutes: 60 },
    ...overrides,
  }
}

/** A task shaped exactly as the store persists it, for direct seeding. */
function seededTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "task_seeded",
    name: "Seeded task",
    prompt: "Seed prompt",
    model: { providerID: "test", id: "test-model" },
    schedule: { kind: "interval", intervalMinutes: 30 },
    timezone: "",
    directory: DIRECTORY,
    paused: false,
    lastRunAt: null,
    nextRunAt: new Date(Date.now() + 3_600_000).toISOString(),
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    ...overrides,
  }
}

function seededRun(taskId: string, index: number, overrides: Partial<ScheduledRun> = {}): ScheduledRun {
  const startedAt = new Date(Date.now() + index * 1000).toISOString()
  return {
    id: `run_${index}`,
    taskId,
    sessionID: `ses_run_${index}`,
    status: "completed",
    source: "schedule",
    error: null,
    startedAt,
    endedAt: new Date(Date.parse(startedAt) + 500).toISOString(),
    ...overrides,
  }
}

let app: TestApp | null = null
let mock: MockOpencode | null = null

/** Boots the app against the mock opencode with a workspace for the tasks. */
async function boot(): Promise<string> {
  mock = await startMockOpencode()
  app = await startTestApp({ config: { opencodeUrl: mock.url } })
  app.store.createWorkspace({ id: "ws_demo", name: "demo", path: DIRECTORY, createdAt: 1 })
  return await login(app.url)
}

async function createTask(cookie: string, overrides: Partial<Record<string, unknown>> = {}): Promise<ScheduledTask> {
  const response = await fetch(`${app!.url}/api/scheduled-tasks`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(taskInput(overrides)),
  })
  expect(response.status).toBe(201)
  return ((await response.json()) as { task: ScheduledTask }).task
}

afterEach(async () => {
  await app?.close()
  app = null
  await mock?.close()
  mock = null
})

describe("scheduled task routes", () => {
  it("creates a task with a computed slot and lists tasks oldest-first", async () => {
    const cookie = await boot()
    const created = await createTask(cookie)
    expect(created).toMatchObject({
      name: "Nightly sweep",
      prompt: "Check the workspace",
      directory: DIRECTORY,
      model: { providerID: "test", id: "test-model" },
      schedule: { kind: "interval", intervalMinutes: 60 },
      timezone: "",
      paused: false,
      lastRunAt: null,
    })
    expect(created.nextRunAt).not.toBeNull()
    expect(new Date(created.nextRunAt!).getTime()).toBeGreaterThan(Date.now())
    expect(created.createdAt).toBeTruthy()

    // An older seeded task sorts before the freshly created one.
    const seeded = seededTask()
    app!.store.createScheduledTask(seeded)
    const list = await fetch(`${app!.url}/api/scheduled-tasks`, { headers: { cookie } })
    expect(list.status).toBe(200)
    const tasks = ((await list.json()) as { tasks: ScheduledTask[] }).tasks
    expect(tasks.map((task) => task.id)).toEqual(["task_seeded", created.id])
    // The seeded interval slot is preserved verbatim by the list route.
    expect(tasks[0]!.nextRunAt).toBe(seeded.nextRunAt)
  })

  it("maps every validation failure to its typed 400 code", async () => {
    const cookie = await boot()
    const cases: Array<[string, unknown]> = [
      ["invalid_task", []],
      ["invalid_task", "not-an-object"],
      ["invalid_name", taskInput({ name: "   " })],
      ["invalid_name", taskInput({ name: "n".repeat(201) })],
      ["invalid_prompt", taskInput({ prompt: "" })],
      ["invalid_prompt", taskInput({ prompt: "p".repeat(8001) })],
      ["invalid_schedule", taskInput({ schedule: null })],
      ["invalid_schedule", taskInput({ schedule: undefined })],
      ["invalid_schedule_kind", taskInput({ schedule: { kind: "weekly" } })],
      ["invalid_interval", taskInput({ schedule: { kind: "interval", intervalMinutes: 4 } })],
      ["invalid_interval", taskInput({ schedule: { kind: "interval" } })],
      ["invalid_cron", taskInput({ schedule: { kind: "cron", cron: "banana" } })],
      ["invalid_frequency", taskInput({ schedule: { kind: "cron", cron: "* * * * *" } })],
      ["invalid_timezone", taskInput({ schedule: { kind: "cron", cron: "0 9 * * *" }, timezone: "Mars/Base" })],
      ["invalid_directory", taskInput({ directory: "/e2e/unknown-workspace" })],
      ["invalid_model", taskInput({ model: { providerID: "test", id: "unknown-model" } })],
      ["invalid_model", taskInput({ model: "test/test-model" })],
    ]
    for (const [code, input] of cases) {
      const response = await fetch(`${app!.url}/api/scheduled-tasks`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify(input),
      })
      expect(response.status, code).toBe(400)
      const body = (await response.json()) as { error: string; detail?: string }
      expect(body.error, code).toBe(code)
      expect(body.detail, code).toBeTruthy()
    }
    // Nothing was persisted along the way.
    expect(app!.store.listScheduledTasks()).toHaveLength(0)
  })

  it("enforces the name and prompt limits on PATCH too", async () => {
    const cookie = await boot()
    const created = await createTask(cookie)
    const cases: Array<[string, Record<string, unknown>]> = [
      ["invalid_name", { name: "n".repeat(201) }],
      ["invalid_prompt", { prompt: "p".repeat(8001) }],
    ]
    for (const [code, patch] of cases) {
      const response = await fetch(`${app!.url}/api/scheduled-tasks/${created.id}`, {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify(patch),
      })
      expect(response.status, code).toBe(400)
      expect(((await response.json()) as { error: string }).error, code).toBe(code)
    }
    // The rejected patches never touched the stored task.
    expect(app!.store.getScheduledTask(created.id)).toMatchObject({
      name: created.name,
      prompt: created.prompt,
    })
  })

  it("rejects a malformed body and a broken model catalog answer", async () => {
    const cookie = await boot()
    // Malformed JSON bodies are rejected before any validation runs.
    const posted = await fetch(`${app!.url}/api/scheduled-tasks`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{not json",
    })
    expect(posted.status).toBe(400)
    expect(((await posted.json()) as { error: string }).error).toBe("invalid_body")

    const created = await createTask(cookie)
    const patched = await fetch(`${app!.url}/api/scheduled-tasks/${created.id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: "{not json",
    })
    expect(patched.status).toBe(400)
    expect(((await patched.json()) as { error: string }).error).toBe("invalid_body")

    // The upstream failure of the model check is not a validation error.
    mock!.failNext("/api/model", 99, 503)
    const response = await fetch(`${app!.url}/api/scheduled-tasks`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(taskInput()),
    })
    expect(response.status).toBe(502)
    expect(((await response.json()) as { error: string }).error).toBe("scheduler_failed")
  })

  it("answers task_not_found for every task-scoped route", async () => {    const cookie = await boot()
    const base = `${app!.url}/api/scheduled-tasks/task_unknown`
    const patch = await fetch(base, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    })
    expect(patch.status).toBe(404)
    const remove = await fetch(base, { method: "DELETE", headers: { cookie } })
    expect(remove.status).toBe(404)
    const run = await fetch(`${base}/run`, { method: "POST", headers: { cookie } })
    expect(run.status).toBe(404)
    const runs = await fetch(`${base}/runs`, { headers: { cookie } })
    expect(runs.status).toBe(404)
    for (const response of [patch, remove, run, runs]) {
      expect(((await response.json()) as { error: string }).error).toBe("task_not_found")
    }
  })

  it("patches fields, pauses and resumes through the manager", async () => {
    const cookie = await boot()
    const created = await createTask(cookie)

    const renamed = await fetch(`${app!.url}/api/scheduled-tasks/${created.id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Renamed sweep", model: { providerID: "test", id: "critic-model" } }),
    })
    expect(renamed.status).toBe(200)
    const renamedTask = ((await renamed.json()) as { task: ScheduledTask }).task
    expect(renamedTask.name).toBe("Renamed sweep")
    expect(renamedTask.model).toEqual({ providerID: "test", id: "critic-model" })

    const rescheduled = await fetch(`${app!.url}/api/scheduled-tasks/${created.id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ schedule: { kind: "cron", cron: "*/10 * * * *" }, timezone: "Europe/Madrid" }),
    })
    expect(rescheduled.status).toBe(200)
    const rescheduledTask = ((await rescheduled.json()) as { task: ScheduledTask }).task
    expect(rescheduledTask.schedule).toEqual({ kind: "cron", cron: "*/10 * * * *" })
    expect(rescheduledTask.timezone).toBe("Europe/Madrid")
    // The slot is re-armed from the change, not kept from the interval spec.
    expect(rescheduledTask.nextRunAt).not.toBe(created.nextRunAt)
    expect(new Date(rescheduledTask.nextRunAt!).getTime()).toBeGreaterThan(Date.now())

    const patchValidations: Array<[string, Record<string, unknown>]> = [
      ["invalid_body", {}],
      ["invalid_paused", { paused: "yes" }],
      ["invalid_timezone", { timezone: 42 }],
      ["invalid_timezone", { timezone: "Mars/Base" }],
      ["invalid_interval", { schedule: { kind: "interval", intervalMinutes: 2 } }],
      ["invalid_model", { model: { providerID: "test", id: "unknown-model" } }],
      ["invalid_directory", { directory: "/e2e/unknown-workspace" }],
    ]
    for (const [code, patch] of patchValidations) {
      const response = await fetch(`${app!.url}/api/scheduled-tasks/${created.id}`, {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify(patch),
      })
      expect(response.status, code).toBe(400)
      expect(((await response.json()) as { error: string }).error, code).toBe(code)
    }

    let response = await fetch(`${app!.url}/api/scheduled-tasks/${created.id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ paused: true }),
    })
    expect(((await response.json()) as { task: ScheduledTask }).task.paused).toBe(true)

    // A paused task refuses a manual run instead of queueing it.
    response = await fetch(`${app!.url}/api/scheduled-tasks/${created.id}/run`, {
      method: "POST",
      headers: { cookie },
    })
    expect(response.status).toBe(409)
    expect(((await response.json()) as { error: string }).error).toBe("task_paused")

    response = await fetch(`${app!.url}/api/scheduled-tasks/${created.id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ paused: false }),
    })
    const resumedTask = ((await response.json()) as { task: ScheduledTask }).task
    expect(resumedTask.paused).toBe(false)
    expect(new Date(resumedTask.nextRunAt!).getTime()).toBeGreaterThan(Date.now())
  })

  it("deletes a task with its run history", async () => {
    const cookie = await boot()
    const created = await createTask(cookie)
    app!.store.createScheduledRun(seededRun(created.id, 0))
    app!.store.createScheduledRun(seededRun(created.id, 1))

    const removed = await fetch(`${app!.url}/api/scheduled-tasks/${created.id}`, {
      method: "DELETE",
      headers: { cookie },
    })
    expect(removed.status).toBe(204)
    expect(await removed.text()).toBe("")
    expect(app!.store.listScheduledTasks()).toHaveLength(0)
    // The run history cascades with the task.
    expect(app!.store.listScheduledRuns(created.id)).toHaveLength(0)

    // Deleting again is a 404, not a silent 204.
    const again = await fetch(`${app!.url}/api/scheduled-tasks/${created.id}`, {
      method: "DELETE",
      headers: { cookie },
    })
    expect(again.status).toBe(404)
  })

  it("runs a task now and settles the run when the turn ends", async () => {
    const cookie = await boot()
    const created = await createTask(cookie)

    const started = await fetch(`${app!.url}/api/scheduled-tasks/${created.id}/run`, {
      method: "POST",
      headers: { cookie },
    })
    expect(started.status).toBe(202)
    const task = ((await started.json()) as { task: ScheduledTask }).task
    expect(task.lastRunAt).toBeTruthy()

    // One run, one session: create → model pin → prompt, markers included.
    const runs = app!.store.listScheduledRuns(created.id)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ taskId: created.id, status: "running", source: "manual", error: null })
    const run = runs[0]!
    expect(run.sessionID).toBeTruthy()

    const createRequest = mock!.requests.find(
      (request) => request.method === "POST" && request.path === "/api/session",
    )
    expect(createRequest).toBeTruthy()
    const createBody = JSON.parse(createRequest!.body!) as {
      location: { directory: string }
      title: string
      metadata: Record<string, unknown>
    }
    expect(createBody.location).toEqual({ directory: DIRECTORY })
    expect(createBody.title).toBe(created.name)
    expect(createBody.metadata["masterhand.scheduler"]).toBe(`${created.id}#${run.id}#create`)

    const pinRequest = mock!.requests.find(
      (request) => request.method === "POST" && request.path.endsWith("/model"),
    )
    expect(pinRequest).toBeTruthy()
    expect(JSON.parse(pinRequest!.body!)).toEqual({ model: { providerID: "test", id: "test-model" } })

    const promptRequest = mock!.requests.find(
      (request) => request.method === "POST" && request.path.endsWith("/prompt"),
    )
    expect(promptRequest).toBeTruthy()
    const promptBody = JSON.parse(promptRequest!.body!) as { text: string; metadata: Record<string, unknown> }
    expect(promptBody.text).toBe(created.prompt)
    expect(promptBody.metadata["masterhand.scheduler"]).toBe(`${created.id}#${run.id}#prompt`)

    // The turn ends → the run completes without any MasterHand action.
    mock!.emit({ type: "session.idle", data: { sessionID: run.sessionID } })
    await waitFor(() => app!.store.listScheduledRuns(created.id)[0]!.status === "completed")
    expect(app!.store.listScheduledRuns(created.id)[0]!.endedAt).toBeTruthy()
  })

  it("coalesces a second run-now into one queued envelope that fires later", async () => {
    const cookie = await boot()
    const created = await createTask(cookie)

    await fetch(`${app!.url}/api/scheduled-tasks/${created.id}/run`, { method: "POST", headers: { cookie } })
    const second = await fetch(`${app!.url}/api/scheduled-tasks/${created.id}/run`, {
      method: "POST",
      headers: { cookie },
    })
    expect(second.status).toBe(202)

    // The first run is still running: the manual start became one queued
    // envelope, never a parallel fire.
    const active = app!.store.listScheduledRuns(created.id)
    expect(active).toHaveLength(2)
    const queued = active.find((run) => run.status === "queued")
    expect(queued).toMatchObject({ taskId: created.id, source: "manual", sessionID: null })

    const prompts = (): number =>
      mock!.requests.filter((request) => request.method === "POST" && request.path.endsWith("/prompt")).length
    expect(prompts()).toBe(1)

    // Ending the turn fires the queued envelope as its own session.
    const first = app!.store.listScheduledRuns(created.id).find((run) => run.sessionID !== null)
    mock!.emit({ type: "session.idle", data: { sessionID: first!.sessionID } })
    await waitFor(() => prompts() >= 2)
    const allPrompts = mock!.requests.filter(
      (request) => request.method === "POST" && request.path.endsWith("/prompt"),
    )
    expect(allPrompts).toHaveLength(2)
    const secondSessionID = allPrompts[1]!.path.split("/")[3]
    expect(secondSessionID).not.toBe(first!.sessionID)
    mock!.emit({ type: "session.idle", data: { sessionID: secondSessionID } })
    await waitFor(() =>
      app!.store.listScheduledRuns(created.id).every((run) => run.status === "completed"),
    )
    expect(prompts()).toBe(2)
  })

  it("lists run history newest-first capped at 50", async () => {
    const cookie = await boot()
    const created = await createTask(cookie)
    for (let index = 0; index < 55; index += 1) {
      app!.store.createScheduledRun(seededRun(created.id, index))
    }
    const response = await fetch(`${app!.url}/api/scheduled-tasks/${created.id}/runs`, {
      headers: { cookie },
    })
    expect(response.status).toBe(200)
    const runs = ((await response.json()) as { runs: ScheduledRun[] }).runs
    expect(runs).toHaveLength(50)
    // Newest first, capped: run_54 is the latest of the 55 seeded.
    expect(runs[0]!.id).toBe("run_54")
    expect(runs[0]).toMatchObject({ taskId: created.id, sessionID: "ses_run_54", status: "completed" })
    expect(new Date(Date.parse(runs[0]!.startedAt)).getTime()).toBeGreaterThan(Date.parse(runs[49]!.startedAt))
    expect(runs[49]!.id).toBe("run_5")
  })

  it("broadcasts a scheduler.updated frame on create, patch and delete", async () => {
    const cookie = await boot()
    const subset = (frames: string): string[] =>
      frames.split("\n").filter((line) => line.includes('"type":"scheduler.updated"'))
    /** Lets the SSE subscription attach before the mutation lands. */
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 100))

    const createStream = await fetch(`${app!.url}/api/events`, { headers: { cookie } })
    expect(createStream.ok).toBe(true)
    const createReader = createStream.body!.getReader()
    await settle()
    const created = await createTask(cookie)
    const createFrames = subset(await readUntil(createReader, "scheduler.updated"))
    expect(createFrames).toHaveLength(1)
    expect(createFrames[0]).toBe(`data: {"type":"scheduler.updated","data":{"taskID":"${created.id}"}}`)

    const patchStream = await fetch(`${app!.url}/api/events`, { headers: { cookie } })
    expect(patchStream.ok).toBe(true)
    const patchReader = patchStream.body!.getReader()
    await settle()
    await fetch(`${app!.url}/api/scheduled-tasks/${created.id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Frame test" }),
    })
    const patchFrames = subset(await readUntil(patchReader, "scheduler.updated"))
    expect(patchFrames).toEqual([`data: {"type":"scheduler.updated","data":{"taskID":"${created.id}"}}`])
    expect(patchFrames).toEqual(createFrames)

    const deleteStream = await fetch(`${app!.url}/api/events`, { headers: { cookie } })
    expect(deleteStream.ok).toBe(true)
    const deleteReader = deleteStream.body!.getReader()
    await settle()
    await fetch(`${app!.url}/api/scheduled-tasks/${created.id}`, { method: "DELETE", headers: { cookie } })
    const deleteFrames = subset(await readUntil(deleteReader, "scheduler.updated"))
    expect(deleteFrames).toEqual([`data: {"type":"scheduler.updated","data":{"taskID":"${created.id}"}}`])
  })

  it("requires authentication on every scheduler endpoint", async () => {
    await boot()
    const base = app!.url
    const probes: Array<() => Promise<Response>> = [
      () => fetch(`${base}/api/scheduled-tasks`),
      () =>
        fetch(`${base}/api/scheduled-tasks`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(taskInput()),
        }),
      () =>
        fetch(`${base}/api/scheduled-tasks/task_x`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
      () => fetch(`${base}/api/scheduled-tasks/task_x`, { method: "DELETE" }),
      () => fetch(`${base}/api/scheduled-tasks/task_x/run`, { method: "POST" }),
      () => fetch(`${base}/api/scheduled-tasks/task_x/runs`),
    ]
    for (const probe of probes) {
      const response = await probe()
      expect(response.status).toBe(401)
    }
  })
})
