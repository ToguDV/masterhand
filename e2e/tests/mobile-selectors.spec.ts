import { expect, test } from "../fixtures"
import { addWorkspace, login, newSession } from "./helpers"

/**
 * Phone-width layout contract (web <768px), mirroring the native composer.
 * The composer used to be a single wrapping flex row: the agent/model/effort
 * pills and the auto-accept/Send actions landed on ragged half-filled lines,
 * the context row overflowed the dock at 360px, and a menu opened from a
 * right-edge trigger clipped off-screen. These assertions pin the two-row
 * layout, the in-viewport bottom-sheet menus and the docked board editor.
 */
test("mobile composer keeps selectors and actions on aligned rows", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 })
  await login(page)
  await addWorkspace(page)
  await newSession(page)
  await expect(page.getByRole("button", { name: "Effort" })).toBeVisible()

  const layout = await page.evaluate(() => {
    const rect = (selector: string) => {
      const element = document.querySelector(selector)
      if (!element) throw new Error(`${selector} missing`)
      return element.getBoundingClientRect().toJSON() as DOMRect
    }
    const actions = document.querySelector(".mh-composer-dock__actions") as HTMLElement
    const send = actions.lastElementChild?.getBoundingClientRect()
    return {
      viewportWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      dock: rect(".mh-composer-dock"),
      context: rect(".mh-composer-dock__context"),
      actions: rect(".mh-composer-dock__actions"),
      send: send?.toJSON() as DOMRect,
    }
  })

  // No horizontal overflow: the context pills shrink/truncate inside the dock.
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.viewportWidth)
  expect(layout.context.right).toBeLessThanOrEqual(layout.dock.right)
  expect(layout.context.left).toBeGreaterThanOrEqual(layout.dock.left)

  // Deliberate two-row toolbar: actions below the context, Send at the right.
  expect(layout.actions.top).toBeGreaterThanOrEqual(layout.context.bottom)
  expect(layout.send.top).toBeGreaterThanOrEqual(layout.actions.top)
  expect(layout.actions.right - layout.send.right).toBeLessThanOrEqual(10)

  // A menu opened from the right-most selector stays fully inside the viewport
  // and uses >=40px rows; it used to clip past the right edge.
  await page.getByRole("button", { name: "Effort" }).click()
  const effortMenu = page.getByRole("listbox", { name: "Effort" })
  await expect(effortMenu).toBeVisible()
  const effortBox = (await effortMenu.boundingBox())!
  expect(effortBox.x).toBeGreaterThanOrEqual(0)
  expect(effortBox.x + effortBox.width).toBeLessThanOrEqual(360)
  const optionHeight = await effortMenu
    .getByRole("option")
    .first()
    .evaluate((element) => element.getBoundingClientRect().height)
  expect(optionHeight).toBeGreaterThanOrEqual(40)
  await page.keyboard.press("Escape")

  // The workspace menu follows the same sheet contract.
  await page.getByRole("button", { name: "Workspace" }).click()
  const workspaceMenu = page.getByRole("menu", { name: "Workspace" })
  await expect(workspaceMenu).toBeVisible()
  const workspaceBox = (await workspaceMenu.boundingBox())!
  expect(workspaceBox.x).toBeGreaterThanOrEqual(0)
  expect(workspaceBox.x + workspaceBox.width).toBeLessThanOrEqual(360)
  const rowHeight = await workspaceMenu
    .getByRole("menuitemradio")
    .first()
    .evaluate((element) => element.getBoundingClientRect().height)
  expect(rowHeight).toBeGreaterThanOrEqual(40)
})

test("mobile board card editor is a bottom sheet", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page)
  await addWorkspace(page)
  const nav = page.getByRole("navigation", { name: "Main navigation" })
  await nav.getByRole("button", { name: "Board", exact: true }).click()
  await page.getByLabel("New column title").first().fill("To do")
  await page.getByRole("button", { name: "Add column" }).first().click()
  await page.getByLabel("New card title in To do").fill("First task")
  await page.getByRole("button", { name: "Add card to To do" }).click()
  await page.getByRole("button", { name: "Edit card First task" }).click()

  const dialog = page.getByRole("dialog", { name: "Edit card" })
  await expect(dialog).toBeVisible()
  const box = (await dialog.boundingBox())!
  // Docked to the bottom edge and full width instead of a centered small card.
  expect(box.x).toBeLessThanOrEqual(1)
  expect(box.width).toBeGreaterThanOrEqual(388)
  expect(box.y + box.height).toBeGreaterThanOrEqual(842)
})
