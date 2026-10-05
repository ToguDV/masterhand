import { expect, test } from "@playwright/test"
import { addWorkspace, login, newSession } from "./helpers"

test("opens the command list on / and runs the selected command", async ({ page }) => {
  await login(page)
  await addWorkspace(page)
  await newSession(page)

  const composer = page.getByPlaceholder("Write a message…")
  await composer.fill("/")
  await expect(page.getByRole("option", { name: /\/component/ })).toBeVisible()

  await page.getByRole("option", { name: /\/component/ }).click()
  await expect(composer).toHaveValue("/component ")
  // The real template declares a free-form `$ARGUMENTS` placeholder.
  await expect(page.getByText("free-form arguments")).toBeVisible()

  await composer.fill("/component Button")
  await page.getByRole("button", { name: "Send" }).click()

  await expect(
    page.getByText("Create a new React component named Button with TypeScript support."),
  ).toBeVisible()
})

test("opens the subagent list on @ and inserts the mention", async ({ page }) => {
  await login(page)
  await addWorkspace(page)
  await newSession(page)

  const composer = page.getByPlaceholder("Write a message…")
  await composer.fill("@gen")
  await expect(page.getByRole("option", { name: "@general" })).toBeVisible()

  await page.getByRole("option", { name: "@general" }).click()
  await expect(composer).toHaveValue("@general ")
})

test("lists every argument value while the parameter is empty", async ({ page }) => {
  await login(page)
  await addWorkspace(page)
  await newSession(page)

  const composer = page.getByPlaceholder("Write a message…")
  await composer.fill("/review ")
  const list = page.locator("#composer-suggestions")
  await expect(list.getByRole("option", { name: "commit" })).toBeVisible()
  await expect(list.getByRole("option", { name: "branch" })).toBeVisible()
  await expect(list.getByRole("option", { name: "pr" })).toBeVisible()
})

test("suggests and inserts an argument that matches the typed content", async ({ page }) => {
  await login(page)
  await addWorkspace(page)
  await newSession(page)

  const composer = page.getByPlaceholder("Write a message…")
  await composer.fill("/review c")
  const list = page.locator("#composer-suggestions")
  await expect(list.getByRole("option", { name: "commit" })).toBeVisible()
  // Only the values that match the typed content are offered.
  await expect(list.getByRole("option", { name: "branch" })).toHaveCount(0)

  await list.getByRole("option", { name: "commit" }).click()
  await expect(composer).toHaveValue("/review commit ")
  // Picking a value closes the list instead of re-suggesting itself forever.
  await expect(list).toHaveCount(0)

  await page.getByRole("button", { name: "Send" }).click()
  await expect(page.getByText("Review the changes: commit")).toBeVisible()
})

test("hides argument suggestions that do not match the typed content", async ({ page }) => {
  await login(page)
  await addWorkspace(page)
  await newSession(page)

  const composer = page.getByPlaceholder("Write a message…")
  await composer.fill("/review zzz")

  await expect(page.locator("#composer-suggestions")).toHaveCount(0)
})

test("closes the suggestions when the composer loses focus and reopens them on focus", async ({ page }) => {
  await login(page)
  await addWorkspace(page)
  await newSession(page)

  const composer = page.getByPlaceholder("Write a message…")
  await composer.fill("/rev")
  const command = page.getByRole("option", { name: "/review" })
  await expect(command).toBeVisible()

  // Clicking outside the composer (blur) dismisses the popover…
  await composer.blur()
  await expect(command).toBeHidden()

  // …and returning to it brings the content-matched suggestion back.
  await composer.click()
  await expect(command).toBeVisible()
})

test("/btw answers a side question in a temporary session", async ({ page }) => {
  await login(page)
  await addWorkspace(page)
  await newSession(page)

  const composer = page.getByPlaceholder("Write a message…")
  await composer.fill("/btw what is this?")
  await page.getByRole("button", { name: "Send" }).click()

  await expect(page.getByText("Side question")).toBeVisible()
  await expect(page.getByText("Side answer to: what is this?")).toBeVisible()

  await page.getByRole("button", { name: "Close" }).click()
  await expect(page.getByText("Side question")).toBeHidden()
})
