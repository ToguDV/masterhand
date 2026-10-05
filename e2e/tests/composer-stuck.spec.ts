import { expect, test } from "@playwright/test"
import { addWorkspace, login } from "./helpers"

const MOCK_URL = "http://127.0.0.1:4097"

test.afterEach(async ({ request }) => {
  // The mock is shared by the whole suite: never leave a prompt held.
  await request.post(`${MOCK_URL}/e2e/release-prompt`).catch(() => {})
})

// A stalled prompt (paused container, lost network) used to latch the
// composer's `sending` state: the Send button stayed disabled — gray with
// `cursor: not-allowed` — as if the textarea were empty, until a reload.
test("recovers the send button when the prompt response stalls", async ({ page, request }) => {
  await login(page)
  await addWorkspace(page)
  await page.getByRole("button", { name: "+ New" }).click()

  const composer = page.getByPlaceholder("Write a message…")
  const send = page.getByRole("button", { name: "Send" })
  // `/seed` keeps the mock out of the permission dance, so this spec leaves no
  // pending request behind for the permission specs.
  await composer.fill("/seed 5")
  await expect(send).toBeEnabled()

  await request.post(`${MOCK_URL}/e2e/stall-prompt`)
  await send.click()

  // In flight: the button reports progress instead of looking like "no text".
  await expect(send).toHaveText("Sending…")
  await expect(send).toBeDisabled()
  await expect(composer).toHaveValue("/seed 5")

  // The client deadline releases the composer, keeps the text and warns.
  await expect(send).toHaveText("Send", { timeout: 15_000 })
  await expect(send).toBeEnabled()
  await expect(composer).toHaveValue("/seed 5")
  await expect(page.getByText(/server did not respond/)).toBeVisible()
})

// The lost response is reconciled through the live history: as soon as the
// sent message appears, the composer releases — no deadline wait, no warning.
test("releases the send button as soon as the history confirms the delivery", async ({ page, request }) => {
  await login(page)
  await addWorkspace(page)
  await page.getByRole("button", { name: "+ New" }).click()

  const composer = page.getByPlaceholder("Write a message…")
  const send = page.getByRole("button", { name: "Send" })

  await request.post(`${MOCK_URL}/e2e/stall-response`)
  await composer.fill("/seed 2")
  await send.click()
  await expect(send).toHaveText("Sending…")

  // The turn runs to completion while the response is held; the history
  // confirms the delivery and the composer releases well before the deadline
  // (clearing the sent text, so an empty composer is disabled — expected).
  await expect(page.getByText("Seed message 1")).toBeVisible()
  await expect(send).toHaveText("Send", { timeout: 2_000 })
  await expect(composer).toHaveValue("")

  // The lost response never surfaces as a timeout warning, and the next
  // message typed meanwhile enables Send and is preserved.
  await composer.fill("follow up")
  await expect(send).toBeEnabled()
  await page.waitForTimeout(5_500)
  await expect(send).toBeEnabled()
  await expect(composer).toHaveValue("follow up")
  await expect(page.getByText(/server did not respond/)).toBeHidden()
})

// Text typed while a slow (but successful) send is in flight must survive:
// it was neither sent nor should it be wiped when the response arrives.
test("keeps text typed while a slow send is in flight", async ({ page, request }) => {
  await login(page)
  await addWorkspace(page)
  await page.getByRole("button", { name: "+ New" }).click()

  const composer = page.getByPlaceholder("Write a message…")
  const send = page.getByRole("button", { name: "Send" })

  await request.post(`${MOCK_URL}/e2e/stall-prompt`)
  await composer.fill("/seed 2")
  await send.click()
  await expect(send).toHaveText("Sending…")

  await composer.fill("follow up")
  await request.post(`${MOCK_URL}/e2e/release-prompt`)

  await expect(page.getByText("Seed message 1")).toBeVisible()
  await expect(composer).toHaveValue("follow up")
})
