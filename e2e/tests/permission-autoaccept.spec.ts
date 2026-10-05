import { expect, test, type Page } from "@playwright/test"
import { addWorkspace, login } from "./helpers"

async function newSession(page: Page): Promise<void> {
  await page.getByRole("button", { name: "+ New" }).click()
  await expect(page.getByPlaceholder("Write a message…")).toBeVisible()
}

async function send(page: Page, text: string): Promise<void> {
  await page.getByPlaceholder("Write a message…").fill(text)
  await page.getByRole("button", { name: "Send" }).click()
}

test("auto-accepts permission requests for the active session", async ({ page }) => {
  await login(page)
  await addWorkspace(page)
  await newSession(page)

  await page.getByRole("button", { name: "Auto-accept", exact: true }).click()
  await expect(page.getByRole("button", { name: "Auto-accept: on" })).toBeVisible()

  await send(page, "hello agent")

  await expect(page.getByText("Done!")).toBeVisible()
  await expect(page.getByText("Permission requested")).toBeHidden()
})

test("does not auto-accept for other sessions", async ({ page }) => {
  await login(page)
  await addWorkspace(page)

  await newSession(page)
  await page.getByRole("button", { name: "Auto-accept", exact: true }).click()
  await expect(page.getByRole("button", { name: "Auto-accept: on" })).toBeVisible()

  // A different session starts with auto-accept off.
  await newSession(page)
  await expect(page.getByRole("button", { name: "Auto-accept", exact: true })).toBeVisible()

  await send(page, "hello agent")

  await expect(page.getByText("Permission requested")).toBeVisible()
  await page.getByRole("button", { name: "Once" }).click()
  await expect(page.getByText("Done!")).toBeVisible()
})
