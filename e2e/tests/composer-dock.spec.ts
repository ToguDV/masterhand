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

test("composer workspace menu opens above the trigger and stays in view", async ({ page }) => {
  await login(page)
  await addWorkspace(page)
  await newSession(page)

  // The composer dock sits at the bottom of the page: the menu must open
  // upward from the trigger and stay fully inside the viewport.
  const dock = page.locator(".mh-composer-dock")
  const trigger = dock.getByRole("button", { name: "Workspace" })
  await trigger.click()
  const menu = dock.getByRole("menu", { name: "Workspace" })
  await expect(menu).toBeVisible()

  const triggerBox = await trigger.boundingBox()
  const menuBox = await menu.boundingBox()
  expect(triggerBox).not.toBeNull()
  expect(menuBox).not.toBeNull()
  expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(triggerBox!.y + 2)

  const viewport = page.viewportSize()
  expect(viewport).not.toBeNull()
  expect(menuBox!.y).toBeGreaterThanOrEqual(0)
  expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(viewport!.height + 1)
})
