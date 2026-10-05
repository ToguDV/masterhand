import { expect, test } from "@playwright/test"
import { addWorkspace, login, newSession } from "./helpers"

test("creates an isolated session in a git worktree", async ({ page }) => {
  await login(page)
  const workspaceName = await addWorkspace(page)

  await newSession(page, { isolated: true })

  await expect(page.getByPlaceholder("Write a message…")).toBeVisible()
  await expect(page.getByText("Isolated worktree")).toBeVisible()
  await expect(page.getByText(new RegExp(`masterhand/${workspaceName.toLowerCase()}`)).first()).toBeVisible()
})

test("filters isolated and standard sessions", async ({ page }) => {
  await login(page)
  await addWorkspace(page)

  await newSession(page)
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

  await newSession(page, { isolated: true })
  await expect(page.getByText("Isolated worktree")).toBeVisible()

  await page.getByRole("button", { name: "Finish & PR" }).click()
  await expect(page.getByText("No changes to commit.")).toBeVisible()

  await page.getByRole("button", { name: "Delete session" }).click()
  await page.getByRole("button", { name: "Delete", exact: true }).click()
  await expect(page.getByText("No sessions yet.")).toBeVisible()
})

// Finish & PR is a long non-idempotent operation: a lost response must never
// read as a hard failure, and a retry must be safe (#65).
test("reports a lost Finish & PR response as ambiguous, not as a failure", async ({ page }) => {
  await login(page)
  await addWorkspace(page)

  await newSession(page, { isolated: true })
  await expect(page.getByText("Isolated worktree")).toBeVisible()

  // The real request runs (route.fetch) but the response arrives after the
  // client deadline: exactly a lost response on a completed operation.
  await page.route("**/api/isolated-sessions/*/finish", async (route) => {
    const response = await route.fetch()
    await new Promise((resolve) => setTimeout(resolve, 6_000))
    await route.fulfill({ response }).catch(() => {})
  })

  await page.getByRole("button", { name: "Finish & PR" }).click()
  await expect(page.getByText(/did not answer in time/)).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText("Could not finish the session")).toBeHidden()

  // Retrying after the ambiguity is safe: the commit is idempotent.
  await page.unroute("**/api/isolated-sessions/*/finish")
  await page.getByRole("button", { name: "Finish & PR" }).click()
  await expect(page.getByText("No changes to commit.")).toBeVisible()
})
