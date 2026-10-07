import { Pressable, Text, View } from "react-native"
import { fireEvent, render, screen } from "@testing-library/react-native"
import { loadPalette, loadTheme, savePalette, saveTheme } from "../src/storage"
import {
  DEFAULT_PALETTE,
  ThemeProvider,
  paletteFor,
  palettes,
  resolveTheme,
  useTheme,
  useThemedStyles,
  type Fonts,
} from "../src/theme"

jest.mock("../src/storage", () => ({
  loadTheme: jest.fn(async () => null),
  loadPalette: jest.fn(async () => null),
  savePalette: jest.fn(async () => {}),
  clearPalette: jest.fn(async () => {}),
  saveTheme: jest.fn(async () => {}),
  clearTheme: jest.fn(async () => {}),
}))

const mockedLoad = loadTheme as jest.Mock
const mockedSave = saveTheme as jest.Mock
const mockedLoadPalette = loadPalette as jest.Mock
const mockedSavePalette = savePalette as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  mockedLoad.mockResolvedValue(null)
  mockedLoadPalette.mockResolvedValue(null)
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
      <Pressable onPress={() => setMode("light")} accessibilityLabel="pick light" />
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

  it("persists the explicit choice when the mode changes", async () => {
    mockedLoad.mockResolvedValue("dark")
    await render(
      <ThemeProvider>
        <ModeProbe />
      </ThemeProvider>,
    )

    expect(await screen.findByTestId("mode")).toHaveTextContent("dark")

    fireEvent.press(screen.getByLabelText("pick light"))
    expect(await screen.findByTestId("mode")).toHaveTextContent("light")
    expect(mockedSave).toHaveBeenCalledWith("light")

    fireEvent.press(screen.getByLabelText("pick dark"))
    expect(await screen.findByTestId("mode")).toHaveTextContent("dark")
    expect(mockedSave).toHaveBeenCalledWith("dark")
  })
})

function PaletteProbe() {
  const { palette, setPalette, colors } = useTheme()
  return (
    <View>
      <Text testID="palette">{palette}</Text>
      <Text testID="accent">{colors.accent}</Text>
      <Pressable onPress={() => setPalette("dracula")} accessibilityLabel="pick dracula" />
    </View>
  )
}

describe("color themes", () => {
  it("starts on paper and applies the theme when picked", async () => {
    await render(
      <ThemeProvider>
        <PaletteProbe />
      </ThemeProvider>,
    )

    expect(await screen.findByTestId("palette")).toHaveTextContent(DEFAULT_PALETTE)
    expect(screen.getByTestId("accent")).toHaveTextContent(palettes.light.accent)

    fireEvent.press(screen.getByLabelText("pick dracula"))
    expect(await screen.findByTestId("palette")).toHaveTextContent("dracula")
    expect(screen.getByTestId("accent")).toHaveTextContent(paletteFor("dracula", "light").accent)
    expect(mockedSavePalette).toHaveBeenCalledWith("dracula")
  })

  it("restores the stored theme and falls back for unknown values", async () => {
    mockedLoadPalette.mockResolvedValue("nord")
    await render(
      <ThemeProvider>
        <PaletteProbe />
      </ThemeProvider>,
    )
    expect(await screen.findByTestId("palette")).toHaveTextContent("nord")
  })

  it("resolves a non-default theme over the paper base", () => {
    const dracula = paletteFor("dracula", "light")
    expect(dracula.accent).not.toBe(palettes.light.accent)
    // A color theme repaints the full set: canvas and text follow the theme.
    expect(dracula.canvas).not.toBe(palettes.light.canvas)
    expect(dracula.text).not.toBe(palettes.light.text)
    expect(paletteFor("nope", "dark").accent).toBe(palettes.dark.accent)
  })
})
