import { expect, test } from "@playwright/test"
import { addWorkspace, login, newSession } from "./helpers"

test("limits model options and searches the rest", async ({ page }) => {
  await login(page)
  await addWorkspace(page)

  await newSession(page)

  const modelButton = page.getByRole("button", { name: "Model", exact: true })
  await expect(modelButton).toBeVisible()
  await modelButton.click()

  const listbox = page.getByRole("listbox", { name: "Model" })
  await expect(listbox.getByRole("option")).toHaveCount(6)
  await expect(page.getByRole("button", { name: "Show all 9 models" })).toBeVisible()

  await page.getByRole("button", { name: "Show all 9 models" }).click()
  await expect(listbox.getByRole("option")).toHaveCount(9)

  await page.getByRole("textbox", { name: "Search model" }).fill("flash")
  await expect(listbox.getByRole("option")).toHaveCount(1)
  await listbox.getByRole("option", { name: "Other · Flash" }).click()

  await expect(modelButton).toContainText("Other · Flash")
  await expect(listbox).toBeHidden()
})

test("remembers the last used model for new sessions", async ({ page }) => {
  await login(page)
  await addWorkspace(page)
  await newSession(page)

  const modelButton = page.getByRole("button", { name: "Model", exact: true })
  await modelButton.click()
  await page.getByRole("textbox", { name: "Search model" }).fill("flash")
  await page.getByRole("listbox", { name: "Model" }).getByRole("option", { name: "Other · Flash" }).click()
  await expect(modelButton).toContainText("Other · Flash")

  await page.getByPlaceholder("Write a message…").fill("hello agent")
  await page.getByRole("button", { name: "Send" }).click()
  await page.getByRole("button", { name: "Once" }).click()
  await expect(page.getByText("Done!")).toBeVisible()

  await newSession(page)
  await expect(page.getByRole("button", { name: "Model", exact: true })).toContainText("Other · Flash")
})
