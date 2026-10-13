import { expect, test } from "@playwright/test"
import { addWorkspace, login, newSession } from "./helpers"

test("the sidebar rail switches the main view between sessions and board", async ({ page }) => {
  await login(page)
  await addWorkspace(page)
  const aside = page.locator("aside")
  const rail = aside.locator('nav[aria-label="Sections"]')

  await expect(rail.getByRole("button", { name: "Sessions section" })).toBeVisible()
  await expect(rail.getByRole("button", { name: "Board section" })).toBeVisible()
  // Sessions is open by default.
  await expect(aside.getByRole("heading", { name: "Sessions", exact: true })).toBeVisible()

  // The board section is empty for now: selecting it swaps the main view.
  await rail.getByRole("button", { name: "Board section" }).click()
  await expect(page.locator("main").getByRole("heading", { name: "Board" })).toBeVisible()

  // Back in sessions with no open session: the empty state stays.
  await rail.getByRole("button", { name: "Sessions section" }).click()
  await expect(page.getByRole("heading", { name: "No session open" })).toBeVisible()
})

test("selecting sessions opens the most recent session", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page)
  await addWorkspace(page)
  await page.getByRole("button", { name: "Sessions" }).click()
  await newSession(page)
  await expect(page.getByPlaceholder("Write a message…")).toBeVisible()
  // Back leaves the session list intact with nothing open.
  await page.getByRole("button", { name: "Back" }).click()
  await expect(page.getByRole("heading", { name: "No session open" })).toBeVisible()

  const drawer = page.locator("aside")
  const rail = drawer.locator('nav[aria-label="Sections"]')
  await page.getByRole("button", { name: "Sessions" }).click()
  await rail.getByRole("button", { name: "Board section" }).click()
  // The drawer covers the overlay center: dismiss it tapping past its edge.
  await page.locator(".mh-overlay").click({ position: { x: 380, y: 400 } })
  await expect(page.locator("main").getByRole("heading", { name: "Board" })).toBeVisible()

  await page.getByRole("button", { name: "Sessions" }).click()
  await rail.getByRole("button", { name: "Sessions section" }).click()
  await expect.poll(() => new URL(page.url()).searchParams.get("session")).not.toBeNull()
})

test("the panel back button returns to the sections home", async ({ page }) => {
  await login(page)
  const aside = page.locator("aside")
  await aside.getByRole("button", { name: "Back to sections" }).click()
  await expect(aside.getByRole("heading", { name: "Sections" })).toBeVisible()
  await aside.getByRole("button", { name: "Board", exact: true }).click()
  await expect(page.locator("main").getByRole("heading", { name: "Board" })).toBeVisible()
  await expect(aside.getByRole("heading", { name: "Board" })).toBeVisible()
})
