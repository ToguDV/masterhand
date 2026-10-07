import { expect, test } from "@playwright/test"
import { addWorkspace, login, newSession } from "./helpers"

test("rejects a wrong password", async ({ page }) => {
  await page.goto("/")
  await page.locator("#password").fill("not-the-password")
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page.getByText("Wrong password")).toBeVisible()
})

test("login, create a session, stream a reply and approve a permission", async ({ page }) => {
  await login(page)
  await addWorkspace(page)

  await expect(page.getByRole("button", { name: "New session" })).toBeEnabled()
  await newSession(page)

  const composer = page.getByPlaceholder("Write a message…")
  await expect(composer).toBeVisible()
  await composer.fill("hello agent")
  await page.getByRole("button", { name: "Send" }).click()

  await expect(page.getByText("hello agent")).toBeVisible()

  await expect(page.getByText("Permission requested")).toBeVisible()
  await expect(page.getByTestId("permission-kind")).toHaveText("bash")
  await expect(page.getByTestId("permission-patterns")).toHaveText("ls")
  await page.getByRole("button", { name: "Once" }).click()

  await expect(page.getByText("Done!")).toBeVisible()
  // Icons + numbers only; labels live in the tooltips. Scope to the session
  // stats: the completed message renders the same compact language (#126).
  const sessionStats = page.locator('[aria-label="Session usage"]')
  await expect(sessionStats.getByTitle("Cost")).toHaveText("$0.0010")
  await expect(sessionStats.getByTitle("Input tokens")).toContainText("10")
  await expect(sessionStats.getByTitle("Output tokens")).toContainText("1")
  // Cache read/write are never rendered, even when the model reports them.
  await expect(sessionStats.getByTitle("Cache read tokens")).toHaveCount(0)
  await expect(sessionStats.getByTitle("Cache write tokens")).toHaveCount(0)

  // The per-message stats use the same icon language, not the old text chain.
  const messageStats = page.locator('[aria-label="Message usage"]')
  await expect(messageStats.getByTitle("Cost")).toHaveText("$0.0010")
  await expect(messageStats.getByTitle("Input tokens")).toContainText("10")
  await expect(messageStats.getByTitle("Output tokens")).toContainText("1")
  await expect(page.getByText(/input ·/)).toHaveCount(0)
  await expect(page.getByText("Permission requested")).toBeHidden()
})

test("recovers a pending permission after a reload", async ({ page }) => {
  await login(page)
  await addWorkspace(page)

  await newSession(page)
  const composer = page.getByPlaceholder("Write a message…")
  await composer.fill("hello agent")
  await page.getByRole("button", { name: "Send" }).click()

  await expect(page.getByText("Permission requested")).toBeVisible()

  // The stream does not replay `permission.asked`; the client must reconcile.
  await page.reload()

  await expect(page.getByText("Permission requested")).toBeVisible()
  await expect(page.getByTestId("permission-kind")).toHaveText("bash")
  await page.getByRole("button", { name: "Once" }).click()

  await expect(page.getByText("Done!")).toBeVisible()
})
