import { expect, test, type Page } from "@playwright/test"
import { login } from "./helpers"

const MOCK_URL = "http://127.0.0.1:4097"

test.beforeEach(async ({ request }) => {
  await request.post(`${MOCK_URL}/e2e/reset-integrations`)
})

async function openWebSearch(page: Page) {
  await page.getByRole("button", { name: "Settings" }).click()
  const settings = page.getByRole("dialog", { name: "Settings" })
  // Web search is a module in the settings nav; Appearance opens by default.
  await settings.getByRole("button", { name: "Web search" }).click()
  return settings
}

// Settings > Web search: the default source opencode uses for agent web
// searches, the per-source API keys and the test probe. Runs first: it asserts
// the boot-seeded keyless default (file order, single worker).
test("seeds the keyless source as the default and keeps sources out of Providers", async ({ page }) => {
  await login(page)
  const settings = await openWebSearch(page)

  const tinyfish = settings.getByTestId("websearch-source-tinyfish")
  await expect(tinyfish).toContainText("TinyFish")
  await expect(tinyfish).toContainText("No API key required")
  await expect(tinyfish.getByRole("radio")).toHaveAttribute("aria-checked", "true")

  // The built-in sources are integrations too, but they are not model
  // providers: they must not show up in the Providers catalog.
  await settings.getByRole("button", { name: "Providers" }).click()
  await settings.getByRole("button", { name: /Show all/ }).click()
  await expect(settings.getByTestId("integration-opencode-go")).toBeVisible()
  await expect(settings.getByTestId("integration-tavily")).toHaveCount(0)
  await expect(settings.getByTestId("integration-tinyfish")).toHaveCount(0)
})

test("switches the default source, persists it and connects its key", async ({ page }) => {
  await login(page)
  const settings = await openWebSearch(page)

  const tavily = settings.getByTestId("websearch-source-tavily")
  await tavily.getByRole("radio").click()
  await expect(tavily.getByRole("radio")).toHaveAttribute("aria-checked", "true")

  // The write lands in the BFF's config file: a full reload refetches it.
  await page.reload()
  const reopened = await openWebSearch(page)
  await expect(reopened.getByTestId("websearch-source-tavily").getByRole("radio")).toHaveAttribute(
    "aria-checked",
    "true",
  )

  await reopened.getByTestId("websearch-source-tavily").getByRole("button", { name: "Connect" }).click()
  const keyDialog = page.getByRole("dialog", { name: "Connect Tavily" })
  await keyDialog.getByLabel("API key").fill("tvly-e2e-secret")
  await keyDialog.getByLabel("Key label").fill("E2E key")
  await keyDialog.getByRole("button", { name: "Connect" }).click()

  await expect(keyDialog).toHaveCount(0)
  const connected = reopened.getByTestId("websearch-source-tavily")
  await expect(connected).toContainText("Connected")
  await expect(connected).toContainText("E2E key")
  // The key is write-only: never echoed back anywhere.
  await expect(page.getByText("tvly-e2e-secret")).toHaveCount(0)

  // Disconnect asks for confirmation first.
  await connected.getByRole("button", { name: "Disconnect" }).click()
  await expect(connected).toContainText("Disconnect?")
  await connected.getByRole("button", { name: "Yes" }).click()
  await expect(connected.getByRole("button", { name: "Connect" })).toBeVisible()
  await expect(connected).not.toContainText("Connected")
})

test("runs a test search with the current source", async ({ page }) => {
  await login(page)
  const settings = await openWebSearch(page)

  // Previous tests may have switched the default; pin the keyless one first.
  await settings.getByTestId("websearch-source-tinyfish").getByRole("radio").click()
  await settings.getByLabel("Test search query").fill("effect typescript")
  await settings.getByRole("button", { name: "Test" }).click()

  await expect(settings.getByText("Answered by")).toContainText("TinyFish")
  await expect(settings.getByRole("link", { name: "Effect documentation" })).toBeVisible()
})
