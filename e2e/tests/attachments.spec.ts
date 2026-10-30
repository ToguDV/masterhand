import { expect, test } from "../fixtures"
import { e2eMockURL } from "../paths"
import { addWorkspace, login, newSession } from "./helpers"

const MOCK_URL = e2eMockURL()

// Attachments travel as multipart to the BFF (never base64 through the prompt
// proxy), are stored under the workspace and referenced by `files` + metadata.
test("attaches a file, uploads it on send and shows it in the history", async ({ page, request }) => {
  await login(page)
  await addWorkspace(page)
  await newSession(page)

  const dock = page.locator(".mh-composer-dock")
  await dock.locator('input[type="file"]').setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("hello from the test"),
  })
  await expect(dock.locator(".mh-attachment-strip").getByText("notes.txt")).toBeVisible()

  await dock.getByPlaceholder("Write a message…").fill("Read the attachment")
  await dock.getByRole("button", { name: "Send" }).click()

  const bubble = page.locator(".mh-msg--user").filter({ hasText: "notes.txt" })
  await expect(bubble).toBeVisible()
  await expect(bubble).toContainText("Read the attachment")

  const state = (await (await request.get(`${MOCK_URL}/e2e/state`)).json()) as {
    lastPromptFiles?: Array<{ uri?: string; name?: string }>
  }
  expect(state.lastPromptFiles).toEqual([
    expect.objectContaining({ name: "notes.txt", uri: expect.stringContaining("/.masterhand/attachments/") }),
  ])
})

test("pastes an image into the composer", async ({ page }) => {
  await login(page)
  await addWorkspace(page)
  await newSession(page)

  const dock = page.locator(".mh-composer-dock")
  const field = dock.getByPlaceholder("Write a message…")
  await field.evaluate((element) => {
    const transfer = new DataTransfer()
    transfer.items.add(
      new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], "shot.png", {
        type: "image/png",
      }),
    )
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    )
  })
  await expect(dock.locator(".mh-attachment-strip").getByText("shot.png")).toBeVisible()
})

test("drops a file onto the chat column", async ({ page }) => {
  await login(page)
  await addWorkspace(page)
  await newSession(page)

  const dock = page.locator(".mh-composer-dock")
  await dock.evaluate((element) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(["dropped"], "dropped.md", { type: "text/markdown" }))
    element.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }))
  })
  await expect(dock.locator(".mh-attachment-strip").getByText("dropped.md")).toBeVisible()
})

test("rejects attachments with /goal with actionable copy", async ({ page }) => {
  await login(page)
  await addWorkspace(page)
  await newSession(page)

  const dock = page.locator(".mh-composer-dock")
  await dock.locator('input[type="file"]').setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("hello"),
  })
  await dock.getByPlaceholder("Write a message…").fill("/goal improve the app")
  await dock.getByRole("button", { name: "Send" }).click()

  await expect(dock.getByText(/Attachments are not supported with \/goal/)).toBeVisible()
})
