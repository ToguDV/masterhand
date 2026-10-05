import { rmSync, writeFileSync } from "node:fs"
import { expect, test } from "@playwright/test"
import { addWorkspace, login, newSession } from "./helpers"

const DIE_FILE = "/tmp/masterhand-e2e-cloudflared-die"

test("starts and stops a session preview through the tunnel", async ({ page }) => {
  await login(page)
  await addWorkspace(page)

  await newSession(page)
  await expect(page.getByPlaceholder("Write a message…")).toBeVisible()

  await page.getByRole("button", { name: "Preview" }).click()
  await expect(page.getByRole("heading", { name: "Preview" })).toBeVisible()

  await page.getByRole("button", { name: "Start" }).click()
  const frame = page.locator('iframe[title="Session preview"]')
  await expect(frame).toHaveAttribute("src", "https://e2e-preview.trycloudflare.com")
  await expect(page.getByRole("link", { name: "Open" })).toHaveAttribute(
    "href",
    "https://e2e-preview.trycloudflare.com",
  )

  await page.getByRole("button", { name: "Stop" }).click()
  await expect(frame).toBeHidden()
  await expect(page.getByRole("button", { name: "Start" })).toBeVisible()
})

test("surfaces a tunnel that dies while running", async ({ page }) => {
  rmSync(DIE_FILE, { force: true })
  try {
    await login(page)
    await addWorkspace(page)

    await newSession(page)
    await page.getByRole("button", { name: "Preview" }).click()
    await page.getByRole("button", { name: "Start" }).click()
    const frame = page.locator('iframe[title="Session preview"]')
    await expect(frame).toBeVisible()

    // The tunnel process exits on its own; the bounded running poll must flip
    // the panel to an error instead of leaving the iframe claiming "running".
    writeFileSync(DIE_FILE, "die")
    await expect(page.getByText(/cloudflared exited/).first()).toBeVisible({ timeout: 15_000 })
    await expect(frame).toBeHidden()
    await expect(page.getByRole("button", { name: "Start" })).toBeVisible()
  } finally {
    rmSync(DIE_FILE, { force: true })
  }
})
