import { expect, test } from "@playwright/test"
import { addWorkspace, login, newSession } from "./helpers"

const MOCK_URL = "http://127.0.0.1:4097"

test.afterEach(async ({ request }) => {
  // The mock is shared by the whole suite: never leave a delayed echo or a
  // forced prompt failure behind.
  await request.post(`${MOCK_URL}/e2e/delay-echo`, { data: { ms: 0 } }).catch(() => {})
  await request.post(`${MOCK_URL}/e2e/fail-prompts`, { data: { value: false } }).catch(() => {})
})

// The "Sending…" ghost bubble (#125): a plain prompt shows a dimmed user bubble
// until the persisted message carrying its marker appears in the history.
test("shows a Sending… ghost until the message is confirmed delivered (#125)", async ({ page, request }) => {
  await login(page)
  await addWorkspace(page)
  await newSession(page)

  // Hold the echo: the prompt response settles but the history does not show
  // the message yet, so the ghost must remain instead of leaving a silent gap.
  await request.post(`${MOCK_URL}/e2e/delay-echo`, { data: { ms: 2000 } })

  const composer = page.getByPlaceholder("Write a message…")
  await composer.fill("markdown ghost")
  await page.getByRole("button", { name: "Send" }).click()

  const ghost = page.locator('[aria-label="Sending message"]')
  await expect(ghost).toBeVisible()
  await expect(ghost).toContainText("Sending…")
  await expect(ghost).toContainText("markdown ghost")
  // The real bubble is not there yet: no duplicate frame while waiting.
  const realBubbles = page.locator(".mh-msg--user:not(.mh-msg--pending)")
  await expect(realBubbles).toHaveCount(0)

  // The echoed message replaces the ghost in the same render.
  await expect(realBubbles).toHaveCount(1, { timeout: 10_000 })
  await expect(realBubbles).toContainText("markdown ghost")
  await expect(ghost).toHaveCount(0)
  await expect(page.getByText("Sending…")).toHaveCount(0)
})

// A hard failure turns the ghost into a retryable error state; Retry resends
// the original text with a fresh marker (never the same one).
test("fails the ghost into a retryable error and resends with a fresh marker (#125)", async ({ page, request }) => {
  await login(page)
  await addWorkspace(page)
  await newSession(page)

  await request.post(`${MOCK_URL}/e2e/fail-prompts`, { data: { value: true } })
  const composer = page.getByPlaceholder("Write a message…")
  await composer.fill("markdown retry")
  await page.getByRole("button", { name: "Send" }).click()

  const failed = page.locator('[aria-label="Message failed to send"]')
  await expect(failed).toBeVisible()
  await expect(failed).toContainText("Failed to send")
  await expect(failed).toContainText("markdown retry")

  // Retry once prompts work again: the ghost resolves into the real bubble.
  await request.post(`${MOCK_URL}/e2e/fail-prompts`, { data: { value: false } })
  await failed.getByRole("button", { name: "Retry" }).click()
  await expect(page.locator(".mh-msg--user")).toHaveCount(1, { timeout: 10_000 })
  await expect(failed).toHaveCount(0)
})
