import { expect, test, type APIRequestContext } from "@playwright/test"
import { addWorkspace, login, newSession } from "./helpers"

const MOCK_URL = "http://127.0.0.1:4097"

interface MockState {
  stalledForks: number
  forks: { created: number; removed: number }
}

async function mockState(request: APIRequestContext): Promise<MockState> {
  return (await (await request.get(`${MOCK_URL}/e2e/state`)).json()) as MockState
}

test.afterEach(async ({ request }) => {
  // Never leave a stalled fork or failing prompt behind for the next spec.
  await request.post(`${MOCK_URL}/e2e/release-prompt`).catch(() => {})
  await request.post(`${MOCK_URL}/e2e/fail-prompts`, { data: { value: false } }).catch(() => {})
})

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

// A `/btw` fork is created before the question is prompted: if the prompt fails
// the fork used to leak as a hidden session (#68).
test("removes the /btw fork when the side question cannot be started", async ({ page, request }) => {
  await login(page)
  await addWorkspace(page)
  await newSession(page)

  const before = await mockState(request)
  await request.post(`${MOCK_URL}/e2e/fail-prompts`, { data: { value: true } })

  const composer = page.getByPlaceholder("Write a message…")
  await composer.fill("/btw what?")
  await page.getByRole("button", { name: "Send" }).click()

  await expect(page.getByText(/Could not start the side question/)).toBeVisible()
  await expect
    .poll(async () => (await mockState(request)).forks.removed - before.forks.removed)
    .toBe(1)
})

// The composer can unmount (session switch, reload) while the fork request is in
// flight; its cleanup already ran, so the resolved fork must be removed by the
// in-flight handler (#68).
test("removes the /btw fork when the composer unmounts while it is in flight", async ({ page, request }) => {
  await login(page)
  await addWorkspace(page)
  await newSession(page)

  const composer = page.getByPlaceholder("Write a message…")
  const before = await mockState(request)
  await request.post(`${MOCK_URL}/e2e/stall-fork`)
  await composer.fill("/btw what?")
  await page.getByRole("button", { name: "Send" }).click()
  await expect.poll(async () => (await mockState(request)).stalledForks).toBe(1)

  // Switching sessions unmounts the composer before the fork resolves.
  await newSession(page)
  await request.post(`${MOCK_URL}/e2e/release-prompt`)
  await expect
    .poll(async () => (await mockState(request)).forks.removed - before.forks.removed)
    .toBe(1)
})
