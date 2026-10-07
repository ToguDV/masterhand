import { fireEvent, render, screen } from "@testing-library/react-native"
import { SettingsModal } from "../src/components/SettingsModal"
import { ThemeProvider, useTheme } from "../src/theme"
import { clearTheme, saveTheme } from "../src/storage"

jest.mock("../src/storage", () => ({
  loadTheme: jest.fn(async () => null),
  saveTheme: jest.fn(async () => {}),
  clearTheme: jest.fn(async () => {}),
}))

const mockedSave = saveTheme as jest.Mock
const mockedClear = clearTheme as jest.Mock

/** Drives the modal through the real theme provider, as the screen does. */
function Harness({ onClose = jest.fn(), onSignOut = jest.fn() }: { onClose?: () => void; onSignOut?: () => void }) {
  const { mode, setMode } = useTheme()
  return (
    <SettingsModal
      visible
      mode={mode}
      onSelectMode={setMode}
      onSignOut={onSignOut}
      onClose={onClose}
    />
  )
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe("SettingsModal (#119)", () => {
  it("shows the appearance modes and the active selection", async () => {
    await render(
      <ThemeProvider>
        <Harness />
      </ThemeProvider>,
    )

    expect(screen.getByText("Appearance")).toBeOnTheScreen()
    expect(screen.getByLabelText("System").props.accessibilityState?.checked).toBe(true)
    expect(screen.getByLabelText("Light").props.accessibilityState?.checked).toBe(false)
    expect(screen.getByLabelText("Dark").props.accessibilityState?.checked).toBe(false)
  })

  it("persists an explicit mode and clears it back to system", async () => {
    await render(
      <ThemeProvider>
        <Harness />
      </ThemeProvider>,
    )

    await fireEvent.press(screen.getByLabelText("Dark"))
    expect(mockedSave).toHaveBeenCalledWith("dark")
    expect(screen.getByLabelText("Dark").props.accessibilityState?.checked).toBe(true)

    await fireEvent.press(screen.getByLabelText("System"))
    expect(mockedClear).toHaveBeenCalled()
    expect(screen.getByLabelText("System").props.accessibilityState?.checked).toBe(true)
  })

  it("closes from the header button", async () => {
    const onClose = jest.fn()
    await render(
      <ThemeProvider>
        <Harness onClose={onClose} />
      </ThemeProvider>,
    )

    await fireEvent.press(screen.getByLabelText("Close settings"))
    expect(onClose).toHaveBeenCalled()
  })

  it("signs out from the Account section", async () => {
    const onSignOut = jest.fn()
    const onClose = jest.fn()
    await render(
      <ThemeProvider>
        <Harness onClose={onClose} onSignOut={onSignOut} />
      </ThemeProvider>,
    )

    await fireEvent.press(screen.getByLabelText("Sign out"))
    expect(onSignOut).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })
})
