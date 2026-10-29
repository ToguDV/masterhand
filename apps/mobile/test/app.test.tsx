import { Alert } from "react-native"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native"
import { ApiError, createClient } from "@masterhand/client-core"
import App from "../App"
import {
  clearServerToken,
  getOrCreateInstallID,
  loadServerRegistry,
  loadServerToken,
  saveServerRegistry,
  saveServerToken,
} from "../src/storage"

jest.mock("../src/storage", () => ({
  loadServerRegistry: jest.fn(async () => ({ profiles: [], activeID: null })),
  loadServerToken: jest.fn(async () => null),
  saveServerRegistry: jest.fn(async () => {}),
  saveServerToken: jest.fn(async () => {}),
  clearServerToken: jest.fn(async () => {}),
  getOrCreateInstallID: jest.fn(async () => "install-test"),
  newServerID: jest.fn(() => "srv-test"),
  loadAutoAcceptSessionsFor: jest.fn(async () => []),
  saveAutoAcceptSessionsFor: jest.fn(async () => {}),
  loadSessionPreferences: jest.fn(async () => ({})),
  loadTheme: jest.fn(async () => null),
  loadPalette: jest.fn(async () => null),
  savePalette: jest.fn(async () => {}),
  clearPalette: jest.fn(async () => {}),
  saveSessionPreferences: jest.fn(async () => {}),
  saveTheme: jest.fn(async () => {}),
  clearTheme: jest.fn(async () => {}),
}))

jest.mock("@masterhand/client-core", () => {
  const actual = jest.requireActual("@masterhand/client-core")
  return {
    ...actual,
    createClient: jest.fn(),
    useEventStream: jest.fn(() => jest.fn()),
    useWorkspaces: jest.fn(() => ({ data: [], isLoading: false })),
    useSessions: jest.fn(() => ({ data: [], isLoading: false })),
    useSessionStatuses: jest.fn(() => ({ data: {} })),
    useSessionDirectories: jest.fn(() => ({ data: [] })),
    useBffStatus: jest.fn(() => ({ data: undefined })),
    useUpdate: jest.fn(() => ({ data: undefined })),
    useMessages: jest.fn(() => ({ data: [], isLoading: false })),
    useAgents: jest.fn(() => ({ data: [] })),
    useModels: jest.fn(() => ({ data: { models: [], providers: [], defaultModel: null } })),
  }
})

const createClientMock = createClient as unknown as jest.Mock

const mocked = {
  loadServerRegistry: loadServerRegistry as jest.Mock,
  loadServerToken: loadServerToken as jest.Mock,
  saveServerRegistry: saveServerRegistry as jest.Mock,
  saveServerToken: saveServerToken as jest.Mock,
  clearServerToken: clearServerToken as jest.Mock,
  getOrCreateInstallID: getOrCreateInstallID as jest.Mock,
}

const HOME = {
  id: "home",
  label: "Home",
  url: "https://host",
  device: { id: "d1", name: "Pixel" },
  lastWorkspaceID: null,
  lastSessionID: null,
  expired: false,
  lastUsedAt: 1,
}

function makeClient(loginDevice: jest.Mock = jest.fn(async () => ({
  token: "tok",
  device: { id: "d1", name: "Android device", createdAt: 0, lastUsedAt: 0 },
}))) {
  return {
    auth: {
      loginDevice,
      revokeDevice: jest.fn(async () => {}),
      status: jest.fn(async () => ({ ok: true })),
    },
    api: {
      permissions: jest.fn(async () => []),
      respondPermission: jest.fn(async () => {}),
      integrations: jest.fn(async () => []),
      connectIntegrationKey: jest.fn(async () => {}),
      credentials: jest.fn(async () => []),
      removeCredential: jest.fn(async () => {}),
      activateCredential: jest.fn(async () => {}),
      update: { check: jest.fn(async () => ({ latest: null })) },
      sessions: { create: jest.fn(), remove: jest.fn() },
    },
    workspaces: { create: jest.fn(), remove: jest.fn() },
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mocked.loadServerRegistry.mockResolvedValue({ profiles: [], activeID: null })
  mocked.loadServerToken.mockResolvedValue(null)
  mocked.saveServerRegistry.mockResolvedValue(undefined)
  mocked.saveServerToken.mockResolvedValue(undefined)
  mocked.clearServerToken.mockResolvedValue(undefined)
  mocked.getOrCreateInstallID.mockResolvedValue("install-test")
  createClientMock.mockReturnValue(makeClient())
})

describe("App", () => {
  it("shows the Servers first-run screen when there is no stored session", async () => {
    await render(<App />)

    expect(await screen.findByText("Connect your first server")).toBeOnTheScreen()
    expect(screen.getByTestId("server-url-input")).toBeOnTheScreen()
  })

  it("connects through the device flow, persists the profile and lands on sessions", async () => {
    await render(<App />)

    await fireEvent.changeText(await screen.findByTestId("server-url-input"), "https://host")
    await fireEvent.changeText(screen.getByTestId("password-input"), "pw")
    await fireEvent.press(screen.getByTestId("connect-button"))

    expect(await screen.findByText("Add a workspace to start working on a project.")).toBeOnTheScreen()
    expect(mocked.saveServerToken).toHaveBeenCalledWith("srv-test", "tok")
    expect(mocked.saveServerRegistry).toHaveBeenCalledWith(
      expect.objectContaining({
        activeID: "srv-test",
        profiles: [
          expect.objectContaining({
            id: "srv-test",
            url: "https://host",
            device: expect.objectContaining({ id: "d1" }),
          }),
        ],
      }),
    )
  })

  it("sends the stable install id with the device login", async () => {
    const loginDevice = jest.fn(async () => ({
      token: "tok",
      device: { id: "d1", name: "Android device", installID: "install-test", createdAt: 0, lastUsedAt: 0 },
    }))
    createClientMock.mockReturnValue(makeClient(loginDevice))
    await render(<App />)

    await fireEvent.changeText(await screen.findByTestId("server-url-input"), "https://host")
    await fireEvent.changeText(screen.getByTestId("password-input"), "pw")
    await fireEvent.press(screen.getByTestId("connect-button"))

    expect(await screen.findByText("Add a workspace to start working on a project.")).toBeOnTheScreen()
    expect(mocked.getOrCreateInstallID).toHaveBeenCalled()
    expect(loginDevice).toHaveBeenCalledWith("pw", expect.any(String), "install-test")
  })

  it("shows the wrong-password error inline", async () => {
    const loginDevice = jest.fn(async () => {
      throw new ApiError(401, "unauthorized")
    })
    createClientMock.mockReturnValue(makeClient(loginDevice))
    await render(<App />)

    await fireEvent.changeText(await screen.findByTestId("server-url-input"), "https://host")
    await fireEvent.changeText(screen.getByTestId("password-input"), "bad")
    await fireEvent.press(screen.getByTestId("connect-button"))

    expect(await screen.findByText("Wrong password. Try again.")).toBeOnTheScreen()
  })

  it("restores a saved token and disconnects without forgetting the profile", async () => {
    mocked.loadServerRegistry.mockResolvedValue({ profiles: [HOME], activeID: "home" })
    mocked.loadServerToken.mockResolvedValue("stored-token")
    await render(<App />)

    expect(await screen.findByText("Add a workspace to start working on a project.")).toBeOnTheScreen()

    await fireEvent.press(screen.getByLabelText("Settings"))
    await fireEvent.press(screen.getByLabelText("Close settings"))
    await fireEvent.press(screen.getByLabelText("Settings"))
    await fireEvent.press(screen.getByLabelText("Disconnect from the active server"))

    await waitFor(() => expect(mocked.clearServerToken).toHaveBeenCalledWith("home"))
    expect(await screen.findByText("Home")).toBeOnTheScreen()
    expect(screen.getByText("Add another server")).toBeOnTheScreen()
  })

  it("shows the Servers screen with a storage error when SecureStore fails at startup (#82)", async () => {
    mocked.loadServerRegistry.mockRejectedValue(new Error("keychain unavailable"))
    await render(<App />)

    expect(await screen.findByText("Connect your first server")).toBeOnTheScreen()
    expect(await screen.findByText(/secure storage/i)).toBeOnTheScreen()
  })

  it("reconnects an expired saved profile and updates it in place", async () => {
    mocked.loadServerRegistry.mockResolvedValue({
      profiles: [{ ...HOME, expired: true }],
      activeID: "home",
    })
    mocked.loadServerToken.mockResolvedValue("old-token")
    await render(<App />)

    expect(await screen.findByText(/Reconnect to Home/)).toBeOnTheScreen()
    await fireEvent.changeText(screen.getByTestId("password-input"), "pw")
    await fireEvent.press(screen.getByTestId("connect-button"))

    expect(await screen.findByText("Add a workspace to start working on a project.")).toBeOnTheScreen()
    expect(mocked.saveServerRegistry).toHaveBeenCalledWith(
      expect.objectContaining({
        profiles: [
          expect.objectContaining({ id: "home", expired: false, device: expect.objectContaining({ id: "d1" }) }),
        ],
      }),
    )
  })

  it("rejects adding a server beyond the profile cap", async () => {
    const profiles = Array.from({ length: 50 }, (_, index) => ({
      ...HOME,
      id: `profile-${index}`,
      label: `Server ${index}`,
      url: `https://server-${index}.example.com`,
    }))
    mocked.loadServerRegistry.mockResolvedValue({ profiles, activeID: profiles[0]!.id })
    mocked.loadServerToken.mockResolvedValue("stored-token")
    await render(<App />)
    await screen.findByText("Add a workspace to start working on a project.")

    await fireEvent.press(screen.getByLabelText("Settings"))
    await fireEvent.press(screen.getByLabelText("Open Servers"))
    await fireEvent.press(screen.getByLabelText("Add server"))
    await fireEvent.changeText(screen.getByTestId("server-url-input"), "https://one-more.example.com")
    await fireEvent.changeText(screen.getByTestId("password-input"), "pw")
    await fireEvent.press(screen.getByTestId("connect-button"))

    expect(await screen.findByText("You can save at most 50 servers.")).toBeOnTheScreen()
    expect(mocked.saveServerToken).not.toHaveBeenCalled()
  })

  it("rejects an invalid URL before starting a connection", async () => {
    await render(<App />)

    await fireEvent.changeText(await screen.findByTestId("server-url-input"), "not a url")
    await fireEvent.changeText(screen.getByTestId("password-input"), "pw")
    await fireEvent.press(screen.getByTestId("connect-button"))

    expect(await screen.findByText(/Enter a valid URL/)).toBeOnTheScreen()
    expect(mocked.saveServerToken).not.toHaveBeenCalled()
  })

  it("switches between saved profiles without re-authentication", async () => {
    const second = {
      ...HOME,
      id: "studio",
      label: "Studio",
      url: "https://studio.example.com",
    }
    mocked.loadServerRegistry.mockResolvedValue({ profiles: [HOME, second], activeID: "home" })
    mocked.loadServerToken.mockResolvedValue("stored-token")
    await render(<App />)

    expect(await screen.findByText("Add a workspace to start working on a project.")).toBeOnTheScreen()
    await fireEvent.press(screen.getByLabelText("Server: Home"))
    await fireEvent.press(screen.getByTestId("switcher-server-studio"))
    expect(await screen.findByLabelText("Server: Studio")).toBeOnTheScreen()
  })

  it("persists the switched active id, verifies the token and isolates client tokens", async () => {
    const second = {
      ...HOME,
      id: "studio",
      label: "Studio",
      url: "https://studio.example.com",
    }
    mocked.loadServerRegistry.mockResolvedValue({ profiles: [HOME, second], activeID: "home" })
    mocked.loadServerToken.mockImplementation(async (id: string) =>
      id === "home" ? "home-token" : "studio-token",
    )
    await render(<App />)

    await screen.findByText("Add a workspace to start working on a project.")
    await fireEvent.press(screen.getByLabelText("Server: Home"))
    await fireEvent.press(screen.getByTestId("switcher-server-studio"))
    expect(await screen.findByLabelText("Server: Studio")).toBeOnTheScreen()

    await waitFor(() =>
      expect(mocked.saveServerRegistry).toHaveBeenCalledWith(
        expect.objectContaining({ activeID: "studio" }),
      ),
    )
    const tokenGetters = createClientMock.mock.calls
      .map((call) => (call[0] as { getToken?: () => string | null }).getToken)
      .filter((getter): getter is () => string | null => typeof getter === "function")
    expect(tokenGetters[0]?.()).toBe("home-token")
    expect(tokenGetters.at(-1)?.()).toBe("studio-token")

    // A late 401 from the unmounted Home client must not abort the switch.
    const homeOptions = createClientMock.mock.calls
      .map((call) => call[0] as { baseUrl?: string; onUnauthorized?: () => void })
      .find((options) => options.baseUrl === "https://host")
    await act(async () => {
      homeOptions?.onUnauthorized?.()
    })
    expect(screen.getByLabelText("Server: Studio")).toBeOnTheScreen()
  })

  it("sends a saved switch with an expired token to re-auth", async () => {
    const second = {
      ...HOME,
      id: "studio",
      label: "Studio",
      url: "https://studio.example.com",
    }
    mocked.loadServerRegistry.mockResolvedValue({ profiles: [HOME, second], activeID: "home" })
    mocked.loadServerToken.mockImplementation(async (id: string) =>
      id === "home" ? "home-token" : "studio-token",
    )
    const client = makeClient()
    client.auth.status.mockRejectedValue(new ApiError(401, "expired"))
    createClientMock.mockReturnValue(client)
    await render(<App />)

    await screen.findByText("Add a workspace to start working on a project.")
    await fireEvent.press(screen.getByLabelText("Server: Home"))
    await fireEvent.press(screen.getByTestId("switcher-server-studio"))

    expect(await screen.findByText(/Reconnect to Studio/)).toBeOnTheScreen()
    await waitFor(() => expect(mocked.clearServerToken).toHaveBeenCalledWith("studio"))
  })

  it("does not revoke a device still used by another saved profile", async () => {
    const shared = {
      ...HOME,
      id: "studio",
      label: "Studio",
      url: "https://studio.example.com",
    }
    mocked.loadServerRegistry.mockResolvedValue({ profiles: [HOME, shared], activeID: "home" })
    mocked.loadServerToken.mockResolvedValue("stored-token")
    const client = makeClient()
    createClientMock.mockReturnValue(client)
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {})
    await render(<App />)
    await screen.findByText("Add a workspace to start working on a project.")

    await fireEvent.press(screen.getByLabelText("Settings"))
    await fireEvent.press(screen.getByLabelText("Open Servers"))
    await fireEvent.press(screen.getByLabelText("Remove Home"))
    alert.mock.calls.at(-1)?.[2]?.find((button) => button.style === "destructive")?.onPress?.()

    await waitFor(() => expect(mocked.clearServerToken).toHaveBeenCalledWith("home"))
    expect(client.auth.revokeDevice).not.toHaveBeenCalled()
    alert.mockRestore()
  })

  it("shows a failed saved switch on the server list", async () => {
    const second = {
      ...HOME,
      id: "studio",
      label: "Studio",
      url: "https://studio.example.com",
    }
    mocked.loadServerRegistry.mockResolvedValue({ profiles: [HOME, second], activeID: "home" })
    mocked.loadServerToken.mockResolvedValue("stored-token")
    const client = makeClient()
    client.auth.status.mockRejectedValue(new Error("network down"))
    createClientMock.mockReturnValue(client)
    await render(<App />)
    await screen.findByText("Add a workspace to start working on a project.")

    await fireEvent.press(screen.getByLabelText("Server: Home"))
    await fireEvent.press(screen.getByTestId("switcher-server-studio"))
    expect(await screen.findByText(/Could not reach studio.example.com/)).toBeOnTheScreen()
    expect(screen.getByText("Studio")).toBeOnTheScreen()
  })

  it("disconnects before the revocation request settles", async () => {
    mocked.loadServerRegistry.mockResolvedValue({ profiles: [HOME], activeID: "home" })
    mocked.loadServerToken.mockResolvedValue("stored-token")
    let releaseRevoke!: () => void
    const client = makeClient()
    client.auth.revokeDevice.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseRevoke = resolve
        }),
    )
    createClientMock.mockReturnValue(client)
    await render(<App />)
    await screen.findByText("Add a workspace to start working on a project.")

    await fireEvent.press(screen.getByLabelText("Settings"))
    await fireEvent.press(screen.getByLabelText("Disconnect from the active server"))
    // The UI leaves the app before the best-effort DELETE resolves.
    expect(await screen.findByText("Add another server")).toBeOnTheScreen()
    await waitFor(() => expect(mocked.clearServerToken).toHaveBeenCalledWith("home"))
    await act(async () => {
      releaseRevoke()
    })
  })

  it("asks for the password when a saved profile has no token", async () => {
    const second = {
      ...HOME,
      id: "studio",
      label: "Studio",
      url: "https://studio.example.com",
    }
    mocked.loadServerRegistry.mockResolvedValue({ profiles: [HOME, second], activeID: "home" })
    mocked.loadServerToken.mockImplementation(async (id: string) =>
      id === "home" ? "stored-token" : null,
    )
    await render(<App />)

    await screen.findByText("Add a workspace to start working on a project.")
    await fireEvent.press(screen.getByLabelText("Server: Home"))
    await fireEvent.press(screen.getByTestId("switcher-server-studio"))
    expect(await screen.findByText(/Reconnect to Studio/)).toBeOnTheScreen()
  })

  it("ignores a login that resolves after Cancel and revokes its token", async () => {
    let resolveLogin!: (value: unknown) => void
    const loginDevice = jest.fn(
      () =>
        new Promise((resolve) => {
          resolveLogin = resolve
        }),
    )
    const client = makeClient(loginDevice)
    createClientMock.mockReturnValue(client)
    await render(<App />)

    await fireEvent.changeText(await screen.findByTestId("server-url-input"), "https://host")
    await fireEvent.changeText(screen.getByTestId("server-name-input"), "Remote")
    await fireEvent.changeText(screen.getByTestId("password-input"), "pw")
    await fireEvent.press(screen.getByTestId("connect-button"))

    expect(await screen.findByText("Connecting to Remote")).toBeOnTheScreen()
    await fireEvent.press(screen.getByTestId("cancel-connect"))
    expect(screen.queryByText("Connecting to Remote")).toBeNull()

    await act(async () => {
      resolveLogin({
        token: "late-token",
        device: { id: "late-device", name: "Android", createdAt: 0, lastUsedAt: 0 },
      })
    })

    await waitFor(() => expect(client.auth.revokeDevice).toHaveBeenCalledWith("late-device"))
    expect(mocked.saveServerToken).not.toHaveBeenCalled()
    expect(mocked.saveServerRegistry).not.toHaveBeenCalled()
    expect(await screen.findByText("Connect your first server")).toBeOnTheScreen()
  })

  it("clears the local token when cancel lands after the device login", async () => {
    let resolveSave!: () => void
    mocked.saveServerToken.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveSave = resolve
      }),
    )
    const client = makeClient()
    createClientMock.mockReturnValue(client)
    await render(<App />)

    await fireEvent.changeText(await screen.findByTestId("server-url-input"), "https://host")
    await fireEvent.changeText(screen.getByTestId("server-name-input"), "Remote")
    await fireEvent.changeText(screen.getByTestId("password-input"), "pw")
    await fireEvent.press(screen.getByTestId("connect-button"))
    expect(await screen.findByText("Connecting to Remote")).toBeOnTheScreen()

    await fireEvent.press(screen.getByTestId("cancel-connect"))
    await act(async () => {
      resolveSave()
    })

    await waitFor(() => expect(client.auth.revokeDevice).toHaveBeenCalledWith("d1"))
    expect(mocked.clearServerToken).toHaveBeenCalledWith("srv-test")
    expect(mocked.saveServerRegistry).not.toHaveBeenCalled()
  })

  it("rejects adding a duplicate server before connecting", async () => {
    mocked.loadServerRegistry.mockResolvedValue({ profiles: [HOME], activeID: "home" })
    mocked.loadServerToken.mockResolvedValue("stored-token")
    await render(<App />)
    await screen.findByText("Add a workspace to start working on a project.")

    await fireEvent.press(screen.getByLabelText("Settings"))
    await fireEvent.press(screen.getByLabelText("Open Servers"))
    await fireEvent.press(screen.getByLabelText("Add server"))
    await fireEvent.changeText(screen.getByTestId("server-url-input"), "https://host/")
    await fireEvent.changeText(screen.getByTestId("password-input"), "pw")
    await fireEvent.press(screen.getByTestId("connect-button"))

    expect(await screen.findByText("This server is already saved.")).toBeOnTheScreen()
    expect(mocked.saveServerToken).not.toHaveBeenCalled()
  })

  it("warns when the server list cannot be persisted", async () => {
    mocked.saveServerRegistry.mockRejectedValue(new Error("keychain unavailable"))
    await render(<App />)

    await fireEvent.changeText(await screen.findByTestId("server-url-input"), "https://host")
    await fireEvent.changeText(screen.getByTestId("password-input"), "pw")
    await fireEvent.press(screen.getByTestId("connect-button"))

    expect(await screen.findByText(/server list could not be saved/i)).toBeOnTheScreen()
  })

  it("renames and removes a profile from Settings > Servers", async () => {
    mocked.loadServerRegistry.mockResolvedValue({ profiles: [HOME], activeID: "home" })
    mocked.loadServerToken.mockResolvedValue("stored-token")
    await render(<App />)
    await screen.findByText("Add a workspace to start working on a project.")
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {})

    await fireEvent.press(screen.getByLabelText("Settings"))
    await fireEvent.press(screen.getByLabelText("Open Servers"))
    await fireEvent.press(screen.getByLabelText("Rename Home"))
    await fireEvent.changeText(screen.getByLabelText("Name for Home"), "Home lab")
    await fireEvent.press(screen.getByLabelText("Save name"))
    await waitFor(() =>
      expect(mocked.saveServerRegistry).toHaveBeenCalledWith(
        expect.objectContaining({ profiles: [expect.objectContaining({ label: "Home lab" })] }),
      ),
    )

    await fireEvent.press(screen.getByLabelText("Remove Home lab"))
    alert.mock.calls.at(-1)?.[2]?.find((button) => button.style === "destructive")?.onPress?.()
    await waitFor(() => expect(mocked.clearServerToken).toHaveBeenCalledWith("home"))
    expect(await screen.findByText("Connect your first server")).toBeOnTheScreen()
    alert.mockRestore()
  })

  it("disconnects the active profile from Settings > Servers", async () => {
    mocked.loadServerRegistry.mockResolvedValue({ profiles: [HOME], activeID: "home" })
    mocked.loadServerToken.mockResolvedValue("stored-token")
    await render(<App />)
    await screen.findByText("Add a workspace to start working on a project.")
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {})

    await fireEvent.press(screen.getByLabelText("Settings"))
    await fireEvent.press(screen.getByLabelText("Open Servers"))
    await fireEvent.press(screen.getByLabelText("Disconnect Home"))
    alert.mock.calls.at(-1)?.[2]?.find((button) => button.style === "destructive")?.onPress?.()

    await waitFor(() => expect(mocked.clearServerToken).toHaveBeenCalledWith("home"))
    expect(await screen.findByText("Add another server")).toBeOnTheScreen()
    alert.mockRestore()
  })

  it("opens the add-server form from Settings > Servers", async () => {
    mocked.loadServerRegistry.mockResolvedValue({ profiles: [HOME], activeID: "home" })
    mocked.loadServerToken.mockResolvedValue("stored-token")
    await render(<App />)
    await screen.findByText("Add a workspace to start working on a project.")

    await fireEvent.press(screen.getByLabelText("Settings"))
    await fireEvent.press(screen.getByLabelText("Open Servers"))
    await fireEvent.press(screen.getByLabelText("Add server"))
    expect(await screen.findByText("Add a server")).toBeOnTheScreen()
    expect(screen.getByTestId("server-url-input")).toBeOnTheScreen()
    await fireEvent.press(screen.getByLabelText("Back to servers"))
    expect(await screen.findByText("Add another server")).toBeOnTheScreen()
  })

  it("keeps the session in memory and warns when it cannot be saved (#82)", async () => {
    mocked.saveServerToken.mockRejectedValue(new Error("keychain unavailable"))
    await render(<App />)

    await fireEvent.changeText(await screen.findByTestId("server-url-input"), "https://host")
    await fireEvent.changeText(screen.getByTestId("password-input"), "pw")
    await fireEvent.press(screen.getByTestId("connect-button"))

    expect(await screen.findByText("Add a workspace to start working on a project.")).toBeOnTheScreen()
    expect(await screen.findByText(/could not save the session/i)).toBeOnTheScreen()
  })
})
