import { expect, test } from "@playwright/test"
import { addWorkspace, login, newSession } from "./helpers"

test("highlighted long lines wrap inside the code column, never under the gutter", async ({ page }) => {
  await login(page)
  await addWorkspace(page)
  await newSession(page)

  await page.getByPlaceholder("Write a message…").fill("show me the long line")
  await page.getByRole("button", { name: "Send" }).click()

  const card = page.locator("main").locator('[data-tool="read"]')
  await expect(card).toContainText("src/long.ts")
  await card.locator("button").first().click()

  const gutter = card.locator("span.select-none").first()
  const content = card.locator(".mh-code__content").first()
  await expect(content).toContainText("masterhand")

  const gutterBox = await gutter.boundingBox()
  const contentBox = await content.boundingBox()
  expect(gutterBox).not.toBeNull()
  expect(contentBox).not.toBeNull()

  // The line really wraps: the content block spans several line heights.
  const lineHeight = await content.evaluate(
    (element) => parseFloat(getComputedStyle(element).lineHeight) || 20,
  )
  expect(contentBox!.height).toBeGreaterThan(lineHeight * 1.5)

  // Every visual line starts inside the code column, at or after the gutter's
  // right edge — never beneath the line number.
  expect(contentBox!.x).toBeGreaterThanOrEqual(gutterBox!.x + gutterBox!.width - 1)

  // And nothing overflows horizontally: wrapping (not scrolling) fits it.
  const overflow = await card.locator("pre").first().evaluate((element) => ({
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
  }))
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1)
})
