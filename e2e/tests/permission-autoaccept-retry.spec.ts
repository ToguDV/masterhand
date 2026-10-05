import { expect, test, type APIRequestContext, type Page } from "@playwright/test"
import { addWorkspace, login, newSession } from "./helpers"

const MOCK_URL = "http://127.0.0.1:4097"

async function send(page: Page, text: string): Promise<void> {
  await page.getByPlaceholder("Write a message…").fill(text)
  await page.getByRole("button", { name: "Send" }).click()
}

async function replyAttempts(request: APIRequestContext): Promise<number> {
  const response = await request.get(`${MOCK_URL}/e2e/state`)
  return ((await response.json()) as { permissionReplies: number }).permissionReplies
}

test("retries auto-accept after a transient failure", async ({ page, request }) => {
  await login(page)
  await addWorkspace(page)
  await newSession(page)

  await page.getByRole("button", { name: "Auto-accept", exact: true }).click()
  await expect(page.getByRole("button", { name: "Auto-accept: on" })).toBeVisible()

  await request.post(`${MOCK_URL}/e2e/fail-permission-replies`)
  await send(page, "hello agent")

  // The first answer fails; the client retries with backoff. Once replies stop
  // failing, the next retry succeeds and the turn finishes without user input.
  await expect.poll(() => replyAttempts(request), { timeout: 10_000 }).toBeGreaterThanOrEqual(2)
  await request.post(`${MOCK_URL}/e2e/fail-permission-replies`, { data: { value: false } })

  await expect(page.getByText("Done!")).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText("Permission requested")).toBeHidden()
})

test("surfaces exhausted auto-accept failures and lets the user answer manually", async ({ page, request }) => {
  await login(page)
  await addWorkspace(page)
  await newSession(page)

  await page.getByRole("button", { name: "Auto-accept", exact: true }).click()
  await expect(page.getByRole("button", { name: "Auto-accept: on" })).toBeVisible()

  await request.post(`${MOCK_URL}/e2e/fail-permission-replies`)
  await send(page, "hello agent")

  // After the bounded retries the client stops and points at the inline card.
  await expect(page.getByText(/Could not auto-accept the permission request/)).toBeVisible({
    timeout: 10_000,
  })
  await expect(page.getByText("Permission requested")).toBeVisible()

  // Answering manually still resolves the turn.
  await request.post(`${MOCK_URL}/e2e/fail-permission-replies`, { data: { value: false } })
  await page.getByRole("button", { name: "Once" }).click()
  await expect(page.getByText("Done!")).toBeVisible()
})
