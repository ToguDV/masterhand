import { AppState } from "react-native"
import { act, cleanup, render, screen, waitFor } from "@testing-library/react-native"
import {
  createClient,
  useEventStream,
  useMessages,
  useSessionDirectories,
  useSessions,
  useSessionStatuses,
  useWorkspaces,
  type Session,
  type WorkspaceRecord,
} from "@masterhand/client-core"
import * as SystemNotifications from "expo-notifications"
import App from "../App"
import * as storageModule from "../src/storage"

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
  saveSessionPreferences: jest.fn(async () => ({})),
  saveTheme: jest.fn(async () => {}),
  clearTheme: jest.fn(async () => {}),
  loadNotificationsEnabled: jest.fn(async () => true),
  saveNotificationsEnabled: jest.fn(async () => {}),
  loadBusySnapshot: jest.fn(async () => ({})),
  saveBusySnapshot: jest.fn(async () => {}),
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
    useMessages: jest.fn(() => ({ data: [], isLoading: false })),
    useAgents: jest.fn(() => ({ data: [] })),
    useModels: jest.fn(() => ({ data: { models: [], providers: [], defaultModel: null } })),
  }
})

const createClientMock = createClient as unknown as jest.Mock
const eventStreamMock = useEventStream as unknown as jest.Mock
const workspacesMock = useWorkspaces as unknown as jest.Mock
const sessionsMock = useSessions as unknown as jest.Mock
const scheduleMock = SystemNotifications.scheduleNotificationAsync as unknown as jest.Mock

const storage = storageModule as unknown as {
  loadServerRegistry: jest.Mock
  loadServerToken: jest.Mock
  loadNotificationsEnabled: jest.Mock
}

const workspace: WorkspaceRecord = { id: "ws1", name: "demo", path: "/workspaces/demo", createdAt: 0 }

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "ses_1",
    title: "Demo session",
    projectID: "proj",
    cost: 0,
    tokens: {},
    time: { created: 0, updated: 0 },
    location: { directory: "/workspaces/demo" },
    ...overrides,
  } as unknown as Session
}

function makeClient() {
  return {
    auth: {
      status: jest.fn(async () => ({ ok: true })),
      loginDevice: jest.fn(async () => ({
        token: "tok",
        device: { id: "d1", name: "Android device", createdAt: 0, lastUsedAt: 0 },
      })),
      revokeDevice: jest.fn(async () => {}),
    },
    api: {
      agents: jest.fn(async () => []),
      models: jest.fn(async () => ({ models: [], providers: [], defaultModel: null })),
      messages: jest.fn(async () => []),
      prompt: jest.fn(async () => {}),
      abortSession: jest.fn(async () => {}),
      permissions: jest.fn(async () => []),
      respondPermission: jest.fn(async () => {}),
      pendingForms: jest.fn(async () => []),
      forms: jest.fn(async () => []),
      respondForm: jest.fn(async () => {}),
      cancelForm: jest.fn(async () => {}),
      sessions: {
        create: jest.fn(async () => makeSession()),
        remove: jest.fn(async () => {}),
        finish: jest.fn(async () => ({})),
      },
    },
    workspaces: {
      create: jest.fn(),
      remove: jest.fn(async () => {}),
    },
  }
}

function streamOptions(): { onEvent: (event: unknown) => void } {
  return eventStreamMock.mock.calls.at(-1)?.[1]
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.spyOn(AppState, "addEventListener").mockImplementation(() => ({ remove: jest.fn() }) as never)
  ;(AppState as { currentState?: string }).currentState = "active"
  storage.loadServerRegistry.mockResolvedValue({ profiles: [], activeID: null })
  storage.loadServerToken.mockResolvedValue(null)
  storage.loadNotificationsEnabled.mockResolvedValue(true)
  workspacesMock.mockReturnValue({ data: [workspace], isLoading: false })
  sessionsMock.mockReturnValue({ data: [makeSession()], isLoading: false })
  ;(useSessionStatuses as unknown as jest.Mock).mockReturnValue({ data: {} })
  ;(useSessionDirectories as unknown as jest.Mock).mockReturnValue({ data: [], isLoading: false })
  ;(useMessages as unknown as jest.Mock).mockReturnValue({ data: [], isLoading: false })
  eventStreamMock.mockImplementation(() => jest.fn())
  createClientMock.mockReturnValue(makeClient())
})

afterEach(() => {
  cleanup()
  jest.restoreAllMocks()
})

async function renderAuthenticated() {
  const profile = {
    id: "home",
    label: "Home",
    url: "https://host",
    device: { id: "d1", name: "Pixel" },
    lastWorkspaceID: workspace.id,
    lastSessionID: null,
    expired: false,
    lastUsedAt: 1,
  }
  storage.loadServerRegistry.mockResolvedValue({ profiles: [profile], activeID: "home" })
  storage.loadServerToken.mockResolvedValue("stored-token")
  await render(<App />)
  await screen.findByLabelText("Show sessions")
}

describe("App — local agent notifications", () => {
  it("stays silent in the foreground", async () => {
    await renderAuthenticated()
    ;(AppState as { currentState?: string }).currentState = "active"
    await act(async () => {
      streamOptions().onEvent({ type: "session.execution.started", data: { sessionID: "ses_1" } })
    })
    await act(async () => {
      streamOptions().onEvent({ type: "session.idle", data: { sessionID: "ses_1" } })
    })
    expect(scheduleMock).not.toHaveBeenCalled()
  })

  it("buzzes when a busy session finishes in the background", async () => {
    await renderAuthenticated()
    await act(async () => {
      streamOptions().onEvent({ type: "session.execution.started", data: { sessionID: "ses_1" } })
    })
    ;(AppState as { currentState?: string }).currentState = "background"
    await act(async () => {
      streamOptions().onEvent({ type: "session.idle", data: { sessionID: "ses_1" } })
    })
    expect(scheduleMock).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({
          title: "Agent finished",
          data: expect.objectContaining({ sessionID: "ses_1", kind: "finished" }),
        }),
      }),
    )
  })

  it("buzzes for permission requests in the background", async () => {
    await renderAuthenticated()
    ;(AppState as { currentState?: string }).currentState = "background"
    await act(async () => {
      streamOptions().onEvent({
        type: "permission.asked",
        data: { id: "perm_1", sessionID: "ses_1", action: "bash", resources: ["ls"] },
      })
    })
    expect(scheduleMock).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({
          data: expect.objectContaining({ sessionID: "ses_1", kind: "permission" }),
        }),
      }),
    )
  })

  it("opens the session when its notification is tapped", async () => {
    const addListener = SystemNotifications.addNotificationResponseReceivedListener as unknown as jest.Mock
    await renderAuthenticated()
    expect(addListener).toHaveBeenCalled()
    const tap = addListener.mock.calls[0]?.[0] as (response: {
      notification: { request: { content: { data: unknown } } }
    }) => void
    await act(async () => {
      tap({
        notification: {
          request: {
            content: { data: { profileID: "home", sessionID: "ses_1", kind: "finished", workspaceID: "ws1" } },
          },
        },
      })
    })
    // The chat takes over once the tapped session opens.
    expect(await screen.findByText("Demo session")).toBeOnTheScreen()
  })

  it("re-notifies a permission after the server reply clears the dedup", async () => {
    await renderAuthenticated()
    ;(AppState as { currentState?: string }).currentState = "background"
    const asked = {
      type: "permission.asked",
      data: { id: "perm_9", sessionID: "ses_1", action: "bash", resources: ["ls"] },
    }
    await act(async () => {
      streamOptions().onEvent(asked)
    })
    await act(async () => {
      streamOptions().onEvent({ type: "permission.replied", data: { requestID: "perm_9" } })
    })
    const before = scheduleMock.mock.calls.length
    await act(async () => {
      streamOptions().onEvent(asked)
    })
    expect(scheduleMock.mock.calls.length).toBeGreaterThan(before)
  })

  it("buzzes when a run fails in the background", async () => {
    await renderAuthenticated()
    ;(AppState as { currentState?: string }).currentState = "background"
    await act(async () => {
      streamOptions().onEvent({
        type: "session.execution.failed",
        data: { sessionID: "ses_1", error: { message: "boom" } },
      })
    })
    expect(scheduleMock).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({
          title: "Agent failed",
          data: expect.objectContaining({ sessionID: "ses_1", kind: "failed" }),
        }),
      }),
    )
  })

  it("tracks status events as busy for the later idle", async () => {
    await renderAuthenticated()
    await act(async () => {
      streamOptions().onEvent({
        type: "session.status",
        data: { sessionID: "ses_1", status: { type: "busy" } },
      })
    })
    ;(AppState as { currentState?: string }).currentState = "background"
    await act(async () => {
      streamOptions().onEvent({ type: "session.execution.succeeded", data: { sessionID: "ses_1" } })
    })
    expect(scheduleMock).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({
          data: expect.objectContaining({ sessionID: "ses_1", kind: "finished" }),
        }),
      }),
    )
  })

  it("ignores malformed and interrupted events", async () => {
    await renderAuthenticated()
    ;(AppState as { currentState?: string }).currentState = "background"
    const before = scheduleMock.mock.calls.length
    await act(async () => {
      streamOptions().onEvent({ type: "", data: {} })
      streamOptions().onEvent({ data: {} })
      streamOptions().onEvent({
        type: "session.status",
        data: { sessionID: "ses_1", status: { type: "idle" } },
      })
      streamOptions().onEvent({ type: "session.execution.interrupted", data: { sessionID: "ses_1" } })
      streamOptions().onEvent({ type: "unknown.event", data: { sessionID: "ses_1" } })
    })
    expect(scheduleMock.mock.calls.length).toBe(before)
  })

  it("opens the session from a cold-start notification tap", async () => {
    const lastResponse = SystemNotifications.getLastNotificationResponseAsync as unknown as jest.Mock
    lastResponse.mockResolvedValueOnce({
      notification: {
        request: {
          content: { data: { profileID: "home", sessionID: "ses_1", kind: "finished", workspaceID: "ws1" } },
        },
      },
    })
    const profile = {
      id: "home",
      label: "Home",
      url: "https://host",
      device: { id: "d1", name: "Pixel" },
      lastWorkspaceID: workspace.id,
      lastSessionID: null,
      expired: false,
      lastUsedAt: 1,
    }
    storage.loadServerRegistry.mockResolvedValue({ profiles: [profile], activeID: "home" })
    storage.loadServerToken.mockResolvedValue("stored-token")
    await render(<App />)
    // Cold-start tap opens the chat directly instead of the session list.
    expect(await screen.findByText("Demo session")).toBeOnTheScreen()
  })

  it("switches servers when the tapped notification belongs elsewhere", async () => {
    const home = {
      id: "home",
      label: "Home",
      url: "https://host",
      device: { id: "d1", name: "Pixel" },
      lastWorkspaceID: workspace.id,
      lastSessionID: null,
      expired: false,
      lastUsedAt: 1,
    }
    const work = {
      id: "work",
      label: "Work",
      url: "https://work.example.com",
      device: { id: "d2", name: "Pixel" },
      lastWorkspaceID: null,
      lastSessionID: null,
      expired: false,
      lastUsedAt: 2,
    }
    storage.loadServerRegistry.mockResolvedValue({ profiles: [home, work], activeID: "home" })
    storage.loadServerToken.mockResolvedValue("stored-token")
    const { saveServerRegistry } = storageModule as unknown as { saveServerRegistry: jest.Mock }
    await render(<App />)
    await screen.findByLabelText("Show sessions")
    const addListener = SystemNotifications.addNotificationResponseReceivedListener as unknown as jest.Mock
    const tap = addListener.mock.calls[0]?.[0] as (response: {
      notification: { request: { content: { data: unknown } } }
    }) => void
    await act(async () => {
      tap({
        notification: {
          request: { content: { data: { profileID: "work", sessionID: "ses_9", kind: "finished" } } },
        },
      })
    })
    await waitFor(() =>
      expect(saveServerRegistry).toHaveBeenCalledWith(
        expect.objectContaining({ activeID: "work" }),
      ),
    )
  })
})
