import { expect, test } from "@playwright/test"
import { addWorkspace, login, newSession } from "./helpers"

const MOCK_URL = "http://127.0.0.1:4097"

test.afterEach(async ({ request }) => {
  // The mock is shared by the whole suite: never leave stalled replies behind.
  await request.post(`${MOCK_URL}/e2e/hold-permission-replies`, { data: { value: false } }).catch(() => {})
  await request.post(`${MOCK_URL}/e2e/release-permission-replies`).catch(() => {})
})

// A lost response on a non-idempotent permission reply must reconcile against
// the pending list instead of reporting a hard failure that invites a
// double answer (#67).
test("confirms a permission reply whose response was lost", async ({ page, request }) => {
  await login(page)
  await addWorkspace(page)
  await newSession(page)

  await page.getByPlaceholder("Write a message…").fill("hello agent")
  await page.getByRole("button", { name: "Send" }).click()
  await expect(page.getByText("Permission requested")).toBeVisible()

  // The mock applies the reply but holds the response and emits no
  // `permission.replied`: only the list reconciliation can confirm it.
  await request.post(`${MOCK_URL}/e2e/hold-permission-replies`)
  await page.getByRole("button", { name: "Allow once" }).click()

  // The client's deadline fires (~5 s), then the pending list confirms the
  // reply; the card resolves instead of showing a false failure.
  await expect(page.getByText("Allowed once")).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText(/may not have been answered/)).toBeHidden()
  await expect(page.getByText("Permission requested")).toBeHidden()
})
