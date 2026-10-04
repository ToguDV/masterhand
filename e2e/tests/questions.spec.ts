import { expect, test } from "@playwright/test"
import { addWorkspace, login } from "./helpers"

test("renders agent questions inline and replies to them", async ({ page }) => {
  await login(page)
  await addWorkspace(page)

  await page.getByRole("button", { name: "+ New" }).click()
  const composer = page.getByPlaceholder("Write a message…")
  await expect(composer).toBeVisible()
  await composer.fill("ask me a question")
  await page.getByRole("button", { name: "Send" }).click()

  const main = page.locator("main")
  const card = main.getByTestId("question-card")
  await expect(card).toBeVisible()
  // The index shows one question at a time: the first question is rendered.
  await expect(card.getByText("Which database should the project use?")).toBeVisible()
  await expect(card.getByText("Postgres")).toBeVisible()
  await expect(card.getByText("SQLite")).toBeVisible()

  // The final Submit step blocks the reply and jumps to the required question.
  await card.getByRole("tab", { name: "Submit" }).click()
  await card.getByRole("button", { name: "Submit" }).click()
  await expect(card.getByText("This field is required")).toBeVisible()

  await card.getByRole("radio", { name: /Postgres/ }).click()
  await card.getByRole("tab", { name: "Submit" }).click()
  await card.getByRole("button", { name: "Submit" }).click()

  // The agent resumes and the card becomes a read-only summary.
  await expect(main.getByText("Thanks, moving on.")).toBeVisible()
  await expect(main.getByTestId("question-card")).toHaveCount(0)
  const answered = main.getByTestId("question-answered")
  await expect(answered).toBeVisible()
  await expect(answered.getByText("Postgres")).toBeVisible()
})
