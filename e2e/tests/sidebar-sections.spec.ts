import { expect, test } from "@playwright/test"
import { addWorkspace, login, newSession } from "./helpers"

test("the sidebar rail switches the main view between sessions and board", async ({ page }) => {
  await login(page)
  await addWorkspace(page)
  const aside = page.locator("aside")
  // Sessions is open by default in the expanded panel (filters + new action).
  await expect(aside.getByRole("button", { name: "New session" })).toBeVisible()

  // Collapsing swaps the panel for a single icon rail: no second list beside it.
  await aside.getByRole("button", { name: "Collapse sidebar" }).click()
  const rail = aside.locator('nav[aria-label="Sections"]')
  await expect(rail.getByRole("button", { name: "Sessions section" })).toBeVisible()
  await expect(rail.getByRole("button", { name: "Board section" })).toBeVisible()
  await expect(aside.getByRole("button", { name: "New session" })).toBeHidden()

  // The board section is empty for now: selecting it swaps the main view.
  await rail.getByRole("button", { name: "Board section" }).click()
  await expect(page.locator("main").getByRole("heading", { name: "Board" })).toBeVisible()

  // Back in sessions with no open session: the empty state stays.
  await rail.getByRole("button", { name: "Sessions section" }).click()
  await expect(page.getByRole("heading", { name: "No session open" })).toBeVisible()

  // Collapsed but in a detail, the header < is still there: it expands home.
  const header = page.locator("header")
  await header.getByRole("button", { name: "Back to sections" }).click()
  await expect(aside.getByRole("button", { name: "Sessions", exact: true })).toBeVisible()
  await expect(rail).toBeHidden()
  await expect(aside.getByRole("button", { name: "Collapse sidebar" })).toBeVisible()
})

test("selecting sessions opens the most recent session", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page)
  await addWorkspace(page)
  await page.locator("header").getByRole("button", { name: "Sessions" }).click()
  await newSession(page)
  await expect(page.getByPlaceholder("Write a message…")).toBeVisible()
  // A single back arrow: session open means it closes the session.
  const header = page.locator("header")
  await expect(header.getByRole("button", { name: /Back/ })).toHaveCount(1)
  // Back leaves the session list intact with nothing open.
  await page.getByRole("button", { name: "Back", exact: true }).click()
  await expect(page.getByRole("heading", { name: "No session open" })).toBeVisible()

  const drawer = page.locator("aside")
  // Home lives behind the header <: go back, then open the drawer on it.
  await header.getByRole("button", { name: "Back to sections" }).click()
  await header.getByRole("button", { name: "Sessions" }).click()
  await drawer.getByRole("button", { name: "Board", exact: true }).click()
  // The drawer covers the overlay center: dismiss it tapping past its edge.
  await page.locator(".mh-overlay").click({ position: { x: 380, y: 400 } })
  await expect(page.locator("main").getByRole("heading", { name: "Board" })).toBeVisible()

  await header.getByRole("button", { name: "Back to sections" }).click()
  await header.getByRole("button", { name: "Sessions" }).click()
  await drawer.getByRole("button", { name: "Sessions", exact: true }).click()
  await expect.poll(() => new URL(page.url()).searchParams.get("session")).not.toBeNull()
})

test("the header back button returns to the sections home", async ({ page }) => {
  await login(page)
  const aside = page.locator("aside")
  const header = page.locator("header")
  // The < sits left of the title while a section panel is showing.
  await header.getByRole("button", { name: "Back to sections" }).click()
  await expect(aside.getByRole("button", { name: "Board", exact: true })).toBeVisible()
  // The home hides itself once a section is picked.
  await aside.getByRole("button", { name: "Board", exact: true }).click()
  // The board follows the selected workspace, and earlier specs in the same
  // run leave workspaces behind on the shared backend: a fresh context may
  // land on an empty board (Board heading + empty state) or on a board with
  // columns (column scroll, no heading). Either proves the board content
  // mounted — unlike the header title, which is visible before the click.
  const main = page.locator("main")
  const boardHeading = main.getByRole("heading", { name: "Board" })
  const boardColumns = main.locator('div[aria-label="Board columns"]')
  await expect(boardHeading.or(boardColumns)).toBeVisible()
  await expect(main.getByRole("button", { name: "Workspace" })).toBeVisible()
  await expect(header.getByRole("button", { name: "Back to sections" })).toBeVisible()
})
