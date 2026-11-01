import type { Page } from "@playwright/test"
import { expect } from "../fixtures"

/**
 * Fake cloudflared URL announced by `fake-cloudflared.sh`: a unique hostname
 * per spawned process. The host is not real, so specs assert the URL the UI
 * renders (iframe `src`, Open link, text), never that the iframe loads.
 */
export const E2E_TUNNEL_URL = /^https:\/\/e2e-preview-\d+\.trycloudflare\.com$/

export async function login(page: Page): Promise<void> {
  await page.goto("/")
  // First run: the current origin is prefilled, so only the password is needed.
  await page.locator("#password").fill("e2e-password")
  await page.getByRole("button", { name: "Connect", exact: true }).click()
  await expect(page.getByRole("button", { name: "New session" })).toBeVisible()
}

/** Adds another server from the in-app switcher (web/desktop). */
export async function addRemoteServer(
  page: Page,
  options: { url: string; name: string; password?: string },
): Promise<void> {
  await page.getByRole("button", { name: /^Server: / }).click()
  await page.getByRole("button", { name: /Add another server/ }).click()
  await page.locator("#server-url").fill(options.url)
  await page.locator("#server-name").fill(options.name)
  await page.locator("#password").fill(options.password ?? "e2e-password")
  await page.getByRole("button", { name: "Connect", exact: true }).click()
}

/** Switches to a saved server through the in-app switcher. */
export async function switchServer(page: Page, label: string): Promise<void> {
  await page.getByRole("button", { name: /^Server: / }).click()
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  await page.getByRole("button", { name: new RegExp(`^${escaped}`) }).click()
}

export async function addWorkspace(page: Page, name?: string): Promise<string> {
  // The BFF creates the folder under WORKSPACES_ROOT; a unique name per run avoids clashes.
  const workspaceName = name ?? `mh-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await page.getByRole("button", { name: "Workspace" }).click()
  await page.getByRole("menuitem", { name: "Add workspace" }).click()
  await page.getByPlaceholder("my-project").fill(workspaceName)
  await page.getByRole("button", { name: "Add", exact: true }).click()
  // Regression guard: the new workspace is selected instead of silently ignored.
  await expect(page.getByRole("button", { name: "Workspace" })).toContainText(workspaceName)
  return workspaceName
}

/** Creates a session from the Sessions header's `+` action. */
export async function newSession(page: Page): Promise<void> {
  await page.getByRole("button", { name: "New session" }).click()
}
