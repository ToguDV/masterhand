import { expect, test } from "@playwright/test"
import { addWorkspace, login, newSession } from "./helpers"

const MOCK_URL = "http://127.0.0.1:4097"

test.afterEach(async ({ request }) => {
  // The mock is shared by the whole suite: never leave a failed-abort flag or
  // a pending permission behind.
  await request.post(`${MOCK_URL}/e2e/fail-abort`, { data: { value: false } }).catch(() => {})
  const pending = await request.get(`${MOCK_URL}/e2e/pending`).catch(() => null)
  if (pending) {
    const body = (await pending.json()) as { pending: string[] }
    for (const requestID of body.pending) {
      await request
        .post(`${MOCK_URL}/e2e/reply`, { data: { requestID, decision: "reject" } })
        .catch(() => {})
    }
  }
})

// `abortSession` used to fail silently: the turn kept running and the UI gave
// no hint (#73).
test("reports when stopping the agent fails", async ({ page, request }) => {
  await login(page)
  await addWorkspace(page)
  await newSession(page)

  await page.getByPlaceholder("Write a message…").fill("hello")
  await page.getByRole("button", { name: "Send" }).click()
  // The turn is busy waiting for a permission, so Stop is available.
  const stop = page.getByRole("button", { name: "Stop" })
  await expect(stop).toBeVisible()

  await request.post(`${MOCK_URL}/e2e/fail-abort`)
  await stop.click()

  await expect(page.getByText("Could not stop the agent. Try again.")).toBeVisible()
  // The turn is still running: Stop stays available instead of pretending it ended.
  await expect(stop).toBeVisible()
})
