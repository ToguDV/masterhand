import { expect, test } from "@playwright/test"
import { addWorkspace, login, newSession } from "./helpers"

test("starts and stops a session preview through the tunnel", async ({ page }) => {
  await login(page)
  await addWorkspace(page)

  await newSession(page)
  await expect(page.getByPlaceholder("Write a message…")).toBeVisible()

  await page.getByRole("button", { name: "Preview" }).click()
  await expect(page.getByRole("heading", { name: "Preview" })).toBeVisible()

  await page.getByRole("button", { name: "Start" }).click()
  const frame = page.locator('iframe[title="Session preview"]')
  await expect(frame).toHaveAttribute("src", "https://e2e-preview.trycloudflare.com")
  await expect(page.getByRole("link", { name: "Open" })).toHaveAttribute(
    "href",
    "https://e2e-preview.trycloudflare.com",
  )

  await page.getByRole("button", { name: "Stop" }).click()
  await expect(frame).toBeHidden()
  await expect(page.getByRole("button", { name: "Start" })).toBeVisible()
})
