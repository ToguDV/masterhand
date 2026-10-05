import { expect, test } from "@playwright/test"
import { addWorkspace, login, newSession } from "./helpers"

test("renders the newest page of a long conversation and expands it on demand", async ({ page }) => {
  await login(page)
  await addWorkspace(page)

  await newSession(page)
  const composer = page.getByPlaceholder("Write a message…")
  await composer.fill("/seed 250")
  await page.getByRole("button", { name: "Send" }).click()

  // 251 messages (the command plus 250 seeds): the newest 200 render and the
  // button offers the remaining 51.
  const showEarlier = page.getByRole("button", { name: "Show 51 earlier messages" })
  await expect(showEarlier).toBeVisible()

  // The oldest messages stay out of the DOM until the user asks for them.
  await expect(page.getByText("Seed message 1", { exact: true })).toHaveCount(0)

  await showEarlier.click()
  await expect(page.getByText("Seed message 1", { exact: true })).toBeVisible()
  await expect(showEarlier).toBeHidden()
})
