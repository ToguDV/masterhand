import { fireEvent, render, screen } from "@testing-library/react-native"
import { ApiError, createClient } from "@masterhand/client-core"
import App from "../App"
import {
  clearDevice,
  clearToken,
  clearWorkspaceID,
  loadServerUrl,
  loadToken,
  saveServerUrl,
  saveToken,
} from "../src/storage"

jest.mock("../src/storage", () => ({
  loadServerUrl: jest.fn(async () => null),
  loadToken: jest.fn(async () => null),
  loadDevice: jest.fn(async () => null),
  loadWorkspaceID: jest.fn(async () => null),
  loadAutoAcceptSessions: jest.fn(async () => []),
  loadSessionPreferences: jest.fn(async () => ({})),
  loadTheme: jest.fn(async () => null),
  loadPalette: jest.fn(async () => null),
  savePalette: jest.fn(async () => {}),
  clearPalette: jest.fn(async () => {}),
  saveServerUrl: jest.fn(async () => {}),
  saveToken: jest.fn(async () => {}),
  saveDevice: jest.fn(async () => {}),
  saveWorkspaceID: jest.fn(async () => {}),
  saveAutoAcceptSessions: jest.fn(async () => {}),
  saveSessionPreferences: jest.fn(async () => {}),
  saveTheme: jest.fn(async () => {}),
  clearTheme: jest.fn(async () => {}),
  clearToken: jest.fn(async () => {}),
  clearDevice: jest.fn(async () => {}),
  clearWorkspaceID: jest.fn(async () => {}),
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
  }
})

const createClientMock = createClient as unknown as jest.Mock

const mocked = {
  loadServerUrl: loadServerUrl as jest.Mock,
  loadToken: loadToken as jest.Mock,
  saveServerUrl: saveServerUrl as jest.Mock,
  saveToken: saveToken as jest.Mock,
  clearToken: clearToken as jest.Mock,
  clearDevice: clearDevice as jest.Mock,
  clearWorkspaceID: clearWorkspaceID as jest.Mock,
}

function makeClient(loginDevice: jest.Mock = jest.fn(async () => ({
  token: "tok",
  device: { id: "d1", name: "Android device", createdAt: 0, lastUsedAt: 0 },
}))) {
  return {
    auth: { loginDevice, revokeDevice: jest.fn(async () => {}) },
    api: {
      permissions: jest.fn(async () => []),
      respondPermission: jest.fn(async () => {}),
      integrations: jest.fn(async () => []),
      connectIntegrationKey: jest.fn(async () => {}),
      credentials: jest.fn(async () => []),
      removeCredential: jest.fn(async () => {}),
      activateCredential: jest.fn(async () => {}),
      sessions: { create: jest.fn(), remove: jest.fn() },
    },
    workspaces: { create: jest.fn(), remove: jest.fn() },
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mocked.loadServerUrl.mockResolvedValue(null)
  mocked.loadToken.mockResolvedValue(null)
  createClientMock.mockReturnValue(makeClient())
})

describe("App", () => {
  it("shows the login screen when there is no stored session", async () => {
    await render(<App />)

    expect(await screen.findByText("Your opencode agents, from anywhere.")).toBeOnTheScreen()
  })

  it("signs in through the device flow and lands on the sessions screen", async () => {
    mocked.loadServerUrl.mockResolvedValue("https://host")
    await render(<App />)

    await fireEvent.changeText(await screen.findByDisplayValue("https://host"), "https://host")
    await fireEvent.changeText(screen.getByPlaceholderText("••••••••"), "pw")
    await fireEvent.press(screen.getByText("Sign in"))

    expect(await screen.findByText("Sessions")).toBeOnTheScreen()
    expect(mocked.saveToken).toHaveBeenCalledWith("tok")
    expect(mocked.saveServerUrl).toHaveBeenCalledWith("https://host")
  })

  it("shows the wrong-password error from the server", async () => {
    const loginDevice = jest.fn(async () => {
      throw new ApiError(401, "unauthorized")
    })
    createClientMock.mockReturnValue(makeClient(loginDevice))
    await render(<App />)

    await fireEvent.changeText(await screen.findByPlaceholderText("https://masterhand.example.com"), "https://host")
    await fireEvent.changeText(screen.getByPlaceholderText("••••••••"), "bad")
    await fireEvent.press(screen.getByText("Sign in"))

    expect(await screen.findByText("Wrong password")).toBeOnTheScreen()
  })

  it("renders the app for a stored token and signs out", async () => {
    mocked.loadToken.mockResolvedValue("stored-token")
    mocked.loadServerUrl.mockResolvedValue("https://host")
    await render(<App />)

    expect(await screen.findByText("Add a workspace to start working on a project.")).toBeOnTheScreen()

    // Sign out lives in the sessions panel options box.
    await fireEvent.press(screen.getByLabelText("Sign out"))

    expect(mocked.clearToken).toHaveBeenCalled()
    expect(await screen.findByText("Your opencode agents, from anywhere.")).toBeOnTheScreen()
  })

  it("shows the login screen with a storage error when SecureStore fails at startup (#82)", async () => {
    mocked.loadServerUrl.mockRejectedValue(new Error("keychain unavailable"))
    await render(<App />)

    // Never a permanent spinner: the login screen appears with the real reason.
    expect(await screen.findByText("Your opencode agents, from anywhere.")).toBeOnTheScreen()
    expect(await screen.findByText(/secure storage/i)).toBeOnTheScreen()
  })

  it("keeps the session in memory and warns when it cannot be saved (#82)", async () => {
    mocked.loadServerUrl.mockResolvedValue("https://host")
    mocked.saveToken.mockRejectedValue(new Error("keychain unavailable"))
    await render(<App />)

    await fireEvent.changeText(await screen.findByDisplayValue("https://host"), "https://host")
    await fireEvent.changeText(screen.getByPlaceholderText("••••••••"), "pw")
    await fireEvent.press(screen.getByText("Sign in"))

    // The login still lands; the banner says the session will not survive a restart.
    expect(await screen.findByText("Sessions")).toBeOnTheScreen()
    expect(await screen.findByText(/could not save the session/i)).toBeOnTheScreen()
  })
})
