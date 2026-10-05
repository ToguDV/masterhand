import { expect, test } from "@playwright/test"
import { addWorkspace, login } from "./helpers"

test("adds a workspace, deletes a session and removes the workspace", async ({ page }) => {
  await login(page)
  const workspaceName = await addWorkspace(page)
  await expect(page.getByRole("button", { name: "+ New" })).toBeEnabled()

  await page.getByRole("button", { name: "+ New" }).click()
  await expect(page.getByPlaceholder("Write a message…")).toBeVisible()
  await expect(page.locator("aside").getByText("Untitled")).toBeVisible()

  page.on("dialog", (dialog) => dialog.accept())
  await page.getByRole("button", { name: "Delete session" }).click()
  await expect(page.locator("aside").getByText("Untitled")).toBeHidden()
  await expect(page.getByText("No sessions yet.")).toBeVisible()

  await page.getByRole("button", { name: "Remove workspace" }).click()
  await expect(page.getByRole("heading", { name: "Remove workspace" })).toBeVisible()
  await page.getByRole("button", { name: "Remove", exact: true }).click()
  await expect(page.getByRole("option", { name: workspaceName })).toHaveCount(0)
})

test("rejects an invalid workspace name", async ({ page }) => {
  await login(page)
  await page.getByRole("button", { name: "Add workspace" }).click()
  await page.getByPlaceholder("my-project").fill("bad/name")
  await page.getByRole("button", { name: "Add", exact: true }).click()
  await expect(page.getByText("Enter a valid folder name (no slashes or leading dots)")).toBeVisible()
})

test("keeps sessions scoped to the selected workspace", async ({ page }) => {
  await login(page)
  const workspace = page.getByRole("combobox", { name: "Workspace", exact: true })

  await addWorkspace(page)
  const firstWorkspaceID = await workspace.inputValue()

  await page.getByRole("button", { name: "+ New" }).click()
  await expect(page.locator("aside").getByText("Untitled")).toBeVisible()

  await addWorkspace(page)
  await expect(page.locator("aside").getByText("Untitled")).toBeHidden()
  await expect(page.getByText("No sessions yet.")).toBeVisible()

  await workspace.selectOption(firstWorkspaceID)
  await expect(page.locator("aside").getByText("Untitled")).toBeVisible()
})

test("never leaks the previous workspace's session or preview", async ({ page }) => {
  await login(page)
  const workspace = page.getByRole("combobox", { name: "Workspace", exact: true })

  // Workspace A: a session with a running preview.
  await addWorkspace(page)
  const workspaceA = await workspace.inputValue()
  await page.getByRole("button", { name: "+ New" }).click()
  await expect(page.getByPlaceholder("Write a message…")).toBeVisible()
  await page.getByRole("button", { name: "Preview" }).click()
  await page.getByRole("button", { name: "Start" }).click()
  await expect(page.locator('iframe[title="Session preview"]')).toHaveAttribute(
    "src",
    "https://e2e-preview.trycloudflare.com",
  )
  await page.getByRole("button", { name: "Close preview" }).click()

  // Switching to an empty workspace must drop A's chat and preview, not keep
  // rendering them under the new workspace.
  await addWorkspace(page)
  await expect(page.getByText("No sessions yet.")).toBeVisible()
  await expect(page.getByPlaceholder("Write a message…")).toBeHidden()
  await expect(page.locator('iframe[title="Session preview"]')).toHaveCount(0)

  // With its own session, going back to A auto-opens A's most recent session
  // (the one with the running preview), not the other workspace's.
  await page.getByRole("button", { name: "+ New" }).click()
  await expect(page.getByPlaceholder("Write a message…")).toBeVisible()
  await workspace.selectOption(workspaceA)
  await expect(page.getByPlaceholder("Write a message…")).toBeVisible()
  await page.getByRole("button", { name: "Preview" }).click()
  await expect(page.locator('iframe[title="Session preview"]')).toHaveAttribute(
    "src",
    "https://e2e-preview.trycloudflare.com",
  )
})
