import { expect, test } from "@playwright/test"
import { addWorkspace, login, newSession } from "./helpers"

const MOCK_URL = "http://127.0.0.1:4097"

test("closes the open chat when another device deletes the session", async ({ page, request }) => {
  await login(page)
  await addWorkspace(page)

  async function openNewSession(previous: string | null): Promise<string> {
    await newSession(page)
    await expect.poll(() => new URL(page.url()).searchParams.get("session")).not.toBe(previous)
    return new URL(page.url()).searchParams.get("session")!
  }

  const firstID = await openNewSession(null)
  const secondID = await openNewSession(firstID)
  expect(secondID).not.toBe(firstID)

  // Another device deletes the session that is currently open: opencode
  // announces it, the list refetch confirms it and the previous session opens.
  await request.post(`${MOCK_URL}/e2e/delete-session`, { data: { sessionID: secondID } })
  await expect.poll(() => new URL(page.url()).searchParams.get("session")).toBe(firstID)

  // Deleting the last one leaves the empty state instead of a 404 transcript.
  await request.post(`${MOCK_URL}/e2e/delete-session`, { data: { sessionID: firstID } })
  await expect(page.getByRole("heading", { name: "No session open" })).toBeVisible()
})
