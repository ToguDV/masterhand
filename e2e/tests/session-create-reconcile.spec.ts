import { expect, test } from "@playwright/test"
import { addWorkspace, login, newSession } from "./helpers"

const MOCK_URL = "http://127.0.0.1:4097"

test("reconciles a session whose create response was lost", async ({ page, request }) => {
  await login(page)
  await addWorkspace(page)

  // Consume the workspace auto-open with a first session, so the reconciled
  // one can only open through the marker path below.
  await newSession(page)
  await expect.poll(() => new URL(page.url()).searchParams.get("session")).not.toBeNull()
  const initialID = new URL(page.url()).searchParams.get("session")!

  // The mock creates the session but holds the HTTP response: the client's
  // request deadline fires even though opencode processed the creation.
  await request.post(`${MOCK_URL}/e2e/stall-create`)

  await newSession(page)
  // After the deadline the client reconciles against the list by its marker
  // and opens the new session instead of reporting a failure.
  await expect
    .poll(
      () => {
        const id = new URL(page.url()).searchParams.get("session")
        return id !== null && id !== initialID ? id : null
      },
      { timeout: 15_000 },
    )
    .not.toBeNull()
  await expect(page.getByText("Could not create the session")).toBeHidden()
  await expect(page.getByText(/may still be created/)).toBeHidden()

  await request.post(`${MOCK_URL}/e2e/release-create`)
})

test("warns that a timed-out creation may still be in progress", async ({ page, request }) => {
  await login(page)
  await addWorkspace(page)

  // The mock holds before creating anything: there is nothing to reconcile,
  // so the client must surface the ambiguity instead of a hard failure.
  await request.post(`${MOCK_URL}/e2e/stall-create-before`)

  await newSession(page)
  await expect(page.getByText(/may still be created/)).toBeVisible({ timeout: 15_000 })

  await request.post(`${MOCK_URL}/e2e/release-create`)
})
