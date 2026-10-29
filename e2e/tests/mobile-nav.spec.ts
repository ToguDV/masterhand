import { expect, test } from "../fixtures"
import { addWorkspace, login, newSession } from "./helpers"

/**
 * Mobile web (<768px) navigation mirrors the React Native app: a bottom nav
 * pinned above the safe area replaces the drawer. Sessions, Board and
 * Scheduler are sections; Settings is an action that opens the settings
 * surface, where Sign out lives on mobile.
 */
test("the bottom nav switches sections and hides while a chat is open", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page)
  await addWorkspace(page)

  const nav = page.getByRole("navigation", { name: "Main navigation" })
  await expect(nav).toBeVisible()
  await expect(nav.getByRole("button", { name: "Sessions", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  )

  // The Sessions screen is the session list itself; the old drawer is gone.
  await expect(page.locator("aside")).toBeHidden()
  await expect(page.getByRole("button", { name: "New session" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Workspace" })).toBeVisible()

  // Board is the second section; its main view takes the screen.
  await nav.getByRole("button", { name: "Board", exact: true }).click()
  await expect(nav.getByRole("button", { name: "Board", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  )
  const main = page.locator("main")
  await expect(
    main.getByRole("heading", { name: "Board" }).or(main.locator('div[aria-label="Board columns"]')),
  ).toBeVisible()

  // Scheduler mounts the task manager full-screen (not the sidebar explainer).
  await nav.getByRole("button", { name: "Scheduler", exact: true }).click()
  await expect(nav.getByRole("button", { name: "Scheduler", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  )
  await expect(page.getByRole("button", { name: "New task" })).toBeVisible()
  await expect(page.getByText("create one from the sidebar panel")).toBeHidden()

  // Settings is an action, never an active tab; Sign out lives inside it on
  // mobile (the desktop options box is hidden here).
  await nav.getByRole("button", { name: "Settings", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Settings" })
  await expect(dialog.getByRole("button", { name: "Appearance" })).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Disconnect from the active server" })).toBeVisible()
  await dialog.getByRole("button", { name: "Close settings" }).click()

  // An open chat takes over the screen: the nav hides and its back control
  // returns to the section.
  await nav.getByRole("button", { name: "Sessions", exact: true }).click()
  await newSession(page)
  await expect(page.getByPlaceholder("Write a message…")).toBeVisible()
  await expect(nav).toBeHidden()
  await page.locator("header").getByRole("button", { name: "Back", exact: true }).click()
  await expect(nav).toBeVisible()
  await expect(page.getByRole("button", { name: "New session" })).toBeVisible()
})

test("the shell swaps the sidebar and the bottom nav on resize", async ({ page }) => {
  await login(page)
  await addWorkspace(page)
  const nav = page.getByRole("navigation", { name: "Main navigation" })

  // Desktop: the docked sidebar, no bottom nav in the tree.
  await expect(page.locator("aside")).toBeVisible()
  await expect(nav).toHaveCount(0)

  // Mobile: the sidebar is not mounted at all; the bottom nav replaces it.
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(nav).toBeVisible()
  await expect(page.locator("aside")).toHaveCount(0)

  // Back to desktop: the sidebar returns without a reload.
  await page.setViewportSize({ width: 1280, height: 800 })
  await expect(page.locator("aside")).toBeVisible()
  await expect(nav).toHaveCount(0)
})
