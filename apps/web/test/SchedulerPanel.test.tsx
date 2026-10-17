// @vitest-environment jsdom
import { createElement, type ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, waitFor, within, type RenderResult } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  ApiError,
  type ModelInfo,
  type ModelsCatalog,
  type ScheduledRun,
  type ScheduledTask,
  type WorkspaceRecord,
} from "@masterhand/client-core"
import { SchedulerPanel } from "../src/components/SchedulerPanel"

/**
 * Render tests for the Scheduler panel. The app singleton (`src/client`) is
 * replaced with a scripted client: the panel only reaches the scheduler api,
 * the model catalog and the workspace list through it.
 */

afterEach(cleanup)

/** The scheduler api surface, mocked for the whole file (hoisted for vi.mock). */
const schedulerApi = vi.hoisted(() => ({
  list: vi.fn(() => Promise.resolve([] as ScheduledTask[])),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  runNow: vi.fn(),
  runs: vi.fn(() => Promise.resolve([] as ScheduledRun[])),
}))
/** Side queries the task dialog needs when it opens. */
const dialogApi = vi.hoisted(() => ({
  models: vi.fn(),
  workspaces: vi.fn(),
}))

vi.mock("../src/client", () => ({
  client: {
    api: { scheduler: schedulerApi, models: dialogApi.models },
    workspaces: { list: dialogApi.workspaces },
  },
}))

function scheduledTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "st_1",
    name: "Nightly sweep",
    prompt: "Inspect the failing checks",
    model: { providerID: "anthropic", id: "claude" },
    schedule: { kind: "interval", intervalMinutes: 15 },
    timezone: "UTC",
    directory: "/workspace/app",
    paused: false,
    lastRunAt: "2026-10-16T10:00:00.000Z",
    nextRunAt: "2026-10-17T10:00:00.000Z",
    createdAt: "2026-10-15T10:00:00.000Z",
    ...overrides,
  }
}

function scheduledRun(overrides: Partial<ScheduledRun> = {}): ScheduledRun {
  return {
    id: "run_1",
    taskId: "st_1",
    sessionID: "ses_1",
    status: "completed",
    source: "schedule",
    error: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    ...overrides,
  }
}

function modelCatalog(): ModelsCatalog {
  return {
    models: [{ providerID: "anthropic", id: "claude", name: "Claude", variants: [] } as unknown as ModelInfo],
    providers: [{ id: "anthropic", name: "Anthropic" } as unknown as ModelsCatalog["providers"][number]],
    defaultModel: null,
  }
}

const workspaces: WorkspaceRecord[] = [
  { id: "wk_1", name: "App", path: "/workspace/app", createdAt: 0 },
  { id: "wk_2", name: "Docs", path: "/workspace/docs", createdAt: 0 },
]

function renderPanel(onOpenSession: (sessionID: string) => void = () => {}): RenderResult {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children)
  }
  return render(createElement(SchedulerPanel, { onOpenSession }), { wrapper: Wrapper })
}

beforeEach(() => {
  schedulerApi.list.mockReset().mockResolvedValue([])
  schedulerApi.runs.mockReset().mockResolvedValue([])
  schedulerApi.create.mockReset()
  schedulerApi.update.mockReset()
  schedulerApi.remove.mockReset()
  schedulerApi.runNow.mockReset()
  dialogApi.models.mockReset()
  dialogApi.workspaces.mockReset()
})

describe("SchedulerPanel", () => {
  it("renders an active and a paused task with their schedule and status text", async () => {
    schedulerApi.list.mockResolvedValue([
      scheduledTask(),
      scheduledTask({
        id: "st_2",
        name: "Weekly report",
        paused: true,
        schedule: { kind: "cron", cron: "0 0 * * 1" },
        timezone: "Europe/Berlin",
        model: { providerID: "openai", id: "gpt" },
        lastRunAt: null,
        nextRunAt: null,
      }),
    ])
    const view = renderPanel()

    await view.findByText("Nightly sweep")
    await view.findByText("Weekly report")
    // Status chips.
    expect(view.getByText("Active", { selector: ".mh-chip" })).toBeTruthy()
    expect(view.getByText("Paused", { selector: ".mh-chip" })).toBeTruthy()
    // Schedule lines: preset interval and cron, with their timezone fallbacks.
    expect(view.getByText(/Every 15 min · UTC/)).toBeTruthy()
    expect(view.getByText(/Cron 0 0 \* \* 1 · Europe\/Berlin/)).toBeTruthy()
    // Run times formatted in the schedule zone.
    expect(view.getByText(/Last Oct 16/)).toBeTruthy()
    expect(view.getByText(/Next Oct 17/)).toBeTruthy()
    // Never-run task shows the fallback text.
    expect(view.getByText("Never run")).toBeTruthy()
  })

  it("shows the empty state when there are no tasks", async () => {
    const view = renderPanel()
    await view.findByText(/No scheduled tasks yet/)
    // The header affordance stays available while the list is empty.
    expect(view.getByRole("button", { name: "New task" })).toBeTruthy()
  })

  it("keeps run history unfetched until a task is expanded, then lists its runs", async () => {
    schedulerApi.list.mockResolvedValue([scheduledTask()])
    schedulerApi.runs.mockResolvedValue([
      scheduledRun({
        id: "run_failed",
        status: "failed",
        source: "manual",
        sessionID: null,
        error: "The model rejected the prompt",
      }),
      scheduledRun(),
    ])
    const view = renderPanel()
    await view.findByText("Nightly sweep")
    // Lazy history: nothing fetches while every task row is collapsed.
    expect(schedulerApi.runs).not.toHaveBeenCalled()

    fireEvent.click(view.getByRole("button", { name: /Run history/ }))
    await waitFor(() => expect(schedulerApi.runs).toHaveBeenCalledWith("st_1"))
    const history = await view.findByRole("list")
    // The failed run lists its status, error text and Manual badge; the
    // completed scheduled run lists its badge too.
    expect(within(history).getByText("Failed")).toBeTruthy()
    expect(within(history).getByText("The model rejected the prompt")).toBeTruthy()
    expect(within(history).getByText("Manual")).toBeTruthy()
    expect(within(history).getByText("Scheduled")).toBeTruthy()
  })

  it("validates the create dialog locally, then submits a well-formed task", async () => {
    dialogApi.models.mockResolvedValue(modelCatalog())
    dialogApi.workspaces.mockResolvedValue(workspaces)
    schedulerApi.create.mockResolvedValue(scheduledTask())
    const view = renderPanel()

    fireEvent.click(view.getByRole("button", { name: "New task" }))
    const dialog = await view.findByRole("dialog")

    // Empty submission validates locally: no request at all.
    fireEvent.click(within(dialog).getByRole("button", { name: "Create task" }))
    await view.findByText("Give the task a name.")
    expect(schedulerApi.create).not.toHaveBeenCalled()

    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Hourly sweep" } })
    fireEvent.click(within(dialog).getByRole("button", { name: "Create task" }))
    await view.findByText("Write the prompt to run.")
    expect(schedulerApi.create).not.toHaveBeenCalled()

    // Pick the model and the workspace through the search selects.
    fireEvent.click(within(dialog).getByRole("button", { name: "Model" }))
    fireEvent.click(within(dialog).getByRole("option", { name: "Anthropic · Claude" }))
    fireEvent.click(within(dialog).getByRole("button", { name: "Workspace" }))
    fireEvent.click(within(dialog).getByRole("option", { name: "Docs" }))
    fireEvent.change(within(dialog).getByLabelText("Prompt"), { target: { value: "Check the boards" } })

    // Custom cron: an invalid expression still stops the submit.
    fireEvent.click(within(dialog).getByRole("button", { name: "Schedule" }))
    fireEvent.click(within(dialog).getByText("Show all 8 schedules"))
    fireEvent.click(within(dialog).getByText("Custom cron…"))
    fireEvent.change(within(dialog).getByLabelText("Custom cron expression"), {
      target: { value: "banana" },
    })
    fireEvent.click(within(dialog).getByRole("button", { name: "Create task" }))
    await view.findByText(/Use a 5-field cron expression/)
    expect(schedulerApi.create).not.toHaveBeenCalled()

    // Switch to the Hourly cron preset and submit.
    fireEvent.click(within(dialog).getByRole("button", { name: "Schedule" }))
    fireEvent.click(within(dialog).getByText("Hourly"))
    fireEvent.click(within(dialog).getByRole("button", { name: "Create task" }))
    await waitFor(() =>
      expect(schedulerApi.create).toHaveBeenCalledWith({
        name: "Hourly sweep",
        prompt: "Check the boards",
        model: { providerID: "anthropic", id: "claude" },
        schedule: { kind: "cron", cron: "0 * * * *" },
        timezone: undefined,
        directory: "/workspace/docs",
      }),
    )
  })

  it("fires run-now with the task id and deletes through the confirm dialog", async () => {
    schedulerApi.list.mockResolvedValue([scheduledTask()])
    schedulerApi.runNow.mockResolvedValue(scheduledTask())
    schedulerApi.remove.mockResolvedValue(undefined)
    const view = renderPanel()
    await view.findByText("Nightly sweep")

    fireEvent.click(view.getByRole("button", { name: /Run now/ }))
    await waitFor(() => expect(schedulerApi.runNow).toHaveBeenCalledWith("st_1"))

    // Delete goes through the destructive confirm first.
    fireEvent.click(view.getByRole("button", { name: "Delete Nightly sweep" }))
    await view.findByText(/run history is removed with it/)
    fireEvent.click(view.getByRole("button", { name: "Delete" }))
    await waitFor(() => expect(schedulerApi.remove).toHaveBeenCalledWith("st_1"))
  })

  it("opens a run's created session from the expanded history", async () => {
    schedulerApi.list.mockResolvedValue([scheduledTask()])
    schedulerApi.runs.mockResolvedValue([scheduledRun()])
    const onOpenSession = vi.fn()
    const view = renderPanel(onOpenSession)
    await view.findByText("Nightly sweep")

    fireEvent.click(view.getByRole("button", { name: /Run history/ }))
    fireEvent.click(await view.findByRole("button", { name: "Open session" }))
    await waitFor(() => expect(onOpenSession).toHaveBeenCalledWith("ses_1"))
  })

  it("keeps the failure readable when the run history cannot load", async () => {
    schedulerApi.list.mockResolvedValue([scheduledTask()])
    schedulerApi.runs.mockRejectedValue(new Error("boom"))
    const view = renderPanel()
    await view.findByText("Nightly sweep")

    fireEvent.click(view.getByRole("button", { name: /Run history/ }))
    await view.findByText("Could not load the run history.")
  })

  it("pauses a task through the update hook", async () => {
    schedulerApi.list.mockResolvedValue([scheduledTask()])
    schedulerApi.update.mockResolvedValue(scheduledTask({ paused: true }))
    const view = renderPanel()
    await view.findByText("Nightly sweep")

    fireEvent.click(view.getByRole("button", { name: /Pause/ }))
    await waitFor(() => expect(schedulerApi.update).toHaveBeenCalledWith("st_1", { paused: true }))
  })

  it("edits a task pre-filled and submits a full-field patch", async () => {
    schedulerApi.list.mockResolvedValue([scheduledTask()])
    schedulerApi.update.mockResolvedValue(scheduledTask())
    dialogApi.models.mockResolvedValue(modelCatalog())
    dialogApi.workspaces.mockResolvedValue(workspaces)
    const view = renderPanel()
    await view.findByText("Nightly sweep")

    fireEvent.click(view.getByRole("button", { name: /Edit/ }))
    const dialog = await view.findByRole("dialog")
    expect((within(dialog).getByLabelText("Name") as HTMLInputElement).value).toBe("Nightly sweep")
    expect((within(dialog).getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe(
      "Inspect the failing checks",
    )
    // The model, workspace, schedule and timezone picks load, then pre-fill.
    await waitFor(() => {
      expect(within(dialog).getByRole("button", { name: "Model" }).textContent).toContain("Claude")
      expect(within(dialog).getByRole("button", { name: "Workspace" }).textContent).toContain("App")
    })
    expect(within(dialog).getByRole("button", { name: "Schedule" }).textContent).toContain("Every 15 min")
    expect(within(dialog).getByRole("button", { name: "Timezone" }).textContent).toContain("UTC")

    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Nightly sweep v2" } })
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }))
    await waitFor(() =>
      expect(schedulerApi.update).toHaveBeenCalledWith("st_1", {
        name: "Nightly sweep v2",
        prompt: "Inspect the failing checks",
        model: { providerID: "anthropic", id: "claude" },
        schedule: { kind: "interval", intervalMinutes: 15 },
        timezone: "UTC",
        directory: "/workspace/app",
      }),
    )
  })

  it("rejects a custom interval below five minutes and accepts ten", async () => {
    dialogApi.models.mockResolvedValue(modelCatalog())
    dialogApi.workspaces.mockResolvedValue(workspaces)
    schedulerApi.create.mockResolvedValue(scheduledTask())
    const view = renderPanel()

    fireEvent.click(view.getByRole("button", { name: "New task" }))
    const dialog = await view.findByRole("dialog")
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Quick check" } })
    fireEvent.change(within(dialog).getByLabelText("Prompt"), { target: { value: "Check things" } })
    fireEvent.click(within(dialog).getByRole("button", { name: "Model" }))
    fireEvent.click(within(dialog).getByRole("option", { name: "Anthropic · Claude" }))
    fireEvent.click(within(dialog).getByRole("button", { name: "Workspace" }))
    fireEvent.click(within(dialog).getByRole("option", { name: "App" }))

    fireEvent.click(within(dialog).getByRole("button", { name: "Schedule" }))
    fireEvent.click(within(dialog).getByText("Custom minutes…"))
    fireEvent.change(within(dialog).getByLabelText("Custom interval in minutes"), {
      target: { value: "3" },
    })
    fireEvent.click(within(dialog).getByRole("button", { name: "Create task" }))
    await view.findByText("The interval must be a whole number of at least 5 minutes.")
    expect(schedulerApi.create).not.toHaveBeenCalled()

    fireEvent.change(within(dialog).getByLabelText("Custom interval in minutes"), {
      target: { value: "10" },
    })
    fireEvent.click(within(dialog).getByRole("button", { name: "Create task" }))
    await waitFor(() =>
      expect(schedulerApi.create).toHaveBeenCalledWith({
        name: "Quick check",
        prompt: "Check things",
        model: { providerID: "anthropic", id: "claude" },
        schedule: { kind: "interval", intervalMinutes: 10 },
        timezone: undefined,
        directory: "/workspace/app",
      }),
    )
  })

  it("surfaces the server error copy when a run-now is rejected", async () => {
    schedulerApi.list.mockResolvedValue([scheduledTask()])
    schedulerApi.runNow.mockRejectedValue(
      new ApiError(409, JSON.stringify({ error: "task_paused" })),
    )
    const view = renderPanel()
    await view.findByText("Nightly sweep")

    fireEvent.click(view.getByRole("button", { name: /Run now/ }))
    await view.findByText("Paused tasks can't run.")
  })
})
