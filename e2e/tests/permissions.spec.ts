import { expect, test } from "@playwright/test"
import { addWorkspace, login, newSession } from "./helpers"

const MOCK_URL = "http://127.0.0.1:4097"

test("drops a pending permission answered elsewhere after reconnecting", async ({ page, request }) => {
  await login(page)
  await addWorkspace(page)
  await newSession(page)

  const composer = page.getByPlaceholder("Write a message…")
  await composer.fill("hello agent")
  await page.getByRole("button", { name: "Send" }).click()
  await expect(page.getByText("Permission requested")).toBeVisible()

  // Another device answers the request while this client is offline: the mock
  // resolves it without broadcasting `permission.replied`, so the local state
  // goes stale and only a reconnect reconciliation can clear it.
  // The mock keeps pendings from earlier specs, so pick the newest one: it is
  // the request this test just created.
  let requestID = ""
  await expect
    .poll(async () => {
      const body = (await (await request.get(`${MOCK_URL}/e2e/pending`)).json()) as { pending: string[] }
      requestID = body.pending[body.pending.length - 1] ?? ""
      return requestID
    })
    .not.toBe("")
  await request.post(`${MOCK_URL}/e2e/reply`, { data: { requestID, decision: "once" } })

  // The answered turn continues and completes while the stale dialog stays up.
  await expect(page.getByText("Done!")).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText("Permission requested")).toBeVisible()

  // Reconnect: the server returns no pending requests, so the stale dialog
  // must be pruned instead of kept forever.
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")))
  await expect(page.getByText("Permission requested")).toBeHidden()
})
