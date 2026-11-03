import { expect, test } from "../fixtures"
import { addWorkspace, login, newSession } from "./helpers"

/**
 * Resilience: a chat turn that was running when the agent engine died is
 * journaled, classified on reconnect and continued with a prompt that tells
 * the agent what happened and asks it to verify state before repeating work.
 */
test("auto-continues a turn interrupted by an engine restart", async ({ page, harness, request }) => {
  await login(page)
  await addWorkspace(page)
  await newSession(page)

  // The next prompt starts a turn that never replies (the engine will die).
  await request.post(`${harness.mockURL}/e2e/hang-next-prompt`)
  const composer = page.getByPlaceholder("Write a message…")
  await composer.fill("do the thing")
  await page.getByRole("button", { name: "Send" }).click()
  await expect(page.locator(".mh-msg--user:not(.mh-msg--pending)")).toContainText("do the thing")
  const afterSend = (await (await request.get(`${harness.mockURL}/e2e/state`)).json()) as {
    lastPromptSessionID: string | null
  }
  const sessionID = afterSend.lastPromptSessionID
  expect(sessionID).toBeTruthy()

  // Crash: close the SSE stream and fail every opencode API call, exactly like
  // a dead container. The in-flight turn is gone with it.
  await request.post(`${harness.mockURL}/e2e/offline`)
  await page.waitForTimeout(250)
  await request.post(`${harness.mockURL}/e2e/online`)

  // The BFF reconnects, classifies the open journal row as interrupted and
  // sends the continuation prompt for THIS session. (The worker's mock may
  // also recover older interrupted sessions from previous specs; scope to the
  // session this spec created.)
  type PromptRecord = { sessionID: string; text: string }
  const recordsFor = async (): Promise<PromptRecord[]> => {
    const state = (await (await request.get(`${harness.mockURL}/e2e/state`)).json()) as {
      promptRecords: PromptRecord[]
    }
    return state.promptRecords.filter((record) => record.sessionID === sessionID)
  }
  await expect
    .poll(async () => (await recordsFor()).some((record) => record.text.includes("MasterHand")), {
      timeout: 20_000,
    })
    .toBe(true)

  const records = await recordsFor()
  expect(records).toHaveLength(2)
  const continuation = records.find((record) => record.text.includes("MasterHand"))!
  expect(continuation.text).toContain("was restarted after a crash")
  expect(continuation.text).toContain("may be lost or left half-finished")
  expect(continuation.text).toContain("heavy")
  expect(continuation.text).toContain("force another restart")

  // The continued turn is a new user message in the chat (the mock's normal
  // turn then asks for permission, but that card is covered by chat.spec.ts;
  // the point here is that the continuation reached the session).
  await expect(
    page
      .locator(".mh-msg--user:not(.mh-msg--pending)")
      .filter({ hasText: "automatic continuation sent by MasterHand" }),
  ).toBeVisible({ timeout: 20_000 })
})
