import { expect, test } from "../fixtures"
import { addWorkspace, login } from "./helpers"

// Settings on mobile (<768px): a vertical section list comes first; opening
// a section shows only that section, with a back control to the list.
test("settings uses a vertical list with back navigation on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page)
  await addWorkspace(page)

  // Settings is a bottom-nav action on mobile; Sign out lives at the end of
  // the section list (the desktop options box is not rendered here).
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Settings", exact: true })
    .click()
  const dialog = page.getByRole("dialog", { name: "Settings" })

  // The list comes first: every section is reachable, no content is shown.
  await expect(dialog.getByRole("button", { name: "Appearance" })).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Goal review" })).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Web search" })).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Providers" })).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Disconnect from the active server" })).toBeVisible()
  await expect(dialog.getByText("Theme color")).toBeHidden()

  // Opening a section shows only that section.
  await dialog.getByRole("button", { name: "Providers" }).click()
  await expect(dialog.getByPlaceholder("Search providers…")).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Appearance" })).toBeHidden()

  // Back returns to the list.
  await dialog.getByRole("button", { name: "Back to settings" }).click()
  await expect(dialog.getByRole("button", { name: "Providers" })).toBeVisible()
  await expect(dialog.getByPlaceholder("Search providers…")).toBeHidden()

  // Goal review keeps its fields in the detail view; changes save
  // automatically, without a Save button.
  await dialog.getByRole("button", { name: "Goal review" }).click()
  await expect(dialog.getByLabel("Max rounds before pausing")).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Save" })).toHaveCount(0)
})
