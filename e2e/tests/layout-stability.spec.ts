import type { Locator, Page, Route } from "@playwright/test"
import { expect, test } from "../fixtures"
import { login } from "./helpers"

/**
 * Loading placeholders must reserve the final geometry. These tests hold the
 * data endpoints for a beat so the skeleton is observable, then compare the
 * position of a sibling that used to jump when the content landed (the
 * original GitHub bug). A fixed delay keeps every route handler self-contained
 * even when an assertion fails before the request is released.
 */

const SETTLE_MS = 1200

function openSettings(page: Page) {
  return page.getByRole("dialog", { name: "Settings" })
}

async function position(locator: Locator): Promise<number> {
  const box = await locator.boundingBox()
  expect(box).not.toBeNull()
  return box!.y
}

async function delay(route: Route): Promise<void> {
  if (route.request().method() === "GET") {
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
  }
  await route.continue()
}

test("GitHub keeps the permissions block in place while the status loads", async ({ page }) => {
  await page.route("**/api/github", delay)

  await login(page)
  await page.getByRole("button", { name: "Settings" }).click()
  const settings = openSettings(page)
  await settings.getByRole("button", { name: "GitHub" }).click()

  await expect(settings.getByTestId("github-skeleton")).toBeVisible()
  const details = settings.locator("details")
  const before = await position(details)

  await expect(settings.getByTestId("github-skeleton")).toHaveCount(0)
  const after = await position(details)

  expect(Math.abs(before - after)).toBeLessThan(4)
})

test("Web search reserves the source list while it loads", async ({ page }) => {
  await page.route("**/api/websearch", delay)
  await page.route("**/api/oc/api/websearch/**", delay)
  await page.route("**/api/oc/api/integration", delay)
  await page.route("**/api/oc/api/credential", delay)

  await login(page)
  await page.getByRole("button", { name: "Settings" }).click()
  const settings = openSettings(page)
  await settings.getByRole("button", { name: "Web search" }).click()

  await expect(settings.getByTestId("websearch-skeleton").first()).toBeVisible()
  const testCard = settings.getByText("Test the current source")
  const before = await position(testCard)

  await expect(settings.getByTestId("websearch-skeleton")).toHaveCount(0)
  const after = await position(testCard)

  expect(Math.abs(before - after)).toBeLessThan(8)
})
