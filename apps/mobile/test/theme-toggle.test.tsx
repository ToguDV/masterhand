import { fireEvent, render, screen } from "@testing-library/react-native"
import { ThemeToggle } from "../src/components/ThemeToggle"
import { ThemeProvider } from "../src/theme"
import { saveTheme } from "../src/storage"

jest.mock("../src/storage", () => ({
  loadTheme: jest.fn(async () => null),
  saveTheme: jest.fn(async () => {}),
}))

const mockedSave = saveTheme as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
})

describe("ThemeToggle", () => {
  it("flips the theme and persists the choice", async () => {
    await render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    )

    fireEvent.press(screen.getByLabelText("Switch to dark theme"))
    expect(await screen.findByLabelText("Switch to light theme")).toBeOnTheScreen()
    expect(mockedSave).toHaveBeenCalledWith("dark")

    fireEvent.press(screen.getByLabelText("Switch to light theme"))
    expect(await screen.findByLabelText("Switch to dark theme")).toBeOnTheScreen()
    expect(mockedSave).toHaveBeenLastCalledWith("light")
  })
})
