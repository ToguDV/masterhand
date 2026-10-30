import { expect, test } from "../fixtures"
import { addWorkspace, login, newSession } from "./helpers"

/**
 * The branch viewer is read-only: it shows the branch the agent is working on,
 * refreshes on its own, and never opens a picker or mutates git.
 */
test("shows the current branch without opening a picker", async ({ page }) => {
  await login(page)
  await addWorkspace(page)
  await newSession(page)

  const viewer = page.locator('[title^="Current branch:"]')
  await expect(viewer).toBeVisible()

  // No button, no dialog: clicking the chip does nothing.
  await expect(page.getByRole("button", { name: "Branch" })).toHaveCount(0)
  await viewer.click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
})

test("refreshes when the agent switches branches", async ({ page }) => {
  let calls = 0
  await page.route("**/api/workspaces/*/branches", async (route) => {
    calls += 1
    const current = calls < 2 ? "main" : "feature/agent"
    await route.fulfill({ json: { current, branches: ["main", "feature/agent"] } })
  })

  await login(page)
  await addWorkspace(page)
  await newSession(page)

  // The viewer polls every 5 s; the second response reflects the agent's switch.
  await expect(page.locator('[title^="Current branch:"]')).toContainText("feature/agent", {
    timeout: 15_000,
  })
})
