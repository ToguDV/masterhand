import { expect, test } from "@playwright/test"
import { addWorkspace, login } from "./helpers"

async function openBoard(page: import("@playwright/test").Page) {
  const aside = page.locator("aside")
  const collapse = aside.getByRole("button", { name: "Collapse sidebar" })
  if (await collapse.isVisible()) await collapse.click()
  await aside.locator('nav[aria-label="Sections"]').getByRole("button", { name: "Board section" }).click()
}

test("board creates, edits and persists columns and cards per workspace", async ({ page }) => {
  await login(page)
  await addWorkspace(page)
  await openBoard(page)
  await expect(page.locator("main").getByRole("heading", { name: "Board" })).toBeVisible()

  const newColumn = page.getByLabel("New column title").first()
  await newColumn.fill("To do")
  await page.getByRole("button", { name: "Add column" }).first().click()
  await expect(page.locator('section[aria-label="Column To do"]')).toBeVisible()

  await page.getByLabel("New column title").last().fill("Done")
  await page.getByRole("button", { name: "Add column" }).last().click()
  await expect(page.locator('section[aria-label="Column Done"]')).toBeVisible()

  await page.getByLabel("New card title in To do").fill("First task")
  await page.getByRole("button", { name: "Add card to To do" }).click()
  await expect(page.getByRole("button", { name: "Edit card First task" })).toBeVisible()

  await page.getByLabel("New card title in To do").fill("Second task")
  await page.getByRole("button", { name: "Add card to To do" }).click()
  await expect(page.getByRole("button", { name: "Edit card Second task" })).toBeVisible()

  // Edit the card title + description through the dialog.
  await page.getByRole("button", { name: "Edit card First task" }).click()
  await page.locator("#board-card-title").fill("First task edited")
  await page.locator("#board-card-description").fill("Some details")
  await page.getByRole("button", { name: "Save" }).click()
  await expect(page.getByRole("button", { name: "Edit card First task edited" })).toBeVisible()
  await expect(page.getByText("Some details")).toBeVisible()

  // Rename the column inline.
  await page.getByRole("button", { name: "Rename column To do" }).click()
  await page.getByLabel("Column title", { exact: true }).fill("To do now")
  await page.getByRole("button", { name: "Save column title" }).click()
  await expect(page.locator('section[aria-label="Column To do now"]')).toBeVisible()

  // Reorder columns via the menu: Done moves left of To do now.
  const doneSection = page.locator('section[aria-label="Column Done"]')
  await doneSection.getByRole("button", { name: "Column options" }).click()
  await page.getByRole("menuitem", { name: "Move left" }).click()
  await expect.poll(async () => page.locator('div[aria-label="Board columns"] > section').first().getAttribute("aria-label")).toBe("Column Done")

  // Persistence across reload.
  await page.reload()
  await expect(page.locator('section[aria-label="Column To do now"]')).toBeVisible()
  await expect(page.getByRole("button", { name: "Edit card First task edited" })).toBeVisible()

  // Per-workspace isolation: a second workspace starts empty.
  await addWorkspace(page)
  await openBoard(page)
  const main = page.locator("main")
  await expect(main.getByRole("heading", { name: "Board" })).toBeVisible()
  await expect(main.getByText("no columns yet")).toBeVisible()
  await expect(page.locator('section[aria-label="Column To do now"]')).toBeHidden()
})

test("board drags cards within a column and across columns", async ({ page }) => {
  await login(page)
  await addWorkspace(page)
  await openBoard(page)

  for (const title of ["Backlog", "Doing"]) {
    await page.getByLabel("New column title").last().fill(title)
    await page.getByRole("button", { name: "Add column" }).last().click()
    await expect(page.locator(`section[aria-label="Column ${title}"]`)).toBeVisible()
  }

  await page.getByLabel("New card title in Backlog").fill("Alpha")
  await page.getByRole("button", { name: "Add card to Backlog" }).click()
  await expect(page.getByRole("button", { name: "Edit card Alpha" })).toBeVisible()
  await page.getByLabel("New card title in Backlog").fill("Beta")
  await page.getByRole("button", { name: "Add card to Backlog" }).click()
  await expect(page.getByRole("button", { name: "Edit card Beta" })).toBeVisible()

  // Within-column reorder: drag Beta onto Alpha so Beta lands first.
  // Each drop waits for its PATCH: the next drag must resolve against the
  // persisted order, not the pre-refetch closure.
  async function dragCardOnto(source: import("@playwright/test").Locator, target: import("@playwright/test").Locator) {
    const sourceBox = await source.boundingBox()
    const targetBox = await target.boundingBox()
    expect(sourceBox).not.toBeNull()
    expect(targetBox).not.toBeNull()
    await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2)
    await page.mouse.down()
    await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2, { steps: 12 })
    const patch = page.waitForResponse(
      (response) => response.url().includes("/api/board/cards/") && response.request().method() === "PATCH",
    )
    await page.mouse.up()
    await patch
  }

  const beta = page.getByRole("button", { name: "Edit card Beta" })
  const alpha = page.getByRole("button", { name: "Edit card Alpha" })
  await dragCardOnto(beta, alpha)
  const backlogCards = page.locator('section[aria-label="Column Backlog"] button[aria-label^="Edit card"]')
  await expect(backlogCards.first()).toContainText("Beta")

  // Within-column downward: drag Beta (now first) onto Alpha (second) so the
  // order flips back to [Alpha, Beta]. This is the off-by-one regression: the
  // optimistic cache and the PATCH must agree on the absolute position.
  const betaFirst = page.locator('section[aria-label="Column Backlog"] button[aria-label^="Edit card"]').first()
  const alphaSecond = page.locator('section[aria-label="Column Backlog"] button[aria-label^="Edit card"]').nth(1)
  await dragCardOnto(betaFirst, alphaSecond)
  await expect(backlogCards.first()).toContainText("Alpha")
  await expect(backlogCards.nth(1)).toContainText("Beta")

  // Across columns onto the empty area: drag Alpha into Doing (empty).
  const alphaAfter = page.getByRole("button", { name: "Edit card Alpha" })
  const doingSection = page.locator('section[aria-label="Column Doing"]')
  await dragCardOnto(alphaAfter, doingSection)
  await expect(page.locator('section[aria-label="Column Doing"] button[aria-label^="Edit card"]').first()).toContainText("Alpha")

  // Drop on the header/empty area: a third empty column, so resolving the drop
  // to the column appends the only card deterministically.
  await page.getByLabel("New column title").last().fill("Empty")
  await page.getByRole("button", { name: "Add column" }).last().click()
  await expect(page.locator('section[aria-label="Column Empty"]')).toBeVisible()
  const betaAfter = page.getByRole("button", { name: "Edit card Beta" })
  const emptyHeader = page.locator('section[aria-label="Column Empty"] header').first()
  await dragCardOnto(betaAfter, emptyHeader)
  const emptyCards = page.locator('section[aria-label="Column Empty"] button[aria-label^="Edit card"]')
  await expect(emptyCards).toHaveCount(1)
  await expect(emptyCards.first()).toContainText("Beta")
})

test("board deletes a column with its cards after confirmation", async ({ page }) => {
  await login(page)
  await addWorkspace(page)
  await openBoard(page)

  await page.getByLabel("New column title").first().fill("Trash me")
  await page.getByRole("button", { name: "Add column" }).first().click()
  await page.getByLabel("New card title in Trash me").fill("Doomed")
  await page.getByRole("button", { name: "Add card to Trash me" }).click()
  await expect(page.getByRole("button", { name: "Edit card Doomed" })).toBeVisible()

  await page.locator('section[aria-label="Column Trash me"]').getByRole("button", { name: "Column options" }).click()
  await page.getByRole("menuitem", { name: /Delete column/ }).click()
  await expect(page.getByRole("alertdialog")).toContainText("1 card")
  await page.getByRole("button", { name: /Delete column and 1 card/ }).click()
  await expect(page.locator('section[aria-label="Column Trash me"]')).toBeHidden()
  await expect(page.getByRole("button", { name: "Edit card Doomed" })).toBeHidden()
})
