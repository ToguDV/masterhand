import { expect, test } from "@playwright/test"

test("a 5xx from /api/status offers a retry instead of loading forever", async ({ page }) => {
  let statusCalls = 0
  await page.route("**/api/status", async (route) => {
    statusCalls += 1
    if (statusCalls === 1) {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "boom" }),
      })
      return
    }
    await route.continue()
  })

  await page.goto("/")
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible()
  await expect(page.getByText("Loading…")).toBeHidden()

  await page.getByRole("button", { name: "Retry" }).click()
  // The retry reaches the real BFF, which answers 401 for a fresh client.
  await expect(page.locator("#password")).toBeVisible()
})
