import { expect, test } from "@playwright/test"
import { addWorkspace, login, newSession } from "./helpers"

/**
 * Branch picker/creator for standard sessions (#94): the chip next to the
 * workspace menu shows the current branch, and the popover creates and
 * switches branches through the BFF's git endpoints. Isolated sessions get a
 * read-only chip instead (their branch belongs to the worktree).
 */
test("creates and switches branches from the composer", async ({ page }) => {
  await login(page)
  await addWorkspace(page)
  await newSession(page)

  const trigger = page.getByRole("button", { name: "Branch" })
  await expect(trigger).toBeVisible()

  // Create a first branch (from the repo's initial branch).
  await trigger.click()
  await page.getByLabel("New branch name").fill("e2e/feature-one")
  await page.getByRole("button", { name: "Create", exact: true }).click()
  await expect(trigger).toContainText("e2e/feature-one")
  await expect(page.getByText("Created and switched to e2e/feature-one")).toBeVisible()

  // Create a second one so there is somewhere to switch back to.
  await page.getByLabel("New branch name").fill("e2e/feature-two")
  await page.getByRole("button", { name: "Create", exact: true }).click()
  await expect(trigger).toContainText("e2e/feature-two")

  // Search + switch back.
  await page.getByLabel("Search branches").fill("one")
  await page.getByRole("option", { name: "e2e/feature-one" }).click()
  await expect(trigger).toContainText("e2e/feature-one")
  await expect(page.getByText("Switched to e2e/feature-one")).toBeVisible()
})

test("isolated sessions show a read-only branch chip and no picker", async ({ page }) => {
  await login(page)
  await addWorkspace(page)
  await newSession(page, { isolated: true })

  await expect(page.getByRole("button", { name: "Branch" })).toBeHidden()
  await expect(page.locator(".mh-chip", { hasText: "masterhand/" }).first()).toBeVisible()
})
