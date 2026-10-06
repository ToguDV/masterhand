import { expect, test } from "@playwright/test"
import { addWorkspace, login, newSession } from "./helpers"

test("switches between light and dark themes and remembers the choice", async ({ page }) => {
  await login(page)
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light")
  // The tokens follow `color-scheme`, so assert the actual paint, not only the
  // attribute: the old bug left the attribute right while the UI stayed dark.
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor))
    .toBe("rgb(250, 250, 247)")

  await page.getByRole("button", { name: "Switch to dark theme" }).click()
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor))
    .toBe("rgb(12, 12, 11)")

  await page.reload()
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor))
    .toBe("rgb(12, 12, 11)")
  await expect(page.getByRole("button", { name: "Switch to light theme" })).toBeVisible()

  await page.getByRole("button", { name: "Switch to light theme" }).click()
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light")
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor))
    .toBe("rgb(250, 250, 247)")
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

  await page.getByRole("button", { name: "Switch to dark theme" }).click()
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

  await page.getByRole("button", { name: "Open session" }).click()
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

  await drawer.getByRole("button", { name: /Untitled/ }).click()
  await expect(drawer).toBeHidden()
  await expect(page.getByPlaceholder("Write a message…")).toBeVisible()
})
