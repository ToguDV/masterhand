import { expect, test, type Page } from "@playwright/test"
import { addWorkspace, login, newSession } from "./helpers"

/**
 * Picks a theme through the settings sheet (Appearance shows one teardrop per
 * explicit theme; there is no system-following mode).
 */
async function selectThemeMode(page: Page, name: "Light" | "Dark"): Promise<void> {
  await page.getByRole("button", { name: "Settings" }).click()
  await page.getByRole("dialog", { name: "Settings" }).getByRole("radio", { name, exact: true }).click()
  await page.getByRole("button", { name: "Close settings" }).click()
}

test("switches between light and dark themes from settings and remembers the choice", async ({ page }) => {
  await login(page)
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light")
  // The tokens follow `color-scheme`, so assert the actual paint, not only the
  // attribute: the old bug left the attribute right while the UI stayed dark.
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor))
    .toBe("rgb(250, 250, 247)")

  await selectThemeMode(page, "Dark")
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor))
    .toBe("rgb(12, 12, 11)")

  await page.reload()
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor))
    .toBe("rgb(12, 12, 11)")

  // The panel reflects the stored choice, and there is no system option.
  await page.getByRole("button", { name: "Settings" }).click()
  await expect(page.getByRole("radio", { name: "Dark", exact: true })).toHaveAttribute("aria-checked", "true")
  await expect(page.getByRole("radio", { name: "Light", exact: true })).toHaveAttribute("aria-checked", "false")
  await expect(page.getByRole("dialog", { name: "Settings" }).getByText("Theme color")).toBeVisible()
  await expect(page.getByRole("radio", { name: "System" })).toHaveCount(0)
  await page.getByRole("button", { name: "Close settings" }).click()

  await selectThemeMode(page, "Light")
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light")
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor))
    .toBe("rgb(250, 250, 247)")
})

test("switches color theme from settings and remembers it", async ({ page }) => {
  await login(page)
  await expect(page.locator("html")).not.toHaveAttribute("data-palette", "dracula")

  await page.getByRole("button", { name: "Settings" }).click()
  const dialog = page.getByRole("dialog", { name: "Settings" })
  await dialog.getByRole("radio", { name: "Dracula" }).click()
  await expect(page.locator("html")).toHaveAttribute("data-palette", "dracula")
  await expect(dialog.getByRole("radio", { name: "Dracula" })).toHaveAttribute("aria-checked", "true")
  await page.getByRole("button", { name: "Close settings" }).click()

  await page.reload()
  await expect(page.locator("html")).toHaveAttribute("data-palette", "dracula")

  // Reset goes back to the default paper.
  await page.getByRole("button", { name: "Settings" }).click()
  await page.getByRole("button", { name: /Reset to Paper/ }).click()
  await expect(page.locator("html")).toHaveAttribute("data-palette", "paper")
})

test("signs out from the sessions panel options, not from the top bar", async ({ page }) => {
  await login(page)
  // Sign out lives in the bottom-left options box of the sessions panel.
  const options = page.locator("aside").getByRole("button", { name: "Sign out" })
  await expect(options).toBeVisible()
  await options.click()
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible()
})

test("collapses the sessions sidebar into an icon rail on desktop", async ({ page }) => {
  await login(page)
  const aside = page.locator("aside")
  await aside.getByRole("button", { name: "Collapse sidebar" }).click()
  // The full panel hides, leaving the rail with its icon actions.
  const sessionsHeading = aside.getByRole("heading", { name: "Sessions", exact: true })
  await expect(sessionsHeading).toBeHidden()
  await expect(aside.getByRole("button", { name: "Expand sidebar" })).toBeVisible()
  await expect(aside.getByRole("button", { name: "Sign out" })).toBeVisible()

  // The choice survives a reload.
  await page.reload()
  await expect(aside.getByRole("button", { name: "Expand sidebar" })).toBeVisible()
  await aside.getByRole("button", { name: "Expand sidebar" }).click()
  await expect(sessionsHeading).toBeVisible()
  await expect(aside.getByRole("button", { name: "Sign out" })).toBeVisible()
})

test("paints the user bubble deep emerald, never the brightest surface", async ({ page }) => {
  await login(page)
  await addWorkspace(page)
  await newSession(page)
  await page.getByPlaceholder("Write a message…").fill("hello agent")
  await page.getByRole("button", { name: "Send" }).click()

  const bubble = page.locator(".mh-msg--user").first()
  await expect(bubble).toBeVisible()
  await expect
    .poll(() => bubble.evaluate((element) => getComputedStyle(element).backgroundColor))
    .toBe("rgb(8, 80, 65)") // emerald-800 on the light theme

  await selectThemeMode(page, "Dark")
  await expect
    .poll(() => bubble.evaluate((element) => getComputedStyle(element).backgroundColor))
    .toBe("rgb(6, 55, 44)") // emerald-900: a dark green fill, not a light one
})

test("renders permission requests inline in the transcript, not as a modal", async ({ page }) => {
  await login(page)
  await addWorkspace(page)

  await newSession(page)
  const composer = page.getByPlaceholder("Write a message…")
  await composer.fill("hello agent")
  await page.getByRole("button", { name: "Send" }).click()

  const card = page.locator("main").getByTestId("permission-card")
  await expect(card).toBeVisible()
  await expect(card.getByText("Permission requested")).toBeVisible()
  await expect(page.getByRole("dialog")).toHaveCount(0)

  await card.getByRole("button", { name: "Allow once" }).click()
  await expect(page.locator("main").getByTestId("permission-resolved")).toContainText("Allowed once")
  await expect(page.getByText("Done!")).toBeVisible()
})

test("answers a question from another session through the choice modal", async ({ page }) => {
  await login(page)
  await addWorkspace(page)

  await newSession(page)
  const composer = page.getByPlaceholder("Write a message…")
  await composer.fill("ask me a question")
  await page.getByRole("button", { name: "Send" }).click()
  await expect(page.getByTestId("question-card")).toBeVisible()

  // A second session: the pending question now belongs to another session and
  // must stay reachable instead of blocking its agent invisibly.
  await newSession(page)
  const dialog = page.getByRole("dialog", { name: "Question from another session" })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText("Which database should the project use?")).toBeVisible()

  await dialog.getByRole("button", { name: "Not now" }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByText("The agent is waiting for your answer · Open session")).toBeVisible()

  await page.getByRole("button", { name: /waiting for your answer/ }).click()
  await expect(page.getByTestId("question-card")).toBeVisible()
})

test("keeps later other-session questions reachable after dismissing one", async ({ page }) => {
  await login(page)
  await addWorkspace(page)

  // Session A asks, and its modal is postponed from session B.
  await newSession(page)
  await page.getByPlaceholder("Write a message…").fill("ask me a question")
  await page.getByRole("button", { name: "Send" }).click()
  await expect(page.getByTestId("question-card")).toBeVisible()

  await newSession(page)
  const dialog = page.getByRole("dialog", { name: "Question from another session" })
  await expect(dialog).toBeVisible()
  await dialog.getByRole("button", { name: "Not now" }).click()
  await expect(dialog).toBeHidden()

  // Session B asks too; the third session must surface B even though A was
  // dismissed earlier — not stay wedged on the dismissed form.
  await page.getByPlaceholder("Write a message…").fill("ask me a question")
  await page.getByRole("button", { name: "Send" }).click()
  await expect(page.getByTestId("question-card")).toBeVisible()

  await newSession(page)
  await expect(dialog).toBeVisible()
  await dialog.getByRole("button", { name: "Not now" }).click()
  await expect(page.getByText("The agent is waiting for your answer · Open session")).toBeVisible()
})

test("opens the session list as a drawer on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page)
  await addWorkspace(page)
  // On mobile the list (and its new-session action) lives in the drawer.
  await page.getByRole("button", { name: "Sessions" }).click()
  await newSession(page)
  await expect(page.getByPlaceholder("Write a message…")).toBeVisible()

  const drawer = page.locator("aside")
  await expect(drawer).toBeHidden()
  await page.getByRole("button", { name: "Sessions" }).click()
  await expect(drawer).toBeVisible()
  await expect(drawer.getByText("Sessions")).toBeVisible()
  // The desktop edge handle has no use here and stays hidden.
  await expect(drawer.getByRole("button", { name: /sidebar/i })).toBeHidden()

  await drawer.getByRole("button", { name: /Untitled/ }).click()
  await expect(drawer).toBeHidden()
  await expect(page.getByPlaceholder("Write a message…")).toBeVisible()
})
