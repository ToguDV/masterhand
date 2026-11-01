import { rmSync, writeFileSync } from "node:fs"
import { expect, test } from "../fixtures"
import { e2eDieFile } from "../paths"
import { E2E_TUNNEL_URL, addWorkspace, login, newSession } from "./helpers"

const DIE_FILE = e2eDieFile()

test("starts and stops a session preview through the tunnel", async ({ page }) => {
  await login(page)
  await addWorkspace(page)

  await newSession(page)
  await expect(page.getByPlaceholder("Write a message…")).toBeVisible()

  await page.getByRole("button", { name: "Run and preview" }).click()
  await expect(page.getByRole("heading", { name: "Run & preview" })).toBeVisible()
  await page.getByRole("tab", { name: "Preview" }).click()

  await page.getByRole("button", { name: "Start preview" }).click()
  const frame = page.locator('iframe[title="Session preview"]')
  await expect(frame).toHaveAttribute("src", E2E_TUNNEL_URL)
  const url = (await frame.getAttribute("src"))!
  await expect(page.getByRole("link", { name: "Open preview" })).toHaveAttribute("href", url)

  await page.getByRole("button", { name: "Stop preview" }).click()
  await expect(frame).toBeHidden()
  await expect(page.getByRole("button", { name: "Start preview" })).toBeVisible()
  // Stopping keeps the URL it just used, available to open or copy.
  await expect(page.getByText("Last preview URL")).toBeVisible()
  await expect(page.getByRole("link", { name: "Open last preview URL" })).toHaveAttribute("href", url)
})

test("Stop then Start publishes a different URL and keeps the last one visible", async ({ page }) => {
  await login(page)
  await addWorkspace(page)

  await newSession(page)
  await page.getByRole("button", { name: "Run and preview" }).click()
  await page.getByRole("tab", { name: "Preview" }).click()
  await page.getByRole("button", { name: "Start preview" }).click()
  const frame = page.locator('iframe[title="Session preview"]')
  await expect(frame).toHaveAttribute("src", E2E_TUNNEL_URL)
  const first = (await frame.getAttribute("src"))!

  await page.getByRole("button", { name: "Stop preview" }).click()
  await expect(frame).toBeHidden()
  // The retained URL is the one just stopped, not an older tunnel.
  await expect(page.getByRole("link", { name: "Open last preview URL" })).toHaveAttribute("href", first)

  await page.getByRole("button", { name: "Start preview" }).click()
  await expect(frame).toHaveAttribute("src", E2E_TUNNEL_URL)
  const second = (await frame.getAttribute("src"))!
  expect(second).not.toBe(first)
  await expect(page.getByRole("link", { name: "Open preview" })).toHaveAttribute("href", second)

  // The last URL follows the newest tunnel, so a later Stop never revives the
  // first hostname.
  await page.getByRole("button", { name: "Stop preview" }).click()
  await expect(page.getByRole("link", { name: "Open last preview URL" })).toHaveAttribute("href", second)
})

test("surfaces a tunnel that dies while running", async ({ page }) => {
  rmSync(DIE_FILE, { force: true })
  try {
    await login(page)
    await addWorkspace(page)

    await newSession(page)
    await page.getByRole("button", { name: "Run and preview" }).click()
    await page.getByRole("tab", { name: "Preview" }).click()
    await page.getByRole("button", { name: "Start preview" }).click()
    const frame = page.locator('iframe[title="Session preview"]')
    await expect(frame).toBeVisible()

    // The tunnel process exits on its own; the bounded running poll must flip
    // the panel to an error instead of leaving the iframe claiming "running".
    writeFileSync(DIE_FILE, "die")
    await expect(page.getByText(/cloudflared exited/).first()).toBeVisible({ timeout: 15_000 })
    await expect(frame).toBeHidden()
    await expect(page.getByRole("button", { name: "Start preview" })).toBeVisible()
  } finally {
    rmSync(DIE_FILE, { force: true })
  }
})
