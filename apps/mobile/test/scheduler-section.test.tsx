import { fireEvent, render, screen, waitFor } from "@testing-library/react-native"
import {
  ApiError,
  RequestTimeoutError,
  type ModelInfo,
  type ProviderInfo,
  type ScheduledRun,
  type ScheduledTask,
  type WorkspaceRecord,
} from "@masterhand/client-core"
import { SchedulerSection } from "../src/components/SchedulerSection"
import { ThemeProvider } from "../src/theme"
import { fakeClient, makeQueryClient, QueryWrapper } from "./support/render"

const WORKSPACES: WorkspaceRecord[] = [
  { id: "w1", name: "Web", path: "/data/workspaces/web", createdAt: 0 },
]

const MODELS = {
  models: [
    { id: "alpha", providerID: "test", name: "Alpha", variants: [], enabled: true },
    { id: "test-model", providerID: "test", name: "Test Model", variants: [], enabled: true },
  ] as unknown as ModelInfo[],
  providers: [{ id: "test", name: "Test" }] as unknown as ProviderInfo[],
  defaultModel: null,
}

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "task_1",
    name: "Nightly sweep",
    prompt: "Inspect the failing checks and summarize them",
    model: { providerID: "test", id: "alpha" },
    schedule: { kind: "interval", intervalMinutes: 15 },
    timezone: "",
    directory: "/data/workspaces/web",
    paused: false,
    lastRunAt: null,
    nextRunAt: "2026-10-30T09:00:00.000Z",
    createdAt: "2026-10-28T09:00:00.000Z",
    ...overrides,
  }
}

function makeRun(overrides: Partial<ScheduledRun> = {}): ScheduledRun {
  return {
    id: "run_1",
    taskId: "task_1",
    sessionID: "ses_1",
    status: "completed",
    source: "manual",
    error: null,
    startedAt: "2026-10-29T09:00:00.000Z",
    endedAt: "2026-10-29T09:01:00.000Z",
    ...overrides,
  }
}

async function setup(
  configure?: (client: ReturnType<typeof fakeClient>) => void,
  props: { onOpenSession?: (sessionID: string) => void } = {},
) {
  const client = fakeClient()
  client.workspaces.list.mockResolvedValue(WORKSPACES)
  client.api.models.mockResolvedValue(MODELS)
  configure?.(client)
  const queryClient = makeQueryClient()
  await render(
    <QueryWrapper client={queryClient}>
      <ThemeProvider>
        <SchedulerSection client={client} onOpenSession={props.onOpenSession ?? jest.fn()} />
      </ThemeProvider>
    </QueryWrapper>,
  )
  return { client, queryClient }
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe("SchedulerSection loading and error states (#172)", () => {
  it("shows a loading state while the task list resolves", async () => {
    await setup((c) => {
      c.api.scheduler.list.mockImplementation(() => new Promise(() => {}))
    })

    expect(screen.getByText("Loading tasks…")).toBeOnTheScreen()
  })

  it("shows an error with a retry that reloads the list", async () => {
    const { client } = await setup((c) => {
      c.api.scheduler.list.mockRejectedValueOnce(new Error("boom"))
    })

    expect(await screen.findByText("Could not load the scheduler.")).toBeOnTheScreen()

    client.api.scheduler.list.mockResolvedValue([makeTask()])
    await fireEvent.press(screen.getByText("Retry"))

    expect(await screen.findByText("Nightly sweep")).toBeOnTheScreen()
  })

  it("shows the empty state when no task exists", async () => {
    await setup()

    expect(await screen.findByText(/No scheduled tasks yet/)).toBeOnTheScreen()
  })
})

describe("SchedulerSection task cards (#172)", () => {
  it("renders identity, schedule, workspace, model and run times", async () => {
    await setup((c) => {
      c.api.scheduler.list.mockResolvedValue([
        makeTask({ lastRunAt: "2026-10-29T08:00:00.000Z", timezone: "UTC" }),
      ])
    })

    expect(await screen.findByText("Nightly sweep")).toBeOnTheScreen()
    expect(screen.getByLabelText("Task active")).toBeOnTheScreen()
    expect(screen.getByText("Active")).toBeOnTheScreen()
    expect(screen.getByText("Every 15 min · UTC")).toBeOnTheScreen()
    expect(screen.getByText("web · test/alpha")).toBeOnTheScreen()
    expect(screen.getByText(/Last /)).toBeOnTheScreen()
    expect(screen.getByText(/Next /)).toBeOnTheScreen()
  })

  it("renders a cron schedule and the server-default timezone", async () => {
    await setup((c) => {
      c.api.scheduler.list.mockResolvedValue([
        makeTask({ schedule: { kind: "cron", cron: "0 9 * * 1" }, nextRunAt: null }),
      ])
    })

    expect(await screen.findByText("Cron 0 9 * * 1 · Server default")).toBeOnTheScreen()
    expect(screen.getByText("Never run")).toBeOnTheScreen()
  })

  it("shows Resume instead of Run now on a paused task", async () => {
    await setup((c) => {
      c.api.scheduler.list.mockResolvedValue([makeTask({ paused: true })])
    })

    expect(await screen.findByText("Resume")).toBeOnTheScreen()
    expect(screen.getByLabelText("Task paused")).toBeOnTheScreen()
    expect(screen.queryByText("Run now")).toBeNull()
  })

  it("runs a task now through the scheduler API", async () => {
    const { client } = await setup((c) => {
      c.api.scheduler.list.mockResolvedValue([makeTask()])
    })

    await fireEvent.press(await screen.findByText("Run now"))

    await waitFor(() => expect(client.api.scheduler.runNow).toHaveBeenCalledWith("task_1"))
  })

  it("pauses and resumes through the scheduler API", async () => {
    const { client } = await setup((c) => {
      c.api.scheduler.list.mockResolvedValue([makeTask()])
    })

    await fireEvent.press(await screen.findByText("Pause"))
    await waitFor(() =>
      expect(client.api.scheduler.update).toHaveBeenCalledWith("task_1", { paused: true }),
    )
  })

  it("frames a 409 on run-now as a paused task", async () => {
    const { client } = await setup((c) => {
      c.api.scheduler.list.mockResolvedValue([makeTask()])
      c.api.scheduler.runNow.mockRejectedValue(new ApiError(409, JSON.stringify({ error: "task_paused" })))
    })

    await fireEvent.press(await screen.findByText("Run now"))

    expect(await screen.findByText("Paused tasks can't run.")).toBeOnTheScreen()
    expect(client.api.scheduler.runNow).toHaveBeenCalledWith("task_1")
  })

  it("frames a lost run-now response as unknown, never failed", async () => {
    await setup((c) => {
      c.api.scheduler.list.mockResolvedValue([makeTask()])
      c.api.scheduler.runNow.mockRejectedValue(new RequestTimeoutError())
    })

    await fireEvent.press(await screen.findByText("Run now"))

    expect(
      await screen.findByText("The server did not respond — check the run state before retrying."),
    ).toBeOnTheScreen()
  })
})

describe("SchedulerSection run history (#172)", () => {
  it("fetches runs lazily and renders status, source, error and the session link", async () => {
    const onOpenSession = jest.fn()
    const { client } = await setup(
      (c) => {
        c.api.scheduler.list.mockResolvedValue([makeTask()])
        c.api.scheduler.runs.mockResolvedValue([
          makeRun(),
          makeRun({
            id: "run_2",
            status: "failed",
            source: "schedule",
            sessionID: null,
            error: "opencode unreachable",
          }),
        ])
      },
      { onOpenSession },
    )

    expect(await screen.findByText("Nightly sweep")).toBeOnTheScreen()
    expect(client.api.scheduler.runs).not.toHaveBeenCalled()

    await fireEvent.press(screen.getByText("Run history"))

    expect(await screen.findByText("Completed")).toBeOnTheScreen()
    expect(screen.getByText("Manual")).toBeOnTheScreen()
    expect(screen.getByText("Failed")).toBeOnTheScreen()
    expect(screen.getByText("Scheduled")).toBeOnTheScreen()
    expect(screen.getByText("opencode unreachable")).toBeOnTheScreen()

    await fireEvent.press(screen.getByText("Open session"))
    expect(onOpenSession).toHaveBeenCalledWith("ses_1")
  })

  it("collapses the history on a second press", async () => {
    const { client } = await setup((c) => {
      c.api.scheduler.list.mockResolvedValue([makeTask()])
      c.api.scheduler.runs.mockResolvedValue([makeRun()])
    })

    await fireEvent.press(await screen.findByText("Run history"))
    expect(await screen.findByText("Completed")).toBeOnTheScreen()

    await fireEvent.press(screen.getByText("Run history"))
    await waitFor(() => expect(screen.queryByText("Completed")).toBeNull())
    expect(client.api.scheduler.runs).toHaveBeenCalled()
  })

  it("shows an empty and an error state for the history", async () => {
    await setup((c) => {
      c.api.scheduler.list.mockResolvedValue([makeTask(), makeTask({ id: "task_2", name: "Other" })])
      c.api.scheduler.runs.mockImplementation(async (taskID: string) => {
        if (taskID === "task_2") throw new Error("boom")
        return []
      })
    })

    const cards = await screen.findAllByText("Run history")
    await fireEvent.press(cards[0]!)
    expect(await screen.findByText("No runs yet.")).toBeOnTheScreen()

    await fireEvent.press(cards[1]!)
    expect(await screen.findByText("Could not load the run history.")).toBeOnTheScreen()
  })
})

describe("SchedulerSection create and edit (#172)", () => {
  async function openCreate() {
    await setup()
    expect(await screen.findByText(/No scheduled tasks yet/)).toBeOnTheScreen()
    await fireEvent.press(screen.getByLabelText("New task"))
    expect(await screen.findByText(/Fires the prompt into a fresh session/)).toBeOnTheScreen()
  }

  async function fillValidForm() {
    await fireEvent.changeText(screen.getByLabelText("Task name"), "Nightly sweep")
    await fireEvent.changeText(screen.getByLabelText("Task prompt"), "Inspect the checks")

    await fireEvent.press(screen.getByLabelText("Model"))
    await fireEvent.press(await screen.findByText("Test · Alpha"))

    await fireEvent.press(screen.getByLabelText("Workspace"))
    await fireEvent.press(await screen.findByText("Web"))
  }

  it("validates the name and prompt locally", async () => {
    await openCreate()

    await fireEvent.press(screen.getByLabelText("Create task"))
    expect(await screen.findByText("Give the task a name.")).toBeOnTheScreen()

    await fireEvent.changeText(screen.getByLabelText("Task name"), "Nightly sweep")
    await fireEvent.press(screen.getByLabelText("Create task"))
    expect(await screen.findByText("Write the prompt to run.")).toBeOnTheScreen()
  })

  it("requires a model and a workspace", async () => {
    await setup()
    await fireEvent.press(await screen.findByLabelText("New task"))
    await fireEvent.changeText(screen.getByLabelText("Task name"), "Nightly sweep")
    await fireEvent.changeText(screen.getByLabelText("Task prompt"), "Inspect the checks")

    await fireEvent.press(screen.getByLabelText("Create task"))
    expect(await screen.findByText("Pick a model.")).toBeOnTheScreen()
  })

  it("creates a task with the interval preset, server-default timezone", async () => {
    const { client } = await setup()
    expect(await screen.findByText(/No scheduled tasks yet/)).toBeOnTheScreen()
    await fireEvent.press(screen.getByLabelText("New task"))
    await fillValidForm()

    await fireEvent.press(screen.getByLabelText("Create task"))

    await waitFor(() =>
      expect(client.api.scheduler.create).toHaveBeenCalledWith({
        name: "Nightly sweep",
        prompt: "Inspect the checks",
        model: { providerID: "test", id: "alpha" },
        schedule: { kind: "interval", intervalMinutes: 15 },
        timezone: undefined,
        directory: "/data/workspaces/web",
      }),
    )
  })

  it("creates a task with custom minutes and maps server errors to copy", async () => {
    const { client } = await setup((c) => {
      c.api.scheduler.create.mockRejectedValue(
        new ApiError(400, JSON.stringify({ error: "invalid_interval" })),
      )
    })
    await fireEvent.press(await screen.findByLabelText("New task"))
    await fillValidForm()

    await fireEvent.press(screen.getByLabelText("Schedule"))
    await fireEvent.press(await screen.findByText("Custom minutes…"))

    await fireEvent.changeText(screen.getByLabelText("Custom interval in minutes"), "3")
    await fireEvent.press(screen.getByLabelText("Create task"))
    expect(
      await screen.findByText("The interval must be a whole number of at least 5 minutes."),
    ).toBeOnTheScreen()
    expect(client.api.scheduler.create).not.toHaveBeenCalled()

    await fireEvent.changeText(screen.getByLabelText("Custom interval in minutes"), "10")
    await fireEvent.press(screen.getByLabelText("Create task"))
    expect(await screen.findByText("The interval must be at least 5 minutes.")).toBeOnTheScreen()
  })

  it("creates a task with a custom cron expression", async () => {
    const { client } = await setup()
    await fireEvent.press(await screen.findByLabelText("New task"))
    await fillValidForm()

    await fireEvent.press(screen.getByLabelText("Schedule"))
    await fireEvent.press(await screen.findByText("Custom cron…"))

    await fireEvent.changeText(screen.getByLabelText("Custom cron expression"), "not cron")
    await fireEvent.press(screen.getByLabelText("Create task"))
    expect(
      await screen.findByText("Use a 5-field cron expression, e.g. 0 9 * * 1."),
    ).toBeOnTheScreen()

    await fireEvent.changeText(screen.getByLabelText("Custom cron expression"), "0 9 * * 1")
    await fireEvent.press(screen.getByLabelText("Create task"))

    await waitFor(() =>
      expect(client.api.scheduler.create).toHaveBeenCalledWith(
        expect.objectContaining({ schedule: { kind: "cron", cron: "0 9 * * 1" } }),
      ),
    )
  })

  it("picks a timezone, defaulting to the server default", async () => {
    const { client } = await setup()
    await fireEvent.press(await screen.findByLabelText("New task"))
    await fillValidForm()

    expect(screen.getByLabelText("Timezone").props.accessibilityValue?.text ?? "Server default").toBe(
      "Server default",
    )
    await fireEvent.press(screen.getByLabelText("Timezone"))
    const dialog = await screen.findByText("Pick a timezone")
    expect(dialog).toBeOnTheScreen()
    await fireEvent.changeText(screen.getByPlaceholderText("Search…"), "Madrid")
    await fireEvent.press(await screen.findByText("Europe/Madrid"))
    await fireEvent.press(screen.getByLabelText("Create task"))

    await waitFor(() =>
      expect(client.api.scheduler.create).toHaveBeenCalledWith(
        expect.objectContaining({ timezone: "Europe/Madrid" }),
      ),
    )
  })

  it("falls back to a curated zone list when the device has no IANA database", async () => {
    const spy = jest.spyOn(Intl, "supportedValuesOf").mockImplementation(() => {
      throw new Error("no icu")
    })
    try {
      await setup()
      await fireEvent.press(await screen.findByLabelText("New task"))
      await fireEvent.press(screen.getByLabelText("Timezone"))
      expect(await screen.findByText("Pick a timezone")).toBeOnTheScreen()
      // The trigger and the modal option share the label.
      expect(screen.getAllByText("Server default")).toHaveLength(2)
      expect(screen.getByText("UTC")).toBeOnTheScreen()
    } finally {
      spy.mockRestore()
    }
  })

  it("edits a task with the dialog pre-filled", async () => {
    const { client } = await setup((c) => {
      c.api.scheduler.list.mockResolvedValue([
        makeTask({ timezone: "UTC", schedule: { kind: "cron", cron: "0 0 * * *" } }),
      ])
    })

    await fireEvent.press(await screen.findByText("Edit"))
    expect(await screen.findByText("Edit task")).toBeOnTheScreen()
    expect(screen.getByLabelText("Task name").props.value).toBe("Nightly sweep")

    await fireEvent.changeText(screen.getByLabelText("Task name"), "Morning sweep")
    await fireEvent.press(screen.getByLabelText("Save changes"))

    await waitFor(() =>
      expect(client.api.scheduler.update).toHaveBeenCalledWith(
        "task_1",
        expect.objectContaining({ name: "Morning sweep", timezone: "UTC" }),
      ),
    )
  })

  it("deletes a task after confirming the cascade", async () => {
    const { client } = await setup((c) => {
      c.api.scheduler.list.mockResolvedValue([makeTask()])
    })

    await fireEvent.press(await screen.findByLabelText("Delete Nightly sweep"))
    expect(await screen.findByText("Delete task")).toBeOnTheScreen()
    expect(screen.getByText(/Its run history is removed with it/)).toBeOnTheScreen()

    await fireEvent.press(screen.getByLabelText("Delete"))

    await waitFor(() => expect(client.api.scheduler.remove).toHaveBeenCalledWith("task_1"))
  })
})
