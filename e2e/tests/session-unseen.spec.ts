import { expect, test } from "@playwright/test"
import { addWorkspace, login, newSession } from "./helpers"

// Session rows stay quiet when idle: no dot. A working session spins, and a
// session with activity newer than its last open carries an unseen marker
// that clears the moment it is opened.
test("marks a session with unseen activity and clears the marker on open", async ({ page }) => {
  await login(page)
  await addWorkspace(page)
  await newSession(page)
  await newSession(page)
  // Let the second creation settle: filling while the composer remounts
  // loses the text and leaves Send disabled.
  await expect(page.locator(".mh-session-item")).toHaveCount(2)

  // Work in the current session until it goes idle: prompt, approve, done.
  await page.getByPlaceholder("Write a message…").fill("hello agent")
  await page.getByRole("button", { name: "Send" }).click()
  await expect(page.getByText("Permission requested")).toBeVisible()
  await page.getByRole("button", { name: "Once" }).click()
  await expect(page.getByText("Done!")).toBeVisible()

  // Open the other (idle, unchanged) session: the worked session is neither
  // selected nor busy, but newer than its last open, so it shows the marker.
  // Generous timeout: sidebar freshness falls back to the 10s list poll.
  await page.locator(".mh-session-item:not(.is-active)").click()
  const marker = page.getByTestId("session-unseen")
  await expect(marker).toBeVisible({ timeout: 20_000 })

  // Opening the marked session clears it.
  await page.locator(".mh-session-item:has([data-testid='session-unseen'])").click()
  await expect(page.getByTestId("session-unseen")).toHaveCount(0)
})
