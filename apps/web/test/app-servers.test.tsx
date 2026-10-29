// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "@masterhand/client-core"
import App from "../src/App"
import { loadRegistry } from "../src/servers"

const mocks = vi.hoisted(() => ({
  createServerClient: vi.fn(),
  setActiveClient: vi.fn(),
  getActiveClient: vi.fn(),
  client: {},
}))

vi.mock("../src/client", () => ({
  createServerClient: mocks.createServerClient,
  setActiveClient: mocks.setActiveClient,
  getActiveClient: mocks.getActiveClient,
  client: mocks.client,
}))

vi.mock("@masterhand/client-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@masterhand/client-core")>()
  return {
    ...actual,
    useBffStatus: vi.fn(() => ({ data: undefined, isSuccess: false })),
    useUpdate: vi.fn(() => ({ data: undefined })),
    useEventStream: vi.fn(() => vi.fn()),
    useWorkspaces: vi.fn(() => ({ data: [] })),
    useSessions: vi.fn(() => ({ data: [] })),
    useSessionStatuses: vi.fn(() => ({ data: {} })),
    useSessionDirectories: vi.fn(() => ({ data: [] })),
  }
})

function makeClient() {
  return {
    auth: {
      login: vi.fn(async () => {}),
      logout: vi.fn(async () => {}),
      loginDevice: vi.fn(async () => ({
        token: "tok",
        device: { id: "dev-1", name: "Web", createdAt: 0, lastUsedAt: 0 },
      })),
      status: vi.fn(async () => ({ ok: true })),
      revokeDevice: vi.fn(async () => {}),
    },
    api: {},
    workspaces: {},
    eventStream: vi.fn(),
  }
}

function tokenKeys(): string[] {
  return Object.keys(window.localStorage).filter((key) =>
    key.startsWith("masterhand.server.token."),
  )
}

beforeEach(() => {
  window.localStorage.clear()
  vi.clearAllMocks()
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
})

afterEach(cleanup)

describe("web multi-server connection lifecycle", () => {
  it("revokes a device token issued after the attempt was cancelled", async () => {
    let resolveLogin!: (value: {
      token: string
      device: { id: string; name: string; createdAt: number; lastUsedAt: number }
    }) => void
    let calls = 0
    mocks.createServerClient.mockImplementation(() => {
      const index = calls++
      const client = makeClient()
      if (index === 0) client.auth.status.mockRejectedValue(new ApiError(401, "unauthorized"))
      if (index === 1) {
        client.auth.loginDevice.mockImplementation(
          () =>
            new Promise<{
              token: string
              device: { id: string; name: string; createdAt: number; lastUsedAt: number }
            }>((resolve) => {
              resolveLogin = resolve
            }),
        )
      }
      return client
    })

    render(<App />)
    expect(await screen.findByText("Connect your first server")).toBeTruthy()
    fireEvent.change(screen.getByLabelText("Server URL"), {
      target: { value: "https://remote.example" },
    })
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "Remote" } })
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw" } })
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))
    expect(await screen.findByText("Connecting to Remote")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    await act(async () => {
      resolveLogin({
        token: "late-token",
        device: { id: "late-device", name: "Web", createdAt: 0, lastUsedAt: 0 },
      })
    })

    const revokeClient = mocks.createServerClient.mock.results.at(-1)?.value
    await waitFor(() => expect(revokeClient.auth.revokeDevice).toHaveBeenCalledWith("late-device"))
    expect(loadRegistry().profiles).toHaveLength(0)
    expect(tokenKeys()).toEqual([])
  })

  it("rejects adding a server beyond the profile cap", async () => {
    const profiles = Array.from({ length: 50 }, (_, index) => ({
      id: `p${index}`,
      label: `Server ${index}`,
      url: `https://server-${index}.example.com`,
      authMode: "device" as const,
      lastUsedAt: 1,
      lastWorkspaceID: null,
      lastSessionID: null,
      deviceID: `device-${index}`,
      expired: false,
    }))
    window.localStorage.setItem("masterhand.servers", JSON.stringify(profiles))
    window.localStorage.setItem("masterhand.servers.active", "p0")
    window.localStorage.setItem("masterhand.server.token.p0", "token-0")
    mocks.createServerClient.mockReturnValue(makeClient())

    render(<App />)
    expect(await screen.findByRole("button", { name: "New session" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Settings" }))
    fireEvent.click(screen.getByRole("button", { name: "Servers" }))
    fireEvent.click(screen.getByRole("button", { name: "Add server" }))
    fireEvent.change(screen.getByLabelText("Server URL"), {
      target: { value: "https://one-more.example.com" },
    })
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw" } })
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))

    expect(await screen.findByText("You can save at most 50 servers.")).toBeTruthy()
  })

  it("shows session-specific copy when a saved switch expires", async () => {
    const home = {
      id: "home",
      label: "Home",
      url: "https://host",
      authMode: "device",
      lastUsedAt: 1,
      lastWorkspaceID: null,
      lastSessionID: null,
      deviceID: "home-device",
      expired: false,
    }
    const studio = {
      ...home,
      id: "studio",
      label: "Studio",
      url: "https://studio.example.com",
      deviceID: "studio-device",
    }
    window.localStorage.setItem("masterhand.servers", JSON.stringify([home, studio]))
    window.localStorage.setItem("masterhand.servers.active", "home")
    window.localStorage.setItem("masterhand.server.token.home", "home-token")
    window.localStorage.setItem("masterhand.server.token.studio", "studio-token")
    mocks.createServerClient.mockImplementation((options: { baseUrl?: string }) => {
      const client = makeClient()
      if (options.baseUrl === "https://studio.example.com") {
        client.auth.status.mockRejectedValue(new ApiError(401, "expired"))
      }
      return client
    })

    render(<App />)
    expect(await screen.findByRole("button", { name: "New session" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Server: Home" }))
    fireEvent.click(screen.getByRole("button", { name: /^Studio/ }))

    expect(await screen.findByText("Reconnect to Studio")).toBeTruthy()
    expect(screen.getByText("The saved session expired. Enter the password again.")).toBeTruthy()
  })

  it("does not revoke a device still used by another saved profile", async () => {
    const home = {
      id: "home",
      label: "Home",
      url: "https://host",
      authMode: "device",
      lastUsedAt: 1,
      lastWorkspaceID: null,
      lastSessionID: null,
      deviceID: "shared-device",
      expired: false,
    }
    const studio = {
      ...home,
      id: "studio",
      label: "Studio",
      url: "https://studio.example.com",
    }
    window.localStorage.setItem("masterhand.servers", JSON.stringify([home, studio]))
    window.localStorage.setItem("masterhand.servers.active", "home")
    window.localStorage.setItem("masterhand.server.token.home", "home-token")
    window.localStorage.setItem("masterhand.server.token.studio", "studio-token")
    const client = makeClient()
    mocks.createServerClient.mockReturnValue(client)

    render(<App />)
    expect(await screen.findByRole("button", { name: "New session" })).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Settings" }))
    fireEvent.click(screen.getByRole("button", { name: "Servers" }))
    fireEvent.click(screen.getByRole("button", { name: "Remove Home" }))
    fireEvent.click(screen.getByRole("button", { name: "Remove" }))

    await waitFor(() => expect(screen.getByText("Add another server")).toBeTruthy())
    expect(client.auth.revokeDevice).not.toHaveBeenCalled()
  })

  it("clears a saved token and revokes the device when cancel lands after the save", async () => {
    let resolveStatus!: (value: { ok: boolean }) => void
    let calls = 0
    mocks.createServerClient.mockImplementation(() => {
      const index = calls++
      const client = makeClient()
      if (index === 0) {
        client.auth.status.mockRejectedValue(new ApiError(401, "unauthorized"))
      } else {
        client.auth.status.mockImplementation(
          () =>
            new Promise<{ ok: boolean }>((resolve) => {
              resolveStatus = resolve
            }),
        )
      }
      return client
    })

    render(<App />)
    expect(await screen.findByText("Connect your first server")).toBeTruthy()
    fireEvent.change(screen.getByLabelText("Server URL"), {
      target: { value: "https://remote.example" },
    })
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "Remote" } })
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw" } })
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))
    await waitFor(() => expect(tokenKeys()).toHaveLength(1))

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    await act(async () => {
      resolveStatus({ ok: true })
    })

    const revokeClient = mocks.createServerClient.mock.results.at(-1)?.value
    await waitFor(() => expect(revokeClient.auth.revokeDevice).toHaveBeenCalledWith("dev-1"))
    expect(tokenKeys()).toEqual([])
    expect(loadRegistry().profiles).toHaveLength(0)
  })
})
