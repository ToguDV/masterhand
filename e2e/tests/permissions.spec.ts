import { expect, test } from "@playwright/test"
import { addWorkspace, login } from "./helpers"

const MOCK_URL = "http://127.0.0.1:4097"

test("drops a pending permission answered elsewhere after reconnecting", async ({ page, request }) => {
  await login(page)
  await addWorkspace(page)
  await page.getByRole("button", { name: "+ New" }).click()

  const composer = page.getByPlaceholder("Write a message…")
  await composer.fill("hello agent")
  await page.getByRole("button", { name: "Send" }).click()
  await expect(page.getByText("Permission requested")).toBeVisible()

  // Another device answers the request while this client is offline: the mock
  // resolves it without broadcasting `permission.replied`, so the local state
  // goes stale and only a reconnect reconciliation can clear it.
  let requestID = ""
  await expect
    .poll(async () => {
      const body = (await (await request.get(`${MOCK_URL}/e2e/pending`)).json()) as { pending: string[] }
      requestID = body.pending[0] ?? ""
      return requestID
    })
    .not.toBe("")
  await request.post(`${MOCK_URL}/e2e/reply`, { data: { requestID, decision: "once" } })

  // The answered turn continues and completes while the stale dialog stays up.
  await expect(page.getByText("Done!")).toBeVisible()
  await expect(page.getByText("Permission requested")).toBeVisible()

  // Reconnect: the server returns no pending requests, so the stale dialog
  // must be pruned instead of kept forever.
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")))
  await expect(page.getByText("Permission requested")).toBeHidden()
})
