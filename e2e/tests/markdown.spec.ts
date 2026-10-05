import { expect, test } from "@playwright/test"
import { addWorkspace, login, newSession } from "./helpers"

test("renders the assistant reply as markdown", async ({ page }) => {
  await login(page)
  await addWorkspace(page)
  await newSession(page)

  const composer = page.getByPlaceholder("Write a message…")
  await composer.fill("show markdown")
  await page.getByRole("button", { name: "Send" }).click()

  const markdown = page.getByTestId("markdown")
  await expect(markdown.getByRole("heading", { name: "Report" })).toBeVisible()
  await expect(markdown.locator("strong", { hasText: "bold" })).toBeVisible()
  await expect(markdown.locator("em", { hasText: "italic" })).toBeVisible()
  await expect(markdown.locator("del", { hasText: "struck" })).toBeVisible()
  await expect(markdown.locator("code", { hasText: "inline code" })).toBeVisible()

  await expect(markdown.locator("li", { hasText: "first item" })).toBeVisible()
  await expect(markdown.locator("li", { hasText: "second item" })).toBeVisible()

  await expect(markdown.locator("table th", { hasText: "Name" })).toBeVisible()
  await expect(markdown.locator("table td", { hasText: "alpha" })).toBeVisible()

  await expect(markdown.locator("pre code", { hasText: "const a = 1" })).toBeVisible()

  const link = markdown.getByRole("link", { name: "docs" })
  await expect(link).toHaveAttribute("href", "https://example.com/docs")
  await expect(link).toHaveAttribute("target", "_blank")

  // A single newline is a line break and the markdown source is fully consumed.
  await expect(markdown.locator("br")).toHaveCount(1)
  await expect(markdown.getByText("# Report", { exact: false })).toHaveCount(0)
  await expect(markdown.getByText("[docs]", { exact: false })).toHaveCount(0)
})
