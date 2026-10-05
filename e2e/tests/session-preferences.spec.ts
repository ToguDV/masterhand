import { expect, test } from "@playwright/test"
import { addWorkspace, login, newSession } from "./helpers"

async function pick(page: import("@playwright/test").Page, name: string, option: string): Promise<void> {
  await page.getByRole("button", { name, exact: true }).click()
  await page.getByRole("listbox", { name }).getByRole("option", { name: option }).click()
}

test("remembers the agent and model for a session after a reload", async ({ page }) => {
  await login(page)
  await addWorkspace(page)
  await newSession(page)

  await pick(page, "Agent", "plan")

  const modelButton = page.getByRole("button", { name: "Model", exact: true })
  await modelButton.click()
  await page.getByRole("textbox", { name: "Search model" }).fill("flash")
  await page.getByRole("listbox", { name: "Model" }).getByRole("option", { name: "Other · Flash" }).click()

  await page.reload()

  await expect(page.getByRole("button", { name: "Agent", exact: true })).toContainText("plan")
  await expect(page.getByRole("button", { name: "Model", exact: true })).toContainText("Other · Flash")
})

test("remembers the effort for a session after a reload", async ({ page }) => {
  await login(page)
  await addWorkspace(page)
  await newSession(page)

  await page.getByRole("button", { name: "Effort", exact: true }).click()
  await page.getByRole("listbox", { name: "Effort" }).getByRole("option", { name: "High" }).click()
  await expect(page.getByRole("button", { name: "Effort", exact: true })).toContainText("High")

  await page.reload()

  await expect(page.getByRole("button", { name: "Effort", exact: true })).toContainText("High")
})

test("keeps composer selections scoped to their session", async ({ page }) => {
  await login(page)
  await addWorkspace(page)

  await newSession(page)
  await pick(page, "Agent", "plan")
  await expect(page.getByRole("button", { name: "Agent", exact: true })).toContainText("plan")

  await newSession(page)
  await expect(page.getByRole("button", { name: "Agent", exact: true })).toContainText("build")
})
