import { fireEvent, render, screen } from "@testing-library/react-native"
import { ServersScreen } from "../src/screens/ServersScreen"
import { ServerStatus } from "../src/components/ServerStatus"
import { ServerSwitcher } from "../src/components/ServerSwitcher"
import { ThemeProvider } from "../src/theme"
import type { StoredServerProfile } from "../src/storage"

jest.mock("../src/storage", () => ({
  loadTheme: jest.fn(async () => null),
  loadPalette: jest.fn(async () => null),
  savePalette: jest.fn(async () => {}),
  clearPalette: jest.fn(async () => {}),
  saveTheme: jest.fn(async () => {}),
  clearTheme: jest.fn(async () => {}),
}))

function profile(overrides: Partial<StoredServerProfile> = {}): StoredServerProfile {
  return {
    id: "home",
    label: "Home",
    url: "https://home.example.com",
    device: { id: "d1", name: "Pixel" },
    lastWorkspaceID: null,
    lastSessionID: null,
    expired: false,
    lastUsedAt: 1,
    ...overrides,
  }
}

async function renderScreen(ui: React.ReactNode) {
  return render(<ThemeProvider>{ui}</ThemeProvider>)
}

describe("ServerStatus (native)", () => {
  it("renders status text for every state", async () => {
    const { rerender } = await renderScreen(<ServerStatus status="connected" />)
    expect(screen.getByText("Connected")).toBeOnTheScreen()

    await rerender(
      <ThemeProvider>
        <ServerStatus status="saved" />
      </ThemeProvider>,
    )
    expect(screen.getByText("Saved")).toBeOnTheScreen()

    await rerender(
      <ThemeProvider>
        <ServerStatus status="expired" />
      </ThemeProvider>,
    )
    expect(screen.getByText("Expired")).toBeOnTheScreen()

    await rerender(
      <ThemeProvider>
        <ServerStatus status="connecting" />
      </ThemeProvider>,
    )
    expect(screen.getByText("Connecting")).toBeOnTheScreen()
  })
})

describe("ServersScreen (native)", () => {
  it("connects the first server from the prefilled form", async () => {
    const onSubmit = jest.fn()
    const { rerender } = await renderScreen(
      <ServersScreen
        profiles={[]}
        activeID={null}
        initialUrl="https://host.example.com"
        busy={false}
        error={null}
        notice={null}
        reauthProfile={null}
        onSubmit={onSubmit}
        onSelect={jest.fn()}
        onCancel={jest.fn()}
        onCancelAdd={jest.fn()}
      />,
    )

    expect(screen.getByDisplayValue("https://host.example.com")).toBeOnTheScreen()
    await fireEvent.changeText(screen.getByTestId("password-input"), "hunter2")
    await fireEvent.press(screen.getByTestId("connect-button"))
    expect(onSubmit).toHaveBeenCalledWith(
      "first-run",
      { url: "https://host.example.com", label: "", password: "hunter2" },
      undefined,
    )

    await rerender(
      <ThemeProvider>
        <ServersScreen
          profiles={[profile()]}
          activeID={null}
          initialUrl=""
          busy={false}
          error="Wrong password. Try again."
          notice={null}
          reauthProfile={profile()}
          onSubmit={onSubmit}
          onSelect={jest.fn()}
          onCancel={jest.fn()}
          onCancelAdd={jest.fn()}
        />
      </ThemeProvider>,
    )
    expect(screen.getByText(/Reconnect to Home/)).toBeOnTheScreen()
    expect(screen.getByText("Wrong password. Try again.")).toBeOnTheScreen()
  })

  it("lists saved servers with status and re-auths an expired one", async () => {
    const onSelect = jest.fn()
    const expired = profile({ id: "vps", label: "VPS", url: "https://vps.example.com", expired: true })
    await renderScreen(
      <ServersScreen
        profiles={[profile(), expired]}
        activeID="home"
        initialUrl=""
        busy={false}
        error={null}
        notice={null}
        reauthProfile={null}
        onSubmit={jest.fn()}
        onSelect={onSelect}
        onCancel={jest.fn()}
        onCancelAdd={jest.fn()}
      />,
    )

    expect(screen.getByText("Home")).toBeOnTheScreen()
    expect(screen.getByText("VPS")).toBeOnTheScreen()
    expect(screen.getByText("Connected")).toBeOnTheScreen()
    expect(screen.getByText("Expired")).toBeOnTheScreen()
    await fireEvent.press(screen.getByLabelText("Add another server"))
    expect(screen.getByTestId("server-url-input")).toBeOnTheScreen()
    await fireEvent.press(screen.getByLabelText("Back to servers"))
    await fireEvent.press(screen.getByTestId("server-row-vps"))
    expect(onSelect).toHaveBeenCalledWith(expired)
  })

  it("reveals the password and returns from the add form", async () => {
    const onCancel = jest.fn()
    const onCancelAdd = jest.fn()
    await renderScreen(
      <ServersScreen
        profiles={[profile()]}
        activeID={null}
        initialUrl=""
        busy={false}
        error={null}
        notice={null}
        reauthProfile={null}
        startAdding
        onSubmit={jest.fn()}
        onSelect={jest.fn()}
        onCancel={onCancel}
        onCancelAdd={onCancelAdd}
      />,
    )

    await fireEvent.press(screen.getByLabelText("Show password"))
    expect(screen.getByLabelText("Hide password")).toBeOnTheScreen()
    await fireEvent.press(screen.getByLabelText("Back to servers"))
    expect(onCancelAdd).toHaveBeenCalled()
    expect(onCancel).toHaveBeenCalled()
  })

  it("rejects malformed and insecure URLs", async () => {
    const onSubmit = jest.fn()
    await renderScreen(
      <ServersScreen
        profiles={[profile()]}
        activeID={null}
        initialUrl=""
        busy={false}
        error={null}
        notice={null}
        reauthProfile={null}
        startAdding
        onSubmit={onSubmit}
        onSelect={jest.fn()}
        onCancel={jest.fn()}
        onCancelAdd={jest.fn()}
      />,
    )

    await fireEvent.changeText(screen.getByTestId("server-url-input"), "not a url")
    await fireEvent.changeText(screen.getByTestId("password-input"), "pw")
    await fireEvent.press(screen.getByTestId("connect-button"))
    expect(screen.getByText(/Enter a valid URL/)).toBeOnTheScreen()
    expect(onSubmit).not.toHaveBeenCalled()

    await fireEvent.changeText(screen.getByTestId("server-url-input"), "http://remote.example.com")
    await fireEvent.press(screen.getByTestId("connect-button"))
    expect(screen.getByText(/Use https/)).toBeOnTheScreen()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("renders a malformed saved URL without crashing", async () => {
    await renderScreen(
      <ServersScreen
        profiles={[profile({ id: "broken", label: "Broken", url: "not a url" })]}
        activeID={null}
        initialUrl=""
        busy={false}
        error={null}
        notice={null}
        reauthProfile={null}
        onSubmit={jest.fn()}
        onSelect={jest.fn()}
        onCancel={jest.fn()}
        onCancelAdd={jest.fn()}
      />,
    )
    expect(screen.getByText("not a url")).toBeOnTheScreen()
  })

  it("validates the URL and duplicate servers before submitting", async () => {
    const onSubmit = jest.fn()
    await renderScreen(
      <ServersScreen
        profiles={[profile()]}
        activeID={null}
        initialUrl=""
        busy={false}
        error={null}
        notice={null}
        reauthProfile={null}
        startAdding
        onSubmit={onSubmit}
        onSelect={jest.fn()}
        onCancel={jest.fn()}
        onCancelAdd={jest.fn()}
      />,
    )

    await fireEvent.changeText(screen.getByTestId("server-url-input"), "https://home.example.com/")
    await fireEvent.changeText(screen.getByTestId("password-input"), "pw")
    await fireEvent.press(screen.getByTestId("connect-button"))
    expect(screen.getByText("This server is already saved.")).toBeOnTheScreen()
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

describe("ServerSwitcher (native)", () => {
  it("opens the sheet, switches servers and exposes add/manage", async () => {
    const home = profile()
    const studio = profile({ id: "studio", label: "Studio", url: "https://studio.example.com" })
    const onSwitch = jest.fn()
    const onManage = jest.fn()
    const onAdd = jest.fn()
    await renderScreen(
      <ServerSwitcher
        profiles={[home, studio]}
        activeProfile={home}
        onSwitch={onSwitch}
        onManage={onManage}
        onAdd={onAdd}
      />,
    )

    await fireEvent.press(screen.getByTestId("server-switcher-trigger"))
    expect(screen.getByText("Studio")).toBeOnTheScreen()
    await fireEvent.press(screen.getByTestId("switcher-server-studio"))
    expect(onSwitch).toHaveBeenCalledWith(studio)

    await fireEvent.press(screen.getByTestId("server-switcher-trigger"))
    await fireEvent.press(screen.getByTestId("switcher-add-server"))
    expect(onAdd).toHaveBeenCalled()

    await fireEvent.press(screen.getByTestId("server-switcher-trigger"))
    await fireEvent.press(screen.getAllByLabelText("Close servers").at(-1)!)
    expect(screen.queryByText("One connection at a time.")).toBeNull()

    await fireEvent.press(screen.getByTestId("server-switcher-trigger"))
    await fireEvent.press(screen.getByLabelText("Manage servers"))
    expect(onManage).toHaveBeenCalled()
  })
})
