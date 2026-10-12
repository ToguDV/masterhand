import { expect, test } from "@playwright/test"
import { addWorkspace, login, newSession } from "./helpers"

// The composer footer used to be three loose strips (goal/worktree line,
// workspace toolbar, textarea + Send, pickers row) each with its own border.
// They now live in a single dock card: one surface, one border, textarea
// without its own box and the toolbar integrated below it.
test("composer renders as a single integrated dock", async ({ page }) => {
  await login(page)
  await addWorkspace(page)
  await newSession(page)

  const dock = page.locator(".mh-composer-dock")
  await expect(dock).toBeVisible()

  // Context, field and toolbar share the same card.
  await expect(dock.getByRole("button", { name: "Workspace" })).toBeVisible()
  await expect(dock.getByPlaceholder("Write a message…")).toBeVisible()
  await expect(dock.getByRole("button", { name: "Agent" })).toBeVisible()
  await expect(dock.getByRole("button", { name: "Model" })).toBeVisible()
  await expect(dock.getByRole("button", { name: "Auto-accept", exact: true })).toBeVisible()
  await expect(dock.getByRole("button", { name: "Send" })).toBeVisible()

  // The suggestions popover anchors to the dock, not between loose blocks.
  await dock.getByPlaceholder("Write a message…").fill("/")
  await expect(page.locator("#composer-suggestions")).toBeVisible()
})
