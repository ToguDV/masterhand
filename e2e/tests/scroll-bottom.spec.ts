import { expect, test } from "../fixtures"
import { addWorkspace, login, newSession } from "./helpers"

test("shows a scroll-to-bottom shortcut when scrolled up", async ({ page }) => {
  await login(page)
  await addWorkspace(page)
  await newSession(page)

  const composer = page.getByPlaceholder("Write a message…")
  await composer.fill("/seed 60")
  await page.getByRole("button", { name: "Send" }).click()
  await expect(page.getByText("Seed message 60", { exact: true })).toBeVisible()

  const scroller = page.getByTestId("chat-scroll")
  await expect(scroller).toBeVisible()
  await scroller.evaluate((element) => {
    element.scrollTop = 0
    element.dispatchEvent(new Event("scroll", { bubbles: true }))
  })

  await expect(page.getByRole("button", { name: "Scroll to bottom" })).toBeVisible()
  await page.getByRole("button", { name: "Scroll to bottom" }).click()
  await expect(page.getByRole("button", { name: "Scroll to bottom" })).toBeHidden()
  await expect(page.getByText("Seed message 60", { exact: true })).toBeVisible()
})
