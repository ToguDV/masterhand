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
  // Four sequential drops: each drop waits for the server to persist the new
  // order (polled straight from the API) before the next drag starts, so a
  // drop always resolves against the persisted order. Raise the budget so a
  // loaded runner still fits setup + drops + refetches.
  test.setTimeout(120_000)
  // Timestamps of the client's own board refetches (page traffic only: the
  // page.request polls below run in a separate context and never match).
  // The last drop's refetch is awaited by timestamp so the column create
  // below never races it: a click landing mid-refetch is silently eaten.
  const boardGets: number[] = []
  page.on("response", (response) => {
    if (response.request().method() === "GET" && response.url().includes("/api/board?workspace=")) {
      boardGets.push(Date.now())
    }
  })
  await login(page)
  const wsName = await addWorkspace(page)
  await openBoard(page)

  /** Card titles of a column as the server has them (bypasses the UI cache). */
  async function serverOrder(columnTitle: string): Promise<string[]> {
    const wsList = await page.request.get("/api/workspaces")
    const { workspaces } = (await wsList.json()) as { workspaces: Array<{ id: string; name: string }> }
    const workspace = workspaces.find((entry) => entry.name === wsName)
    expect(workspace).toBeDefined()
    const boardResponse = await page.request.get(`/api/board?workspace=${workspace!.id}`)
    const { board } = (await boardResponse.json()) as {
      board: { columns: Array<{ title: string; cards: Array<{ title: string }> }> }
    }
    return board.columns.find((column) => column.title === columnTitle)?.cards.map((card) => card.title) ?? []
  }

  async function expectServerOrder(columnTitle: string, titles: string[]) {
    await expect.poll(async () => serverOrder(columnTitle), { timeout: 20_000 }).toEqual(titles)
  }

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
  // dnd-kit needs real pointer travel (stepped moves) to arm its sensor and
  // resolve `over`; raw coordinates miss when the board sits scrolled between
  // drops. So the press goes through hover actionability (scroll into view,
  // hit-target check) and the drag itself travels in steps.
  async function dragCardOnto(source: import("@playwright/test").Locator, target: import("@playwright/test").Locator) {
    await source.hover()
    await page.mouse.down()
    const targetBox = await target.boundingBox()
    expect(targetBox).not.toBeNull()
    await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2, { steps: 12 })
    await page.mouse.up()
  }

  // Timestamp of the latest drop: the client quiescence wait below only
  // accepts a refetch that landed after this drop.
  let lastDropAt = 0

  const beta = page.getByRole("button", { name: "Edit card Beta" })
  const alpha = page.getByRole("button", { name: "Edit card Alpha" })
  await dragCardOnto(beta, alpha)
  const backlogCards = page.locator('section[aria-label="Column Backlog"] button[aria-label^="Edit card"]')
  await expect(backlogCards.first()).toContainText("Beta")
  await expectServerOrder("Backlog", ["Beta", "Alpha"])

  // Within-column downward: drag Beta (now first) below Alpha (second) so
  // the order flips back to [Alpha, Beta]. The drop lands past Alpha's bottom
  // edge, so whether dnd-kit resolves it to the card or to the column area,
  // the absolute position is the end in both cases. This is the off-by-one
  // regression: the optimistic cache and the PATCH must agree on it.
  const betaFirst = page.locator('section[aria-label="Column Backlog"] button[aria-label^="Edit card"]').first()
  const alphaSecond = page.locator('section[aria-label="Column Backlog"] button[aria-label^="Edit card"]').nth(1)
  await betaFirst.hover()
  await page.mouse.down()
  const alphaBox = await alphaSecond.boundingBox()
  expect(alphaBox).not.toBeNull()
  await page.mouse.move(alphaBox!.x + alphaBox!.width / 2, alphaBox!.y + alphaBox!.height + 14, { steps: 12 })
  await page.mouse.up()
  await expect(backlogCards.first()).toContainText("Alpha")
  await expect(backlogCards.nth(1)).toContainText("Beta")
  await expectServerOrder("Backlog", ["Alpha", "Beta"])

  // Across columns onto the empty area: drag Alpha into Doing (empty).
  const alphaAfter = page.getByRole("button", { name: "Edit card Alpha" })
  const doingSection = page.locator('section[aria-label="Column Doing"]')
  await dragCardOnto(alphaAfter, doingSection)
  lastDropAt = Date.now()
  await expect(page.locator('section[aria-label="Column Doing"] button[aria-label^="Edit card"]').first()).toContainText("Alpha")
  await expectServerOrder("Doing", ["Alpha"])
  await expectServerOrder("Backlog", ["Beta"])
  // Client quiescence for this drop's own refetch (a timestamped response,
  // never a stale one). Bounded wait: if nothing lands within 10 s there was
  // nothing in flight, which is settled by definition.
  const settleStart = Date.now()
  while (!boardGets.some((at) => at > lastDropAt)) {
    if (Date.now() - settleStart > 10_000) break
    await page.waitForTimeout(50)
  }

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
  await expectServerOrder("Empty", ["Beta"])
  await expectServerOrder("Backlog", [])
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

test("board workspace menu opens below the trigger and stays in view", async ({ page }) => {
  await login(page)
  await addWorkspace(page)
  await openBoard(page)

  // The Board toolbar sits at the top of the page: the menu must open
  // downward from the trigger and stay fully inside the viewport.
  const main = page.locator("main")
  const trigger = main.getByRole("button", { name: "Workspace" })
  await trigger.click()
  const menu = main.getByRole("menu", { name: "Workspace" })
  await expect(menu).toBeVisible()

  const triggerBox = await trigger.boundingBox()
  const menuBox = await menu.boundingBox()
  expect(triggerBox).not.toBeNull()
  expect(menuBox).not.toBeNull()
  expect(menuBox!.y).toBeGreaterThanOrEqual(triggerBox!.y + triggerBox!.height - 2)

  const viewport = page.viewportSize()
  expect(viewport).not.toBeNull()
  expect(menuBox!.y).toBeGreaterThanOrEqual(0)
  expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(viewport!.height + 1)
})
