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

test("keeps a reader parked just above the bottom while output arrives", async ({ page }) => {
  await login(page)
  await addWorkspace(page)
  await newSession(page)

  const composer = page.getByPlaceholder("Write a message…")
  await composer.fill("/seed 60")
  await page.getByRole("button", { name: "Send" }).click()
  await expect(page.getByText("Seed message 60", { exact: true })).toBeVisible()

  const scroller = page.getByTestId("chat-scroll")
  // 20 px from the bottom: outside the 12 px follow threshold but inside the
  // 120 px jump shortcut, so the reader is not "at the bottom" for follow.
  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight - element.clientHeight - 20
    element.dispatchEvent(new Event("scroll", { bubbles: true }))
  })
  await expect(page.getByRole("button", { name: "Scroll to bottom" })).toBeHidden()

  // A new turn grows the transcript below the reader. The old 120 px follow
  // threshold re-pinned the scroller to the bottom here.
  await composer.fill("/seed 0")
  await page.getByRole("button", { name: "Send" }).click()
  await expect(
    page.locator(".mh-msg--user:not(.mh-msg--pending)").filter({ hasText: "/seed 0" }),
  ).toHaveCount(1)

  // The reader keeps their place: the viewport must never end up pinned to the
  // new bottom (the old 120 px threshold scrolled it there on the next render).
  await expect
    .poll(() =>
      scroller.evaluate(
        (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
      ),
    )
    .toBeGreaterThanOrEqual(20)
})
