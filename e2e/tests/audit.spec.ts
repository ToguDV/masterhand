import { expect, test } from "../fixtures"
import { addWorkspace, login, newSession } from "./helpers"

test("shows permission-denied commands in the activity log", async ({ page }) => {
  await login(page)
  await addWorkspace(page)

  await newSession(page)
  const composer = page.getByPlaceholder("Write a message…")
  await composer.fill("run denied")
  await page.getByRole("button", { name: "Send" }).click()

  await expect(page.getByText("That command was blocked by the permission guard.")).toBeVisible()

  await page.getByRole("button", { name: /Activity/ }).click()
  // Each worker gets a wiped DATA_DIR at start, but entries from earlier tests
  // in this worker can still exist: the newest entry is first.
  const entry = page.getByRole("listitem").first()
  // The panel may need one poll cycle if the invalidated refetch was in flight.
  await expect(entry.getByText("pkill -f node")).toBeVisible({ timeout: 15_000 })
  await expect(entry.getByText("Permission denied: shell")).toBeVisible()

  await page.getByRole("button", { name: "Clear" }).click()
  await expect(page.getByText("Nothing blocked yet")).toBeVisible()
})
