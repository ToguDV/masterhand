import { expect, test, type Page } from "@playwright/test"
import { login } from "./helpers"

const MOCK_URL = "http://127.0.0.1:4097"

test.beforeEach(async ({ request }) => {
  await request.post(`${MOCK_URL}/e2e/reset-integrations`)
})

async function openSettings(page: Page) {
  await page.getByRole("button", { name: "Settings" }).click()
  const settings = page.getByRole("dialog", { name: "Settings" })
  await settings.getByRole("button", { name: "Providers" }).click()
  return settings
}

// Settings > Providers : add a custom OpenAI-compatible provider.
test("adds and removes an OpenAI-compatible provider ", async ({ page }) => {
  await login(page)
  const settings = await openSettings(page)

  // The add action sits above the list, not inside it.
  await settings.getByTestId("add-custom-provider").click()
  const dialog = page.getByRole("dialog", { name: "Add OpenAI-compatible provider" })
  await expect(dialog).toBeVisible()

  // Typing the name derives the provider id.
  await dialog.getByLabel("Display name", { exact: true }).fill("Acme AI")
  await expect(dialog.getByLabel("Provider id")).toHaveValue("acme-ai")
  // The mock serves this base URL's `/models` (OpenAI shape).
  await dialog.getByLabel("Base URL").fill(MOCK_URL)
  await dialog.getByLabel("API key").fill("sk-acme-secret")
  // Models are discovered from the provider, never typed.
  await expect(dialog.getByText("2 models loaded from the provider.")).toBeVisible()
  await dialog.getByRole("button", { name: "Add provider" }).click()

  await expect(dialog).toHaveCount(0)
  const card = settings.getByTestId("custom-provider-acme-ai")
  await expect(card).toContainText("Acme AI")
  await expect(card).toContainText(MOCK_URL)
  await expect(card).toContainText("Connected")
  // The key is write-only: never echoed back.
  await expect(page.getByText("sk-acme-secret")).toHaveCount(0)

  // Removing asks for confirmation and cleans the config.
  await card.getByRole("button", { name: "Remove" }).click()
  await card.getByRole("button", { name: "Yes" }).click()
  await expect(settings.getByTestId("custom-provider-acme-ai")).toHaveCount(0)
})

test("rejects an invalid provider id ", async ({ page }) => {
  await login(page)
  const settings = await openSettings(page)
  await settings.getByTestId("add-custom-provider").click()

  const dialog = page.getByRole("dialog", { name: "Add OpenAI-compatible provider" })
  await dialog.getByLabel("Display name", { exact: true }).fill("My Provider")
  // A space is not allowed in an id, so submit stays disabled.
  await dialog.getByLabel("Provider id").fill("My Provider")
  await dialog.getByLabel("Base URL").fill("https://api.example/v1")
  await expect(dialog.getByRole("button", { name: "Add provider" })).toBeDisabled()
})

// Settings > Providers : the model list is filled from the provider, not typed.
test("loads the provider's models automatically ", async ({ page }) => {
  await login(page)
  const settings = await openSettings(page)
  await settings.getByTestId("add-custom-provider").click()
  const dialog = page.getByRole("dialog", { name: "Add OpenAI-compatible provider" })

  await dialog.getByLabel("Display name", { exact: true }).fill("Acme AI")
  await dialog.getByLabel("Base URL").fill(MOCK_URL)
  await dialog.getByLabel("API key").fill("sk-acme-secret")

  // No model id was typed: the list comes from the provider's /models response.
  await expect(dialog.getByText("2 models loaded from the provider.")).toBeVisible()
  await expect(dialog.getByText("acme-coder")).toBeVisible()
  await expect(dialog.getByText("acme-mini")).toBeVisible()
  await expect(dialog.getByText("Acme Coder")).toBeVisible()
  // There is no manual model entry left.
  await expect(dialog.getByLabel("Model id")).toHaveCount(0)
  await expect(dialog.getByRole("button", { name: "Add model" })).toHaveCount(0)
})

test("reports a provider that does not expose models ", async ({ page }) => {
  await login(page)
  const settings = await openSettings(page)
  await settings.getByTestId("add-custom-provider").click()
  const dialog = page.getByRole("dialog", { name: "Add OpenAI-compatible provider" })

  await dialog.getByLabel("Display name", { exact: true }).fill("Acme AI")
  // The mock 404s unknown paths, so `/nope/models` has no model list.
  await dialog.getByLabel("Base URL").fill(`${MOCK_URL}/nope`)
  await dialog.getByLabel("API key").fill("sk-acme-secret")
  await expect(dialog.getByText("This provider does not expose models.")).toBeVisible()
  // Creation is blocked until at least one model is loaded.
  await expect(dialog.getByRole("button", { name: "Add provider" })).toBeDisabled()
})
