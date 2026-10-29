import { expect, test } from "../fixtures"
import { login } from "./helpers"

/**
 * In-app update notices (#131). The BFF serves `GET /api/update` as
 * `{ latest: … | null }`; the web bundle compares it against the running
 * server version and its own build id. Both specs drive the UI through
 * route-level mocks — no GitHub access from the test.
 */

test("a newer upstream release shows the update notice with notes and upgrade command", async ({ page }) => {
  await page.route("**/api/update", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        latest: {
          version: "9.9.9",
          tag: "v9.9.9",
          publishedAt: "2026-10-29T00:00:00.000Z",
          notes: "Big fixes",
        },
        checkedAt: Date.now(),
      }),
    })
  })
  await login(page)
  await expect(page.getByText("MasterHand 9.9.9 is available")).toBeVisible()
  await expect(page.getByRole("link", { name: "Release notes" })).toHaveAttribute(
    "href",
    "https://github.com/togudv/masterhand/releases/tag/v9.9.9",
  )
  await expect(page.getByText("docker compose -f deploy/docker-compose.yml pull")).toBeVisible()
})

test("an unknown upstream (latest:null) shows no notice and no error", async ({ page }) => {
  await page.route("**/api/update", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ latest: null, checkedAt: Date.now() }),
    })
  })
  await login(page)
  await expect(page.getByText(/is available/)).toBeHidden()
  await expect(page.getByRole("button", { name: "Reload" })).toBeHidden()
})

test("a stale bundle (server build differs) offers a Reload", async ({ page }) => {
  await page.route("**/api/status", async (route) => {
    const response = await route.fetch()
    const body = (await response.json()) as Record<string, unknown>
    body.build = "stale-test-build"
    await route.fulfill({
      status: response.status(),
      contentType: "application/json",
      body: JSON.stringify(body),
    })
  })
  await login(page)
  await expect(page.getByText(/running an older build/)).toBeVisible()
  await expect(page.getByRole("button", { name: "Reload" })).toBeVisible()
})
