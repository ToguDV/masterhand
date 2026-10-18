import type { Locator, Page } from "@playwright/test"
import { expect, test } from "../fixtures"
import { addWorkspace, login } from "./helpers"

/**
 * Scheduler (issue #147): the sidebar's third section drives scheduled tasks
 * end to end through the real BFF in front of the mock opencode. Fires go
 * through `Run now` — the specs never wait for an interval to elapse.
 *
 * Mock contract exercised here: `POST /api/session` persists the scheduler
 * marker metadata and the task-name title, `POST /api/session/:id/model` pins
 * the task's model, the prompt metadata marker lands on the user message, and
 * the headless turn finishes with `session.idle` — so `Run now` leaves the run
 * `completed` and a new session titled with the task name.
 */

function taskCard(page: Page, name: string): Locator {
  // Task cards are the scheduler panel's only <article>s.
  return page.locator("article").filter({ hasText: name })
}

async function openSchedulerSection(page: Page): Promise<void> {
  // The desktop rail hides the section panel: the home list lives behind the
  // header `<`, and the Scheduler card is the third section entry.
  await page.locator("header").getByRole("button", { name: "Back to sections" }).click()
  await page.locator("aside").getByRole("button", { name: "Scheduler", exact: true }).click()
}

/**
 * Drives a SearchSelect field inside a dialog: opens the trigger, optionally
 * types into the search box, and picks the option.
 *
 * The picker only renders the search box when the list exceeds its preview
 * count of six options (see `SearchSelect`); a short list shows everything
 * already, so `query` is skipped there instead of timing out on a missing
 * box. `searchBox.or(option)` also keeps options still loading from racing
 * the decision.
 */
async function pickSearchSelect(
  scope: Locator,
  ariaLabel: string,
  optionName: string,
  query?: string,
): Promise<void> {
  const trigger = scope.getByRole("button", { name: ariaLabel, exact: true })
  await trigger.click()
  const listbox = scope.getByRole("listbox", { name: ariaLabel })
  const searchBox = scope.getByRole("textbox", { name: `Search ${ariaLabel.toLowerCase()}` })
  const option = listbox.getByRole("option", { name: optionName })
  if (query) {
    // Either the list renders the search box (long list, query narrows it) or
    // already shows every option with the answer on screen (short list):
    // whichever appears first decides, and no timer races option loading.
    await expect(searchBox.or(option).first()).toBeVisible()
    if (await searchBox.isVisible()) await searchBox.fill(query)
  }
  // Picking an option closes the SearchSelect on its own.
  await option.click()
}

interface TaskInput {
  name: string
  prompt: string
  workspace: string
  /** SearchSelect option label, e.g. "Test · Gamma" (the real mock catalog). */
  model: string
  /** Search query narrowing the model list before picking. */
  modelQuery?: string
  /** Schedule option label; the dialog defaults to "Every 15 min". */
  schedule?: string
  scheduleQuery?: string
}

/** Creates one task through the dialog and returns after the card appears. */
async function createTask(page: Page, input: TaskInput): Promise<Locator> {
  await page.getByRole("button", { name: "New task" }).click()
  const dialog = page.getByRole("dialog", { name: "Scheduled task" })
  await expect(dialog.getByRole("heading", { name: "New task" })).toBeVisible()

  await dialog.getByLabel("Name").fill(input.name)
  await dialog.getByLabel("Prompt").fill(input.prompt)
  await pickSearchSelect(dialog, "Model", input.model, input.modelQuery ?? input.model.split("·")[1]?.trim())
  // The workspace picker renders a search box only when the list exceeds six
  // options; with a short list every option is visible already. The query is
  // narrowing-only, so pass it regardless and let the helper decide.
  await pickSearchSelect(dialog, "Workspace", input.workspace, input.workspace)
  if (input.schedule) await pickSearchSelect(dialog, "Schedule", input.schedule, input.scheduleQuery)

  await dialog.getByRole("button", { name: "Create task" }).click()
  await expect(dialog).toBeHidden()

  const card = taskCard(page, input.name)
  await expect(card).toBeVisible()
  return card
}

const UNIQUE = () => Date.now().toString(36)

test("the scheduler section opens with its empty panel", async ({ page }) => {
  await login(page)
  await addWorkspace(page)
  await openSchedulerSection(page)

  // The section explains itself in the main view while the panel mounts.
  await expect(page.locator("main").getByRole("heading", { name: "Scheduled prompts" })).toBeVisible()
  const panel = page.locator("aside")
  await expect(panel.getByRole("button", { name: "New task" })).toBeVisible()
  await expect(
    panel.getByText("No scheduled tasks yet — create one to fire a prompt on a schedule."),
  ).toBeVisible()
})

test("creates a task and Run now completes with a new titled session", async ({ page }) => {
  await login(page)
  const workspace = await addWorkspace(page)
  await openSchedulerSection(page)

  const taskName = `Sweep ${UNIQUE()}`
  const card = await createTask(page, {
    name: taskName,
    prompt: "Run the scheduled sweep",
    workspace,
    // Picked from the real model catalog the mock opencode serves.
    model: "Test · Gamma",
    modelQuery: "gamma",
    schedule: "Every 5 min",
    scheduleQuery: "every 5 min",
  })

  // The card reports the schedule, the server-default timezone and the active chip.
  await expect(card.getByText("Every 5 min · Server default")).toBeVisible()
  await expect(card.getByText("Active", { exact: true })).toBeVisible()
  await expect(card.getByText("test/gamma")).toBeVisible()

  // Run history is lazy: it opens with the empty note, then the manual fire
  // traverses firing → running → completed and lands on the list.
  await card.getByRole("button", { name: "Run history", exact: true }).click()
  const runs = card.getByRole("list", { name: `Runs of ${taskName}` })
  await expect(runs.getByText("No runs yet.")).toBeVisible()

  await card.getByRole("button", { name: "Run now", exact: true }).click()
  await expect(runs.getByText("Completed", { exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(runs.getByText("Manual", { exact: true })).toBeVisible()

  // The run's session opens from the history: the mock titled it with the
  // task name, and the session shows the fired prompt in its thread.
  await runs.getByRole("button", { name: "Open session" }).click()
  await expect.poll(() => new URL(page.url()).searchParams.get("session")).not.toBeNull()

  await page.locator("header").getByRole("button", { name: "Back to sections" }).click()
  await page.locator("aside").getByRole("button", { name: "Sessions", exact: true }).click()
  await expect(page.locator("header").getByRole("heading", { name: taskName })).toBeVisible()
  await expect(page.getByPlaceholder("Write a message…")).toBeVisible()
  await expect(page.getByText("Run the scheduled sweep")).toBeVisible()
})

test("Run now on a paused task surfaces the inline 409 and resume works", async ({ page, request }) => {
  await login(page)
  const workspace = await addWorkspace(page)
  await openSchedulerSection(page)

  const taskName = `Paused sweep ${UNIQUE()}`
  const card = await createTask(page, {
    name: taskName,
    prompt: "Run the paused sweep",
    workspace,
    model: "Test · Alpha",
    modelQuery: "alpha",
  })

  // Pause and resume from the card: the chip flips and the buttons swap.
  await card.getByRole("button", { name: "Pause", exact: true }).click()
  await expect(card.getByText("Paused", { exact: true })).toBeVisible()
  await expect(card.getByRole("button", { name: "Resume", exact: true })).toBeVisible()
  await card.getByRole("button", { name: "Resume", exact: true }).click()
  await expect(card.getByText("Active", { exact: true })).toBeVisible()
  await expect(card.getByRole("button", { name: "Run now", exact: true })).toBeVisible()

  // A paused task's Run now is only reachable from a stale panel (the button
  // hides once a pause is rendered): pin the list endpoint to the pre-pause
  // snapshot — the pause happens on another device — while the POST still
  // hits the real BFF and must answer 409 with the inline copy.
  const staleBody = await page.evaluate(async () => (await fetch("/api/scheduled-tasks")).text())
  const taskID = (JSON.parse(staleBody).tasks as Array<{ name: string; id: string }>).find(
    (task) => task.name === taskName,
  )!.id
  await page.route("**/api/scheduled-tasks", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: staleBody }),
  )
  // The real BFF pause announces itself; the panel refetches into the pinned
  // snapshot, so the card keeps showing Active with Run now.
  await page.evaluate(async (id) => {
    await fetch(`/api/scheduled-tasks/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paused: true }),
    })
  }, taskID)
  // Wait for the pause to actually land instead of a blind delay: the poll
  // reads `page.request`, which bypasses the pinned route (only page traffic
  // is intercepted), so it sees the real BFF state.
  await expect
    .poll(async () => {
      const body = await page.request.get("/api/scheduled-tasks").then((response) => response.text())
      const tasks = (JSON.parse(body) as { tasks: Array<{ id: string; paused: boolean }> }).tasks
      return tasks.find((task) => task.id === taskID)?.paused ?? false
    })
    .toBe(true)

  await card.getByRole("button", { name: "Run now", exact: true }).click()
  await expect(page.locator("aside").getByRole("alert")).toContainText("Paused tasks can't run.")

  // Back to the truth: with the interception removed, the panel refetches the
  // paused task — where Resume flips it back to Active through the UI.
  await page.unroute("**/api/scheduled-tasks")
  await openSchedulerSection(page)
  const resumedCard = taskCard(page, taskName)
  await expect(resumedCard.getByText("Paused", { exact: true })).toBeVisible()
  await resumedCard.getByRole("button", { name: "Resume", exact: true }).click()
  await expect(resumedCard.getByText("Active", { exact: true })).toBeVisible()
  await expect(resumedCard.getByRole("button", { name: "Run now", exact: true })).toBeVisible()
})

test("deletes a task after confirmation", async ({ page }) => {
  await login(page)
  const workspace = await addWorkspace(page)
  await openSchedulerSection(page)

  const taskName = `Doomed sweep ${UNIQUE()}`
  const card = await createTask(page, {
    name: taskName,
    prompt: "Run the doomed sweep",
    workspace,
    model: "Test · Beta",
    modelQuery: "beta",
  })

  // Destructive confirm: the dialog names the task and warns about history.
  await card.getByRole("button", { name: `Delete ${taskName}` }).click()
  const dialog = page.getByRole("dialog", { name: "Delete task" })
  await expect(dialog.getByText(taskName)).toBeVisible()
  await dialog.getByRole("button", { name: "Delete", exact: true }).click()
  await expect(taskCard(page, taskName)).toHaveCount(0)
  await expect(dialog).toBeHidden()
})
