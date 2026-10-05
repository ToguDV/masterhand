import { expect, type Page } from "@playwright/test"

export async function login(page: Page): Promise<void> {
  await page.goto("/")
  await page.locator("#password").fill("e2e-password")
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page.getByRole("button", { name: "Sign in" })).toBeHidden()
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

/**
 * Creates a session through the composer's top bar (the sidebar no longer has
 * the action). `isolated` checks the worktree option inside the popover.
 */
export async function newSession(page: Page, options: { isolated?: boolean } = {}): Promise<void> {
  await page.getByRole("button", { name: "New session" }).click()
  if (options.isolated) await page.getByRole("checkbox", { name: /Isolated session/ }).check()
  await page.getByRole("button", { name: "Create session" }).click()
}
