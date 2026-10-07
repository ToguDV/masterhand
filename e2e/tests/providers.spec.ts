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

  const github = settings.getByTestId("integration-github")
  await expect(github).toContainText("opencode CLI/TUI")
  await expect(github.getByRole("button", { name: "Connect" })).toHaveCount(0)
})
