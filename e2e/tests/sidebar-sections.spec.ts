import { expect, test } from "@playwright/test"
import { addWorkspace, login, newSession } from "./helpers"

test("the sidebar rail switches the main view between sessions and board", async ({ page }) => {
  await login(page)
  await addWorkspace(page)
  const aside = page.locator("aside")
  // Sessions is open by default in the expanded panel.
  await expect(aside.getByRole("heading", { name: "Sessions", exact: true })).toBeVisible()

  // Collapsing swaps the panel for a single icon rail: no second list beside it.
  await aside.getByRole("button", { name: "Collapse sidebar" }).click()
  const rail = aside.locator('nav[aria-label="Sections"]')
  await expect(rail.getByRole("button", { name: "Sessions section" })).toBeVisible()
  await expect(rail.getByRole("button", { name: "Board section" })).toBeVisible()
  await expect(aside.getByRole("heading", { name: "Sessions", exact: true })).toBeHidden()

  // The board section is empty for now: selecting it swaps the main view.
  await rail.getByRole("button", { name: "Board section" }).click()
  await expect(page.locator("main").getByRole("heading", { name: "Board" })).toBeVisible()

  // Back in sessions with no open session: the empty state stays.
  await rail.getByRole("button", { name: "Sessions section" }).click()
  await expect(page.getByRole("heading", { name: "No session open" })).toBeVisible()

  // Expanding brings the sessions panel back and unmounts the rail.
  await aside.getByRole("button", { name: "Expand sidebar" }).click()
  await expect(aside.getByRole("heading", { name: "Sessions", exact: true })).toBeVisible()
  await expect(rail).toBeHidden()
})

test("selecting sessions opens the most recent session", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page)
  await addWorkspace(page)
  await page.locator("header").getByRole("button", { name: "Sessions" }).click()
  await newSession(page)
  await expect(page.getByPlaceholder("Write a message…")).toBeVisible()
  // Back leaves the session list intact with nothing open.
  await page.getByRole("button", { name: "Back" }).click()
  await expect(page.getByRole("heading", { name: "No session open" })).toBeVisible()

  const drawer = page.locator("aside")
  await page.locator("header").getByRole("button", { name: "Sessions" }).click()
  // The drawer shows the panel (no rail beside it): go home and pick Board.
  await drawer.getByRole("button", { name: "Back to sections" }).click()
  await drawer.getByRole("button", { name: "Board", exact: true }).click()
  // The drawer covers the overlay center: dismiss it tapping past its edge.
  await page.locator(".mh-overlay").click({ position: { x: 380, y: 400 } })
  await expect(page.locator("main").getByRole("heading", { name: "Board" })).toBeVisible()

  await page.locator("header").getByRole("button", { name: "Sessions" }).click()
  await drawer.getByRole("button", { name: "Back to sections" }).click()
  await drawer.getByRole("button", { name: "Sessions", exact: true }).click()
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
