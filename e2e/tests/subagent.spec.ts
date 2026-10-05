import { expect, test } from "@playwright/test"
import { addWorkspace, login, newSession } from "./helpers"

test("renders subagent runs as a custom card and opens the child session", async ({ page }) => {
  await login(page)
  await addWorkspace(page)

  await newSession(page)
  const composer = page.getByPlaceholder("Write a message…")
  await expect(composer).toBeVisible()
  await composer.fill("please run a subagent")
  await page.getByRole("button", { name: "Send" }).click()

  const main = page.locator("main")
  await expect(main.getByText("Subagent", { exact: true })).toBeVisible()
  await expect(main.getByText("explore", { exact: true })).toBeVisible()
  await expect(main.getByText("Explore the repository", { exact: true })).toBeVisible()

  await main.getByRole("button", { name: /Explore the repository/ }).click()
  await expect(main.getByText("List the files in the project")).toBeVisible()
  await expect(main.getByText("Found 3 files")).toBeVisible()

  await main.getByRole("button", { name: /Open session/ }).click()
  await expect(page.locator("header").getByText("Explore the repository (@explore subagent)")).toBeVisible()
  // The child is reachable through the card, not listed as a top-level session.
  await expect(page.locator("aside").getByText("Explore the repository (@explore subagent)")).toHaveCount(0)

  const back = page.getByRole("button", { name: /Back to main agent/ })
  await expect(back).toBeVisible()
  await back.click()
  await expect(main.getByText("Subagent", { exact: true })).toBeVisible()
})
