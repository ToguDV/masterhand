import { expect, test, type Page } from "@playwright/test"
import { login } from "./helpers"

const MOCK_URL = "http://127.0.0.1:4097"

test.beforeEach(async ({ request }) => {
  await request.post(`${MOCK_URL}/e2e/reset-integrations`)
})

async function openSettings(page: Page) {
  await page.getByRole("button", { name: "Settings" }).click()
  return page.getByRole("dialog", { name: "Settings" })
}

// Settings > Providers (#128): connect an API key without host access.
test("connects an OpenCode Go API key from settings (#128)", async ({ page }) => {
  await login(page)
  const settings = await openSettings(page)

  // OpenCode Go is pinned first and starts disconnected.
  const go = settings.getByTestId("integration-opencode-go")
  await expect(go).toContainText("OpenCode Go")
  await expect(go.getByRole("button", { name: "Connect" })).toBeVisible()

  await go.getByRole("button", { name: "Connect" }).click()
  const keyDialog = page.getByRole("dialog", { name: "Connect OpenCode Go" })
  await keyDialog.getByLabel("API key").fill("sk-e2e-secret")
  await keyDialog.getByLabel("Key label").fill("E2E key")
  await keyDialog.getByRole("button", { name: "Connect" }).click()

  await expect(keyDialog).toHaveCount(0)
  await expect(go).toContainText("Connected")
  await expect(go).toContainText("E2E key")
  // The key is write-only: never echoed back anywhere.
  await expect(page.getByText("sk-e2e-secret")).toHaveCount(0)

  // Disconnect asks for confirmation first.
  await go.getByRole("button", { name: "Disconnect" }).click()
  await expect(go).toContainText("Disconnect?")
  await go.getByRole("button", { name: "Yes" }).click()
  await expect(go.getByRole("button", { name: "Connect" })).toBeVisible()
  await expect(go).not.toContainText("Connected")
})

test("rejects an invalid key with a clear message (#128)", async ({ page }) => {
  await login(page)
  const settings = await openSettings(page)
  const go = settings.getByTestId("integration-opencode-go")
  await go.getByRole("button", { name: "Connect" }).click()

  const keyDialog = page.getByRole("dialog", { name: "Connect OpenCode Go" })
  await keyDialog.getByLabel("API key").fill("bad-key")
  await keyDialog.getByRole("button", { name: "Connect" }).click()

  await expect(keyDialog.getByText(/rejected that key/)).toBeVisible()
  await expect(settings.getByTestId("integration-opencode-go")).not.toContainText("Connected")
})

test("keeps oauth providers informational (#128)", async ({ page }) => {
  await login(page)
  const settings = await openSettings(page)

  // GitHub has no vendored logo, so it ranks past the first page.
  await settings.getByRole("button", { name: /Show all/ }).click()
  const github = settings.getByTestId("integration-github")
  await expect(github).toContainText("opencode CLI/TUI")
  await expect(github.getByRole("button", { name: "Connect" })).toHaveCount(0)
})

test("renders the original provider logos in the list (#128)", async ({ page }) => {
  await login(page)
  const settings = await openSettings(page)

  // A provider with a vendored brand mark renders the original logo inline.
  const anthropic = settings.getByTestId("integration-anthropic")
  await expect(anthropic.getByTestId("provider-avatar").locator("svg")).toHaveCount(1)

  // A provider without one keeps the deterministic monogram (mock "github").
  // It sits past the first page now that logo-bearing providers rank first.
  await settings.getByRole("button", { name: /Show all/ }).click()
  const github = settings.getByTestId("integration-github")
  await expect(github.getByTestId("provider-avatar")).toHaveText("G")
  await expect(github.getByTestId("provider-avatar").locator("svg")).toHaveCount(0)
})

test("paginates the provider list and searches it (#128)", async ({ page }) => {
  await login(page)
  const settings = await openSettings(page)

  // Only the first five are rendered; OpenCode Go is pinned first.
  const rows = settings.locator('[data-testid^="integration-"]')
  await expect(rows).toHaveCount(5)
  await expect(rows.first()).toHaveAttribute("data-testid", "integration-opencode-go")
  // Every row carries a provider avatar before its name.
  await expect(settings.getByTestId("provider-avatar")).toHaveCount(5)

  await settings.getByRole("button", { name: "Show all 7 providers" }).click()
  await expect(rows).toHaveCount(7)

  // The search filters across the whole catalog (not only the visible page).
  await settings.getByLabel("Search providers").fill("git")
  await expect(settings.locator('[data-testid^="integration-"]')).toHaveCount(2)
  await expect(settings.getByTestId("integration-github")).toBeVisible()
  await expect(settings.getByTestId("integration-gitlab")).toBeVisible()
  await expect(settings.getByTestId("integration-opencode-go")).toHaveCount(0)

  await settings.getByLabel("Search providers").fill("nope-nothing")
  await expect(settings.getByText("No provider matches that search.")).toBeVisible()
})
