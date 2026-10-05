import { expect, test } from "@playwright/test"
import { addWorkspace, login } from "./helpers"

test("creates an isolated session in a git worktree", async ({ page }) => {
  await login(page)
  const workspaceName = await addWorkspace(page)

  await page.getByRole("checkbox").check()
  await page.getByRole("button", { name: "+ New" }).click()

  await expect(page.getByPlaceholder("Write a message…")).toBeVisible()
  await expect(page.getByText("Isolated worktree")).toBeVisible()
  await expect(page.getByText(new RegExp(`masterhand/${workspaceName.toLowerCase()}`)).first()).toBeVisible()
})

test("filters isolated and standard sessions", async ({ page }) => {
  await login(page)
  await addWorkspace(page)

  await page.getByRole("button", { name: "+ New" }).click()
  await expect(page.locator("aside").getByText("Untitled")).toBeVisible()
  await expect(page.getByText("Isolated worktree")).toBeHidden()

  await page.getByRole("button", { name: "Isolated", exact: true }).click()
  await expect(page.getByText("No sessions match this filter.")).toBeVisible()

  await page.getByRole("button", { name: "Standard", exact: true }).click()
  await expect(page.locator("aside").getByText("Untitled")).toBeVisible()
})

test("finishes an isolated session and deletes its worktree", async ({ page }) => {
  await login(page)
  await addWorkspace(page)

  await page.getByRole("checkbox").check()
  await page.getByRole("button", { name: "+ New" }).click()
  await expect(page.getByText("Isolated worktree")).toBeVisible()

  await page.getByRole("button", { name: "Finish & PR" }).click()
  await expect(page.getByText("No changes to commit.")).toBeVisible()

  await page.getByRole("button", { name: "Delete session" }).click()
  await page.getByRole("button", { name: "Delete", exact: true }).click()
  await expect(page.getByText("No sessions yet.")).toBeVisible()
})
