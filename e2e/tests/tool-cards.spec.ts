import { expect, test } from "@playwright/test"
import { addWorkspace, login, newSession } from "./helpers"

test("renders tool calls as semantic collapsible cards", async ({ page }) => {
  await login(page)
  await addWorkspace(page)

  await newSession(page)
  const composer = page.getByPlaceholder("Write a message…")
  await expect(composer).toBeVisible()
  await composer.fill("run the tools")
  await page.getByRole("button", { name: "Send" }).click()

  const main = page.locator("main")

  // Shell: terminal summary with the command and exit code, collapsed by default.
  const shell = main.locator('[data-tool="bash"]')
  await expect(shell).toBeVisible()
  await expect(shell).toContainText("npm test -- --run")
  await expect(shell).toContainText("exit 0")
  await expect(shell).not.toContainText("Tests passed")
  await shell.locator("button").first().click()
  await expect(shell).toContainText("Tests passed")

  // Read: file path and line range; the header and `N:` prefixes are not part
  // of the body, and the content is numbered once by the client.
  const read = main.locator('[data-tool="read"]')
  await expect(read).toContainText("src/app.ts")
  await expect(read).toContainText("lines 1-2")
  await read.locator("button").first().click()
  await expect(read).toContainText("export const app = 1")
  await expect(read).not.toContainText("Read file")
  await expect(read.getByText("1", { exact: true })).toBeVisible()
  await expect(read.getByText("2", { exact: true })).toBeVisible()
  await expect(read.getByText("1:", { exact: false })).toHaveCount(0)

  // Write: file path and content.
  const write = main.locator('[data-tool="write"]')
  await expect(write).toContainText("src/new.ts")
  await expect(write).toContainText("1 line")
  await write.locator("button").first().click()
  await expect(write).toContainText("export const answer = 42")

  // Edit: diff stats in the header, colored diff in the body.
  const edit = main.locator('[data-tool="edit"]')
  await expect(edit).toContainText("+2")
  await expect(edit).toContainText("−1")
  await edit.locator("button").first().click()
  await expect(edit).toContainText("const value = 1")
  await expect(edit).toContainText("const more = 3")

  // The old raw-JSON dump is gone.
  await expect(main.getByText(/"command":/)).toHaveCount(0)
  await expect(main.getByText(/"filePath":/)).toHaveCount(0)
})
