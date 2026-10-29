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

test("the opt-in updater applies the release and reports the new running version", async ({ page }) => {
  let runningVersion = "0.1.0"
  await page.route("**/api/update", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        latest: { version: "9.9.9", tag: "v9.9.9", publishedAt: null, notes: null },
        checkedAt: Date.now(),
      }),
    })
  })
  await page.route("**/api/status", async (route) => {
    const response = await route.fetch()
    const body = (await response.json()) as Record<string, unknown>
    body.version = runningVersion
    body.updater = { enabled: true, tracksLatest: true, track: "latest" }
    await route.fulfill({
      status: response.status(),
      contentType: "application/json",
      body: JSON.stringify(body),
    })
  })
  await page.route("**/api/update/apply", async (route) => {
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ accepted: true, target: "9.9.9" }),
    })
  })

  await login(page)
  const updateNow = page.getByRole("button", { name: "Update now" })
  await expect(updateNow).toBeVisible()
  await expect(page.getByText("docker compose -f deploy/docker-compose.yml pull")).toBeHidden()

  await updateNow.click()
  await expect(page.getByText("Updating MasterHand… the server will restart.")).toBeVisible()
  await expect(page.getByRole("button", { name: "Updating…" })).toBeDisabled()

  // Simulate the restarted server reporting the new version; the bounded
  // status poll observes it and the action reconciles to "updated".
  runningVersion = "9.9.9"
  await expect(page.getByText("Updated to 9.9.9. Reload to use the new build.")).toBeVisible({
    timeout: 10_000,
  })
  await expect(page.getByRole("button", { name: "Reload" })).toBeVisible()
})

test("a failed update trigger surfaces the typed error and keeps the notice", async ({ page }) => {
  await page.route("**/api/update", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        latest: { version: "9.9.9", tag: "v9.9.9", publishedAt: null, notes: null },
        checkedAt: Date.now(),
      }),
    })
  })
  await page.route("**/api/status", async (route) => {
    const response = await route.fetch()
    const body = (await response.json()) as Record<string, unknown>
    body.updater = { enabled: true, tracksLatest: true, track: "latest" }
    await route.fulfill({
      status: response.status(),
      contentType: "application/json",
      body: JSON.stringify(body),
    })
  })
  await page.route("**/api/update/apply", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "backup_failed" }),
    })
  })

  await login(page)
  await page.getByRole("button", { name: "Update now" }).click()
  await expect(
    page.getByText("The pre-update backup failed, so the server was not updated."),
  ).toBeVisible()
  await expect(page.getByRole("button", { name: "Update now" })).toBeEnabled()
})

test("a pinned image tag keeps the manual command with an explanation", async ({ page }) => {
  await page.route("**/api/update", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        latest: { version: "9.9.9", tag: "v9.9.9", publishedAt: null, notes: null },
        checkedAt: Date.now(),
      }),
    })
  })
  await page.route("**/api/status", async (route) => {
    const response = await route.fetch()
    const body = (await response.json()) as Record<string, unknown>
    body.updater = { enabled: true, tracksLatest: false, track: "0.1.0" }
    await route.fulfill({
      status: response.status(),
      contentType: "application/json",
      body: JSON.stringify(body),
    })
  })

  await login(page)
  await expect(page.getByText("docker compose -f deploy/docker-compose.yml pull")).toBeVisible()
  await expect(page.getByText(/One-click updates need a floating image tag/)).toBeVisible()
  await expect(page.getByRole("button", { name: "Update now" })).toBeHidden()
})

test("an unknown upstream (latest:null) shows no notice and no error", async ({ page }) => {  await page.route("**/api/update", async (route) => {
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
