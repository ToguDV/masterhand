import { expect, test, type APIRequestContext } from "@playwright/test"
import { addWorkspace, login, newSession } from "./helpers"

const MOCK_URL = "http://127.0.0.1:4097"

async function agentRequests(request: APIRequestContext): Promise<number> {
  const response = await request.get(`${MOCK_URL}/e2e/state`)
  return ((await response.json()) as { agent: number }).agent
}

test.afterEach(async ({ request }) => {
  // The mock is shared by the whole suite: never leave it offline.
  await request.post(`${MOCK_URL}/e2e/online`).catch(() => {})
})

test("repopulates the composer catalogs when opencode reconnects upstream", async ({ page, request }) => {
  await login(page)
  await addWorkspace(page)
  await newSession(page)

  const agentButton = page.getByRole("button", { name: "Agent", exact: true })
  await expect(agentButton).toContainText("build")

  // opencode goes away: the hub loses the upstream SSE stream and retries.
  await request.post(`${MOCK_URL}/e2e/offline`)
  const beforeReload = await agentRequests(request)

  // Reload while it is away: the catalogs fail and the composer shows placeholders.
  await page.reload()
  await expect(page.getByPlaceholder("Write a message…")).toBeVisible()
  await expect(agentButton).toContainText("agent…")

  // Wait for the query's own retry (configured `retry: 1`) to fail too, so the
  // only recovery path left is the hub's upstream reconnection.
  await expect.poll(() => agentRequests(request), { timeout: 15_000 }).toBeGreaterThanOrEqual(beforeReload + 2)
  const beforeOnline = await agentRequests(request)

  // opencode comes back. The downstream stream stayed open, so only the
  // forwarded `server.connected` can trigger the recovery — no page reload.
  await request.post(`${MOCK_URL}/e2e/online`)
  await expect(agentButton).toContainText("build", { timeout: 20_000 })
  await expect.poll(() => agentRequests(request), { timeout: 5_000 }).toBeGreaterThan(beforeOnline)
})
