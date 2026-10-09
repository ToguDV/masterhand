import { expect, test, type APIRequestContext } from "@playwright/test"
import { addWorkspace, login, newSession } from "./helpers"

const MOCK = "http://127.0.0.1:4097"

async function permissionReplies(request: APIRequestContext): Promise<number> {
  const response = await request.get(`${MOCK}/e2e/state`)
  const state = (await response.json()) as { permissionReplies: number }
  return state.permissionReplies
}

test("renders subagent runs as a custom card and opens the child session", async ({ page }) => {
  await login(page)
  await addWorkspace(page)

  await newSession(page)
  const composer = page.getByPlaceholder("Write a message…")
  await expect(composer).toBeVisible()
  await composer.fill("please run a subagent")
  await page.getByRole("button", { name: "Send" }).click()

  const main = page.locator("main")
  await expect(main.getByText("Subagent", { exact: true })).toBeVisible()
  await expect(main.getByText("explore", { exact: true })).toBeVisible()
  await expect(main.getByText("Explore the repository", { exact: true })).toBeVisible()

  await main.getByRole("button", { name: /Explore the repository/ }).click()
  await expect(main.getByText("List the files in the project")).toBeVisible()
  await expect(main.getByText("Found 3 files")).toBeVisible()

  await main.getByRole("button", { name: /Open session/ }).click()
  await expect(page.locator("header").getByText("Explore the repository (@explore subagent)")).toBeVisible()
  // The child is reachable through the card, not listed as a top-level session.
  await expect(page.locator("aside").getByText("Explore the repository (@explore subagent)")).toHaveCount(0)

  const back = page.getByRole("button", { name: /Back to main agent/ })
  await expect(back).toBeVisible()
  await back.click()
  await expect(main.getByText("Subagent", { exact: true })).toBeVisible()
})

test("a subagent inherits the parent session's auto-accept setting", async ({ page, request }) => {
  await request.post(`${MOCK}/e2e/subagent-permission`, { data: { value: true } })
  await login(page)
  await addWorkspace(page)
  await newSession(page)

  // Turn auto-accept on for the main session, then dispatch a subagent whose
  // child raises a permission.
  await page.getByRole("button", { name: "Auto-accept", exact: true }).click()
  await expect(page.getByRole("button", { name: "Auto-accept: on" })).toBeVisible()
  const before = await permissionReplies(request)

  const composer = page.getByPlaceholder("Write a message…")
  await composer.fill("please run a subagent")
  await page.getByRole("button", { name: "Send" }).click()

  // The child's request is answered automatically (the parent inherited down):
  // the mock records the reply instead of it waiting for a human.
  await expect.poll(() => permissionReplies(request), { timeout: 15_000 }).toBeGreaterThan(before)
})
