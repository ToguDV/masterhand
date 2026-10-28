/**
 * @vitest-environment jsdom
 */
import { createElement, type ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiError, type Client } from "../src/client"
import {
  createEventHandler,
  invalidateOnReconnect,
  queryKeys,
  useCreateScheduledTask,
  useDeleteScheduledTask,
  useRunScheduledTaskNow,
  useScheduledTaskRuns,
  useScheduledTasks,
  useUpdateScheduledTask,
} from "../src/hooks"
import type { ScheduledTask } from "../src/scheduler"

afterEach(cleanup)

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

function makeSchedulerClient() {
  const scheduler = {
    list: vi.fn(async () => [scheduledTask()]),
    create: vi.fn(async () => scheduledTask({ id: "st_new" })),
    update: vi.fn(async () => scheduledTask({ paused: true })),
    remove: vi.fn(async () => undefined),
    runNow: vi.fn(async () => scheduledTask({ lastRunAt: "2026-10-16T12:00:00.000Z" })),
    runs: vi.fn(async () => []),
  }
  const client = { baseUrl: "", api: { scheduler } } as unknown as Client
  return { client, scheduler }
}

function wrapper(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children)
}

function newQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

describe("scheduler queries", () => {
  it("useScheduledTasks fetches the task list, lazily when disabled", async () => {
    const qc = newQueryClient()
    const { client, scheduler } = makeSchedulerClient()

    const disabled = renderHook(() => useScheduledTasks(client, false), { wrapper: wrapper(qc) })
    expect(disabled.result.current.fetchStatus).toBe("idle")
    expect(scheduler.list).not.toHaveBeenCalled()

    const enabled = renderHook(() => useScheduledTasks(client), { wrapper: wrapper(qc) })
    await waitFor(() => expect(enabled.result.current.isSuccess).toBe(true))
    expect(scheduler.list).toHaveBeenCalledTimes(1)
    expect(enabled.result.current.data).toEqual([scheduledTask()])
  })

  it("useScheduledTaskRuns stays idle without a task and fetches its history with one", async () => {
    const qc = newQueryClient()
    const { client, scheduler } = makeSchedulerClient()

    const disabled = renderHook(() => useScheduledTaskRuns(client, null), { wrapper: wrapper(qc) })
    expect(disabled.result.current.fetchStatus).toBe("idle")
    expect(scheduler.runs).not.toHaveBeenCalled()

    const enabled = renderHook(() => useScheduledTaskRuns(client, "st_1"), { wrapper: wrapper(qc) })
    await waitFor(() => expect(enabled.result.current.isSuccess).toBe(true))
    expect(scheduler.runs).toHaveBeenCalledWith("st_1")
  })

  it("useScheduledTaskRuns passes pagination through with a per-page cache key", async () => {
    const qc = newQueryClient()
    const { client, scheduler } = makeSchedulerClient()

    const paged = renderHook(() => useScheduledTaskRuns(client, "st_1", true, { limit: 2, offset: 1 }), {
      wrapper: wrapper(qc),
    })
    await waitFor(() => expect(paged.result.current.isSuccess).toBe(true))
    expect(scheduler.runs).toHaveBeenCalledWith("st_1", { limit: 2, offset: 1 })
    expect(qc.getQueryData(queryKeys.schedulerRuns("st_1"))).toBeUndefined()
  })
})

describe("scheduler mutations", () => {
  it("create posts the input and invalidates the task list", async () => {
    const qc = newQueryClient()
    const { client, scheduler } = makeSchedulerClient()
    const invalidate = vi.spyOn(qc, "invalidateQueries")

    const mutation = renderHook(() => useCreateScheduledTask(client), { wrapper: wrapper(qc) })
    const input = {
      name: "Sweep",
      prompt: "Check",
      model: { providerID: "anthropic", id: "claude" },
      schedule: { kind: "interval" as const, intervalMinutes: 30 },
      directory: "/workspace/app",
    }
    mutation.result.current.mutate(input)
    await waitFor(() => expect(mutation.result.current.isSuccess).toBe(true))

    expect(scheduler.create).toHaveBeenCalledWith(input)
    expect(mutation.result.current.data).toEqual(scheduledTask({ id: "st_new" }))
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.scheduler })
  })

  it("update patches the task and invalidates the task list", async () => {
    const qc = newQueryClient()
    const { client, scheduler } = makeSchedulerClient()
    const invalidate = vi.spyOn(qc, "invalidateQueries")

    const mutation = renderHook(() => useUpdateScheduledTask(client), { wrapper: wrapper(qc) })
    mutation.result.current.mutate({ id: "st_1", patch: { paused: true } })
    await waitFor(() => expect(mutation.result.current.isSuccess).toBe(true))

    expect(scheduler.update).toHaveBeenCalledWith("st_1", { paused: true })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.scheduler })
  })

  it("delete removes the task, invalidates the list and drops the ghost run history", async () => {
    const qc = newQueryClient()
    const { client, scheduler } = makeSchedulerClient()
    const invalidate = vi.spyOn(qc, "invalidateQueries")
    const removeQueries = vi.spyOn(qc, "removeQueries")
    qc.setQueryData(queryKeys.schedulerRuns("st_1"), [])

    const mutation = renderHook(() => useDeleteScheduledTask(client), { wrapper: wrapper(qc) })
    mutation.result.current.mutate("st_1")
    await waitFor(() => expect(mutation.result.current.isSuccess).toBe(true))

    expect(scheduler.remove).toHaveBeenCalledWith("st_1")
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.scheduler })
    expect(removeQueries).toHaveBeenCalledWith({ queryKey: queryKeys.schedulerRuns("st_1") })
    expect(qc.getQueryData(queryKeys.schedulerRuns("st_1"))).toBeUndefined()
  })

  it("runNow fires the task and invalidates the list plus the fired run's history", async () => {
    const qc = newQueryClient()
    const { client, scheduler } = makeSchedulerClient()
    const invalidate = vi.spyOn(qc, "invalidateQueries")

    const mutation = renderHook(() => useRunScheduledTaskNow(client), { wrapper: wrapper(qc) })
    mutation.result.current.mutate("st_1")
    await waitFor(() => expect(mutation.result.current.isSuccess).toBe(true))

    expect(scheduler.runNow).toHaveBeenCalledWith("st_1")
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.scheduler })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.schedulerRuns("st_1") })
  })

  it("runNow propagates the 409 of a paused task as a typed error", async () => {
    const qc = newQueryClient()
    const { client, scheduler } = makeSchedulerClient()
    const invalidate = vi.spyOn(qc, "invalidateQueries")
    const paused = new ApiError(409, "task is paused")
    scheduler.runNow.mockImplementation(async () => {
      throw paused
    })

    const mutation = renderHook(() => useRunScheduledTaskNow(client), { wrapper: wrapper(qc) })
    mutation.result.current.mutate("st_1")
    await waitFor(() => expect(mutation.result.current.isError).toBe(true))

    expect(mutation.result.current.error).toBe(paused)
    expect(invalidate).not.toHaveBeenCalled()
  })
})

describe("scheduler.updated frames", () => {
  it("invalidates the task list and the targeted run history", () => {
    const qc = newQueryClient()
    const invalidate = vi.spyOn(qc, "invalidateQueries")
    const handler = createEventHandler(qc)

    handler({ type: "scheduler.updated", data: { taskID: "st_1" } })
    expect(invalidate).toHaveBeenCalledTimes(2)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.scheduler })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.schedulerRuns("st_1") })
  })

  it("invalidates only the task list when the frame has no taskId", () => {
    const qc = newQueryClient()
    const invalidate = vi.spyOn(qc, "invalidateQueries")
    const handler = createEventHandler(qc)

    handler({ type: "scheduler.updated" })
    handler({ type: "scheduler.updated", data: { taskID: 42 } })
    // Top-level ids are ignored: payloads ride inside `data` like goal/board.
    handler({ type: "scheduler.updated", taskID: "st_1" })
    expect(invalidate).toHaveBeenCalledTimes(3)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.scheduler })
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: queryKeys.schedulerRuns("st_1") })
  })

  it("ignores frames of other kinds", () => {
    const qc = newQueryClient()
    const invalidate = vi.spyOn(qc, "invalidateQueries")
    createEventHandler(qc)({ type: "scheduler.updatedX", taskId: "st_1" })
    expect(invalidate).not.toHaveBeenCalled()
  })

  it("reconciles both scheduler prefixes on reconnect", () => {
    const qc = newQueryClient()
    const invalidate = vi.spyOn(qc, "invalidateQueries")
    invalidateOnReconnect(qc)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["scheduler"] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["schedulerRuns"] })
  })
})
