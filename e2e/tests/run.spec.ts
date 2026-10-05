import { expect, test } from "@playwright/test"
import { addWorkspace, login, newSession } from "./helpers"

test("configures, starts and stops the workspace dev server from the Run panel", async ({ page }) => {
  await login(page)
  await addWorkspace(page)

  await newSession(page)
  await expect(page.getByPlaceholder("Write a message…")).toBeVisible()

  await page.getByRole("button", { name: "Run", exact: true }).click()
  await expect(page.getByText("No run command configured")).toBeVisible()

  // The user edits the argv command; {port} is replaced by the reserved port.
  await page.getByRole("button", { name: "Edit command" }).click()
  await page.getByPlaceholder("npm").fill("npm")
  await page.getByPlaceholder(/^run/).fill("run\ndev\n--\n--port\n{port}")
  await page.getByRole("button", { name: "Save" }).click()
  await expect(page.getByText("npm run dev -- --port {port}")).toBeVisible()

  // MasterHand starts the PTY through opencode; the agent is not involved.
  await page.getByRole("button", { name: "Start" }).click()
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible()
  await expect(page.getByText("npm run dev -- --port 4097")).toBeVisible()

  await page.getByRole("button", { name: "Stop" }).click()
  await expect(page.getByRole("button", { name: "Start" })).toBeVisible()
})
