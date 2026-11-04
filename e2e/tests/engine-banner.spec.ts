import { expect, test } from "../fixtures"
import { login } from "./helpers"

/**
 * Resilience banner semantics. A supervisor that cannot resolve the Compose
 * project (or is unreachable) answers `state: "unknown"`; the UI must warn
 * about the monitoring gap instead of claiming the engine is stopped and
 * offering a Start button that answers `404 not_found`.
 */
const ENGINE = {
  supervisor: true,
  healthy: true,
  restarting: false,
  circuitOpen: false,
  state: "unknown",
  memoryWarning: false,
  attempts: 0,
  maxAttempts: 3,
  lastIncident: null,
  memory: null,
  serverIncident: null,
  serverCircuitOpen: false,
  interruptedTurns: 0,
  autoResume: true,
  autoContinueChats: true,
}

async function mockEngineState(page: import("@playwright/test").Page, state: string): Promise<void> {
  await page.route("**/api/status", async (route) => {
    const response = await route.fetch()
    const body = (await response.json()) as Record<string, unknown>
    body.engine = { ...ENGINE, state }
    await route.fulfill({
      status: response.status(),
      contentType: "application/json",
      body: JSON.stringify(body),
    })
  })
}

test("an unknown engine state warns without offering a dead Start button", async ({ page }) => {
  await mockEngineState(page, "unknown")
  await login(page)
  await expect(page.getByText(/cannot see the agent engine/i)).toBeVisible()
  await expect(page.getByRole("button", { name: "Start engine" })).toHaveCount(0)
})

test("a stopped engine still offers Start", async ({ page }) => {
  await mockEngineState(page, "exited")
  await login(page)
  await expect(page.getByText(/agent engine is stopped/i)).toBeVisible()
  await expect(page.getByRole("button", { name: "Start engine" })).toBeVisible()
})
