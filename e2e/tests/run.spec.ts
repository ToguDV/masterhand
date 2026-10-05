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

test("surfaces a dev server that dies on its own", async ({ page, request }) => {
  await login(page)
  await addWorkspace(page)

  await newSession(page)
  await expect(page.getByPlaceholder("Write a message…")).toBeVisible()

  await page.getByRole("button", { name: "Run", exact: true }).click()
  await page.getByRole("button", { name: "Edit command" }).click()
  await page.getByPlaceholder("npm").fill("npm")
  await page.getByPlaceholder(/^run/).fill("run\ndev")
  await page.getByRole("button", { name: "Save" }).click()
  await page.getByRole("button", { name: "Start" }).click()
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible()

  // The PTY disappears outside MasterHand (the dev server crashed): the
  // bounded running poll must flip the panel back to Start with a notice (#89).
  await request.post("http://127.0.0.1:4097/e2e/stop-run")
  await expect(page.getByText("The dev server stopped.")).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole("button", { name: "Start" })).toBeVisible()
})
