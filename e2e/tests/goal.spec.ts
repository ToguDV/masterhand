import { expect, test, type APIRequestContext, type Page } from "@playwright/test"
import { addWorkspace, login, newSession } from "./helpers"

const MOCK = "http://127.0.0.1:4097"

/** Resets the mock's Goal Mode script (verdicts, critic issues, delays). */
async function resetGoal(
  request: APIRequestContext,
  options: { verdicts?: boolean[]; issues?: string[]; delayMs?: number } = {},
): Promise<void> {
  await request.post(`${MOCK}/e2e/goal-script`, {
    data: { verdicts: options.verdicts ?? [], issues: options.issues ?? [] },
  })
  await request.post(`${MOCK}/e2e/goal-delay`, { data: { ms: options.delayMs ?? 0 } })
}

async function composerOf(page: Page) {
  return page.getByPlaceholder("Write a message…")
}

test("drives a goal through a rejection round to approval", async ({ page, request }) => {
  await resetGoal(request, { verdicts: [false, true], issues: ["flaky test still failing"] })
  await login(page)
  await addWorkspace(page)
  await newSession(page)

  const composer = await composerOf(page)
  await composer.fill("/goal make the suite green")
  await page.getByRole("button", { name: "Send" }).click()

  // The loop runs fast: assert the outcome (rejected round 1 kept in the
  // history, round 2 approved) instead of racing the phase labels.
  await expect(page.getByText("Goal approved")).toBeVisible({ timeout: 25_000 })
  await expect(page.getByText("round 2/5")).toBeVisible()
  await expect(page.getByText("The judge rejected the previous attempt")).toBeVisible()

  await page.getByRole("button", { name: "Details" }).click()
  await expect(page.getByText("Round 1:")).toBeVisible()
  await expect(page.getByText("Round 2:")).toBeVisible()
  await expect(page.getByText("flaky test still failing").first()).toBeVisible()
})

test("retries transient opencode failures and still completes", async ({ page, request }) => {
  await resetGoal(request)
  await request.post(`${MOCK}/e2e/goal-fail-prompts`, { data: { count: 2 } })
  await login(page)
  await addWorkspace(page)
  await newSession(page)

  const composer = await composerOf(page)
  await composer.fill("/goal survive the rate limits")
  await page.getByRole("button", { name: "Send" }).click()

  await expect(page.getByText("Goal approved")).toBeVisible({ timeout: 25_000 })
})

test("cancels a running goal", async ({ page, request }) => {
  await resetGoal(request, { delayMs: 4000 })
  await login(page)
  await addWorkspace(page)
  await newSession(page)

  const composer = await composerOf(page)
  await composer.fill("/goal never finishes")
  await page.getByRole("button", { name: "Send" }).click()
  await expect(page.getByText("round 1/5")).toBeVisible()
  await expect(page.getByText("Working", { exact: true })).toBeVisible()

  await page.getByRole("button", { name: "Cancel" }).click()
  await expect(page.getByText("Cancelled")).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole("button", { name: "Cancel" })).toBeHidden()
})

test("pauses at the round cap and resumes to approval", async ({ page, request }) => {
  await resetGoal(request, { verdicts: [false, false, false, false, false, true] })
  await login(page)
  await addWorkspace(page)
  await newSession(page)

  const composer = await composerOf(page)
  await composer.fill("/goal keep going until the judge agrees")
  await page.getByRole("button", { name: "Send" }).click()

  await expect(page.getByText("round 5/5")).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText("Paused")).toBeVisible({ timeout: 15_000 })

  await page.getByRole("button", { name: "Resume" }).click()
  await expect(page.getByText("round 6/10")).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText("Goal approved")).toBeVisible({ timeout: 20_000 })
})

test("asks for a goal when /goal has no text", async ({ page }) => {
  await login(page)
  await addWorkspace(page)
  await newSession(page)

  const composer = await composerOf(page)
  await composer.fill("/goal")
  await page.getByRole("button", { name: "Send" }).click()
  await expect(page.getByText("Describe the goal after /goal")).toBeVisible()
})

test("persists the goal review settings", async ({ page, request }) => {
  await resetGoal(request)
  await login(page)

  await page.getByRole("button", { name: "Settings" }).click()
  await page.getByRole("button", { name: "Goal review" }).click()
  await page.getByLabel("Max rounds before pausing").fill("3")
  await page.getByRole("button", { name: "Save" }).click()
  await expect(page.getByText("Saved.")).toBeVisible()

  // The server persisted it (not just the local input).
  const persisted = await page.evaluate(async () => (await fetch("/api/goal/settings")).json())
  expect(persisted).toMatchObject({ settings: { maxRounds: 3 } })

  await page.getByRole("button", { name: "Close settings" }).click()
  await page.getByRole("button", { name: "Settings" }).click()
  await page.getByRole("button", { name: "Goal review" }).click()
  await expect(page.getByLabel("Max rounds before pausing")).toHaveValue("3")
})
