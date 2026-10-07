import { render, waitFor } from "@testing-library/react-native"
import { ThemeProvider } from "../src/theme"
import { ThemedSystemBars, syncSystemBars } from "../src/components/SystemBars"
import { NavigationBar } from "expo-navigation-bar"

jest.mock("../src/storage", () => ({
  loadTheme: jest.fn(async () => null),
  loadPalette: jest.fn(async () => null),
  savePalette: jest.fn(async () => {}),
  clearPalette: jest.fn(async () => {}),
  saveTheme: jest.fn(async () => {}),
  clearTheme: jest.fn(async () => {}),
}))

jest.mock("expo-navigation-bar", () => ({
  NavigationBar: { setStyle: jest.fn() },
}))

const setStyle = NavigationBar.setStyle as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
})

describe("syncSystemBars (#118)", () => {
  it("uses light buttons in dark theme", () => {
    syncSystemBars("dark")
    expect(setStyle).toHaveBeenCalledWith("dark")
  })

  it("uses dark buttons in light theme", () => {
    syncSystemBars("light")
    expect(setStyle).toHaveBeenCalledWith("light")
  })

  it("never throws when the native module is unavailable", () => {
    setStyle.mockImplementationOnce(() => {
      throw new Error("unavailable")
    })
    expect(() => syncSystemBars("dark")).not.toThrow()
  })
})

describe("ThemedSystemBars (#118)", () => {
  it("syncs the navigation bar on mount", async () => {
    await render(
      <ThemeProvider>
        <ThemedSystemBars />
      </ThemeProvider>,
    )

    // Default theme here is light (no stored choice, system light in tests).
    await waitFor(() => expect(setStyle).toHaveBeenCalledWith("light"))
  })
})
