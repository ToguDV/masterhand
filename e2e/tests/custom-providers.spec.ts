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
  await dialog.getByLabel("Base URL").fill("https://api.acme.example/v1")
  await dialog.getByLabel("API key").fill("sk-acme-secret")
  await dialog.getByLabel("Model id").fill("acme-coder")
  await dialog.getByRole("button", { name: "Add provider" }).click()

  await expect(dialog).toHaveCount(0)
  const card = settings.getByTestId("custom-provider-acme-ai")
  await expect(card).toContainText("Acme AI")
  await expect(card).toContainText("https://api.acme.example/v1")
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
  await dialog.getByLabel("Model id").fill("m1")
  await expect(dialog.getByRole("button", { name: "Add provider" })).toBeDisabled()
})
