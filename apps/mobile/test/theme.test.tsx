import { Pressable, Text, View } from "react-native"
import { fireEvent, render, screen } from "@testing-library/react-native"
import { clearTheme, loadTheme, saveTheme } from "../src/storage"
import { ThemeProvider, palettes, resolveTheme, useTheme, useThemedStyles, type Fonts } from "../src/theme"

jest.mock("../src/storage", () => ({
  loadTheme: jest.fn(async () => null),
  saveTheme: jest.fn(async () => {}),
  clearTheme: jest.fn(async () => {}),
}))

const mockedLoad = loadTheme as jest.Mock
const mockedSave = saveTheme as jest.Mock
const mockedClear = clearTheme as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  mockedLoad.mockResolvedValue(null)
})

function Probe() {
  const { theme, colors } = useTheme()
  const styles = useThemedStyles((palette) => ({ box: { backgroundColor: palette.canvas } }))
  return (
    <View testID="box" style={styles.box}>
      <Text>{theme}</Text>
      <Text testID="canvas">{colors.canvas}</Text>
    </View>
  )
}

function ToggleProbe() {
  const { theme, toggleTheme, fonts } = useTheme()
  return (
    <Pressable onPress={toggleTheme} accessibilityLabel="toggle">
      <Text>{theme}</Text>
      <Text testID="font">{fonts.ui}</Text>
    </Pressable>
  )
}

function ModeProbe() {
  const { mode, setMode } = useTheme()
  return (
    <View>
      <Text testID="mode">{mode}</Text>
      <Pressable onPress={() => setMode("system")} accessibilityLabel="follow system" />
      <Pressable onPress={() => setMode("dark")} accessibilityLabel="pick dark" />
    </View>
  )
}

describe("theme resolution", () => {
  it("resolves stored choice → system → light", () => {
    expect(resolveTheme("dark", "light")).toBe("dark")
    expect(resolveTheme("light", "dark")).toBe("light")
    expect(resolveTheme(null, "dark")).toBe("dark")
    expect(resolveTheme(null, "light")).toBe("light")
    expect(resolveTheme(null, null)).toBe("light")
    expect(resolveTheme(null, undefined)).toBe("light")
  })

  it("applies the stored theme over the system scheme", async () => {
    mockedLoad.mockResolvedValue("dark")
    await render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    )

    expect(await screen.findByText("dark")).toBeOnTheScreen()
    expect(screen.getByTestId("box")).toHaveStyle({ backgroundColor: palettes.dark.canvas })
    expect(screen.getByTestId("canvas")).toHaveTextContent(palettes.dark.canvas)
  })

  it("falls back to light when nothing is stored and the system has no preference", async () => {
    await render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    )

    expect(await screen.findByText("light")).toBeOnTheScreen()
    expect(screen.getByTestId("box")).toHaveStyle({ backgroundColor: palettes.light.canvas })
  })

  it("persists the choice when toggled", async () => {
    await render(
      <ThemeProvider>
        <ToggleProbe />
      </ThemeProvider>,
    )
    await screen.findByText("light")

    fireEvent.press(screen.getByLabelText("toggle"))
    expect(await screen.findByText("dark")).toBeOnTheScreen()
    expect(mockedSave).toHaveBeenCalledWith("dark")

    fireEvent.press(screen.getByLabelText("toggle"))
    expect(await screen.findByText("light")).toBeOnTheScreen()
    expect(mockedSave).toHaveBeenLastCalledWith("light")
  })

  it("uses the font set the provider was given", async () => {
    const custom: Fonts = { display: "D", ui: "U", mono: "M" }
    await render(
      <ThemeProvider fonts={custom}>
        <ToggleProbe />
      </ThemeProvider>,
    )

    expect(await screen.findByTestId("font")).toHaveTextContent("U")
  })

  it("clears the stored choice when the mode goes back to system", async () => {
    mockedLoad.mockResolvedValue("dark")
    await render(
      <ThemeProvider>
        <ModeProbe />
      </ThemeProvider>,
    )

    expect(await screen.findByTestId("mode")).toHaveTextContent("dark")
    fireEvent.press(screen.getByLabelText("follow system"))
    expect(await screen.findByTestId("mode")).toHaveTextContent("system")
    expect(mockedClear).toHaveBeenCalled()
    expect(mockedSave).not.toHaveBeenCalled()

    fireEvent.press(screen.getByLabelText("pick dark"))
    expect(await screen.findByTestId("mode")).toHaveTextContent("dark")
    expect(mockedSave).toHaveBeenCalledWith("dark")
  })
})
