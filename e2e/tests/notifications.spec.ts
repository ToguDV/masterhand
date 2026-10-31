import { expect, test } from "../fixtures"
import { addWorkspace, login } from "./helpers"

// Settings > Notifications is device-wide and persisted in localStorage. The
// test never depends on a real OS notification: it verifies the controls, the
// default-on categories and the round-trip across a reload.
test("notification preferences are configurable and persisted", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await login(page)
  await addWorkspace(page)

  await page.getByRole("button", { name: "Settings", exact: true }).click()
  let dialog = page.getByRole("dialog", { name: "Settings" })
  await dialog.getByRole("button", { name: "Notifications" }).click()

  const master = dialog.getByRole("switch", { name: "Agent activity" })
  await expect(master).toHaveAttribute("aria-checked", "true")
  await expect(dialog.getByRole("switch", { name: "Questions" })).toHaveAttribute(
    "aria-checked",
    "true",
  )

  await dialog.getByRole("switch", { name: "Questions" }).click()
  await expect(dialog.getByRole("switch", { name: "Questions" })).toHaveAttribute(
    "aria-checked",
    "false",
  )

  await dialog.getByRole("button", { name: "Close settings" }).click()
  await page.reload()
  await expect(page.getByRole("button", { name: "New session" })).toBeVisible()

  await page.getByRole("button", { name: "Settings", exact: true }).click()
  dialog = page.getByRole("dialog", { name: "Settings" })
  await dialog.getByRole("button", { name: "Notifications" }).click()
  await expect(dialog.getByRole("switch", { name: "Questions" })).toHaveAttribute(
    "aria-checked",
    "false",
  )
})
