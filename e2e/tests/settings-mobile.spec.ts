import { expect, test } from "@playwright/test"
import { addWorkspace, login } from "./helpers"

// Settings on mobile (<768px): a vertical section list comes first; opening
// a section shows only that section, with a back control to the list.
test("settings uses a vertical list with back navigation on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page)
  await addWorkspace(page)

  // On mobile Settings lives in the sessions drawer.
  await page.getByRole("button", { name: "Sessions" }).click()
  const drawer = page.locator("aside")
  await drawer.getByRole("button", { name: "Settings" }).click()
  const dialog = page.getByRole("dialog", { name: "Settings" })

  // The list comes first: every section is reachable, no content is shown.
  await expect(dialog.getByRole("button", { name: "Appearance" })).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Goal review" })).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Web search" })).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Providers" })).toBeVisible()
  await expect(dialog.getByText("Theme color")).toBeHidden()

  // Opening a section shows only that section.
  await dialog.getByRole("button", { name: "Providers" }).click()
  await expect(dialog.getByPlaceholder("Search providers…")).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Appearance" })).toBeHidden()

  // Back returns to the list.
  await dialog.getByRole("button", { name: "Back to settings" }).click()
  await expect(dialog.getByRole("button", { name: "Providers" })).toBeVisible()
  await expect(dialog.getByPlaceholder("Search providers…")).toBeHidden()

  // Goal review keeps its fields and save control in the detail view.
  await dialog.getByRole("button", { name: "Goal review" }).click()
  await expect(dialog.getByLabel("Max rounds before pausing")).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Save" })).toBeVisible()
})
