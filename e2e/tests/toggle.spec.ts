import { expect, test } from "../fixtures"
import { login } from "./helpers"

/**
 * Switches are a 36×20 track with a 16 px knob. The knob used to rely on the
 * button's centered static position before translating, so the active state
 * overflowed the track's right edge. Assert the real geometry in both states.
 */
test("a switch knob stays inside its track in both states", async ({ page }) => {
  await login(page)
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Settings" })
  await dialog.getByRole("button", { name: "About" }).click()

  const toggle = dialog.getByRole("switch", { name: "Check for updates automatically" })
  await expect(toggle).toBeVisible()
  const knob = toggle.locator("span")

  for (const checked of [true, false]) {
    if ((await toggle.getAttribute("aria-checked")) !== String(checked)) await toggle.click()
    await expect(toggle).toHaveAttribute("aria-checked", String(checked))

    const track = await toggle.boundingBox()
    const ball = await knob.boundingBox()
    expect(track).not.toBeNull()
    expect(ball).not.toBeNull()
    expect(ball!.x).toBeGreaterThanOrEqual(track!.x - 0.5)
    expect(ball!.x + ball!.width).toBeLessThanOrEqual(track!.x + track!.width + 0.5)
    expect(ball!.y).toBeGreaterThanOrEqual(track!.y - 0.5)
    expect(ball!.y + ball!.height).toBeLessThanOrEqual(track!.y + track!.height + 0.5)
  }
})
