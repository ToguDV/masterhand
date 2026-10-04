/**
 * Integration tests for the authenticated half of `App.tsx`.
 *
 * `App` is driven through the real component tree: the data hooks from
 * `@masterhand/client-core` are stubbed so a test can hand it workspaces,
 * sessions and directories, and knows exactly which client methods the screens
 * call. The event-stream hook is stubbed too, which lets a test replay opencode
 * events against the real `createEventHandler`.
 */
import { Alert, AppState } from "react-native"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react-native"
import {
  ApiError,
  createClient,
  useEventStream,
  useMessages,
  useSessionDirectories,
  useSessions,
  useSessionStatuses,
  useWorkspaces,
  type ChatMessage,
  type FormInfo,
  type Permission,
  type Session,
  type WorkspaceRecord,
} from "@masterhand/client-core"
import App, { queryClient } from "../App"
import * as storageModule from "../src/storage"

jest.mock("../src/storage", () => ({
  loadServerUrl: jest.fn(async () => null),
  loadToken: jest.fn(async () => null),
  loadDevice: jest.fn(async () => null),
  loadWorkspaceID: jest.fn(async () => null),
  loadAutoAcceptSessions: jest.fn(async () => []),
  loadSessionPreferences: jest.fn(async () => ({})),
  saveServerUrl: jest.fn(async () => {}),
  saveToken: jest.fn(async () => {}),
  saveDevice: jest.fn(async () => {}),
  saveWorkspaceID: jest.fn(async () => {}),
  saveAutoAcceptSessions: jest.fn(async () => {}),
  saveSessionPreferences: jest.fn(async () => {}),
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
    // The chat/composer hooks are stubbed too: this suite only exercises App,
    // and leaving real `useQuery`s alive would keep gc/intervals open.
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
const directoriesMock = useSessionDirectories as unknown as jest.Mock
const statusesMock = useSessionStatuses as unknown as jest.Mock
const messagesMock = useMessages as unknown as jest.Mock

interface MockedStorage {
  loadServerUrl: jest.Mock
  loadToken: jest.Mock
  loadDevice: jest.Mock
  loadWorkspaceID: jest.Mock
  loadAutoAcceptSessions: jest.Mock
  loadSessionPreferences: jest.Mock
  saveServerUrl: jest.Mock
  saveToken: jest.Mock
  saveDevice: jest.Mock
  saveWorkspaceID: jest.Mock
  saveAutoAcceptSessions: jest.Mock
  saveSessionPreferences: jest.Mock
  clearToken: jest.Mock
  clearDevice: jest.Mock
  clearWorkspaceID: jest.Mock
}

const storage = storageModule as unknown as MockedStorage

const workspace: WorkspaceRecord = { id: "ws1", name: "demo", path: "/workspaces/demo", createdAt: 0 }
const otherWorkspace: WorkspaceRecord = { id: "ws2", name: "other", path: "/workspaces/other", createdAt: 0 }

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "ses_1",
    title: "My session",
    projectID: "proj",
    cost: 0,
    tokens: {},
    time: { created: 0, updated: 0 },
    location: { directory: "/workspaces/demo" },
    ...overrides,
  } as unknown as Session
}

const permission: Permission = { id: "perm_1", sessionID: "ses_1", action: "bash", resources: ["ls"] }

const questionForm: FormInfo = {
  id: "frm_1",
  sessionID: "ses_1",
  title: "Questions",
  metadata: { kind: "question", tool: { messageID: "msg_1", id: "call_q" } } as FormInfo["metadata"],
  fields: [
    { key: "q0", type: "string", title: "Color", options: [{ label: "Red", value: "Red" }] },
  ] as FormInfo["fields"],
}

function questionMessage(): ChatMessage {
  return {
    info: { id: "msg_1", sessionID: "ses_1", role: "assistant", time: { created: 1, completed: 2 } },
    parts: [
      {
        id: "call_q",
        sessionID: "ses_1",
        messageID: "msg_1",
        type: "tool",
        tool: "question",
        callID: "call_q",
        state: { status: "running", input: {} },
      },
    ],
  }
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
      permissions: jest.fn(async (): Promise<Permission[]> => []),
      respondPermission: jest.fn(async () => {}),
      pendingForms: jest.fn(async () => []),
      forms: jest.fn(async () => []),
      form: jest.fn(async () => ({})),
      respondForm: jest.fn(async () => {}),
      cancelForm: jest.fn(async () => {}),
      sessions: {
        create: jest.fn(async () => makeSession({ id: "ses_new", title: "New" })),
        remove: jest.fn(async () => {}),
        finish: jest.fn(async () => ({
          committed: true,
          pushed: false,
          prUrl: null,
          branch: "b",
          path: "/worktree",
          error: null,
        })),
      },
    },
    workspaces: {
      create: jest.fn(async (input: { name: string }) => ({
        id: "ws_new",
        name: input.name,
        path: `/workspaces/${input.name}`,
        createdAt: 0,
      })),
      remove: jest.fn(async () => {}),
    },
  }
}

let client: ReturnType<typeof makeClient>
let appStateHandler: ((state: string) => void) | undefined

beforeEach(() => {
  jest.clearAllMocks()
  // jest-expo's AppState mock returns `undefined` from `addEventListener`,
  // which crashes App's effect cleanup (`subscription.remove()`). Provide a
  // real subscription and capture the listener for the foreground test.
  appStateHandler = undefined
  jest.spyOn(AppState, "addEventListener").mockImplementation((_type, listener) => {
    appStateHandler = listener as (state: string) => void
    return { remove: jest.fn() } as never
  })
  storage.loadServerUrl.mockResolvedValue(null)
  storage.loadToken.mockResolvedValue(null)
  storage.loadDevice.mockResolvedValue(null)
  storage.loadWorkspaceID.mockResolvedValue(null)
  storage.loadAutoAcceptSessions.mockResolvedValue([])
  storage.loadSessionPreferences.mockResolvedValue({})
  workspacesMock.mockReturnValue({ data: [], isLoading: false })
  sessionsMock.mockReturnValue({ data: [], isLoading: false })
  directoriesMock.mockReturnValue({ data: [], isLoading: false })
  statusesMock.mockReturnValue({ data: {} })
  messagesMock.mockReturnValue({ data: [], isLoading: false })
  eventStreamMock.mockImplementation(() => jest.fn())
  client = makeClient()
  createClientMock.mockReturnValue(client)
})

afterEach(() => {
  // Unmount first, then drop the shared cache: event-handler tests write to it
  // (`setQueryData`) and an unobserved entry schedules a 5-minute gc timer that
  // would keep Jest alive.
  cleanup()
  queryClient.clear()
  jest.restoreAllMocks()
})

async function renderAuthenticated(options: {
  workspaces?: WorkspaceRecord[]
  sessions?: Session[]
  directories?: string[]
  autoAccept?: string[]
  workspaceID?: string | null
  messages?: ChatMessage[]
} = {}) {
  storage.loadToken.mockResolvedValue("stored-token")
  storage.loadServerUrl.mockResolvedValue("https://host")
  storage.loadWorkspaceID.mockResolvedValue(
    options.workspaceID === undefined ? workspace.id : options.workspaceID,
  )
  storage.loadAutoAcceptSessions.mockResolvedValue(options.autoAccept ?? [])
  workspacesMock.mockReturnValue({ data: options.workspaces ?? [workspace], isLoading: false })
  sessionsMock.mockReturnValue({ data: options.sessions ?? [], isLoading: false })
  directoriesMock.mockReturnValue({ data: options.directories ?? [], isLoading: false })
  messagesMock.mockReturnValue({ data: options.messages ?? [], isLoading: false })

  await render(<App />)
  await screen.findByText("Sessions")
}

/** The options object `AuthenticatedApp` handed to the stubbed event stream. */
function streamOptions(): {
  onEvent: (event: unknown) => void
  onConnectionChange?: (connected: boolean) => void
  onConnect?: () => void
} {
  return eventStreamMock.mock.calls.at(-1)?.[1]
}

describe("App — login errors", () => {
  async function submit(loginDevice: jest.Mock): Promise<void> {
    client = makeClient()
    client.auth.loginDevice = loginDevice
    createClientMock.mockReturnValue(client)
    await render(<App />)
    await fireEvent.changeText(
      await screen.findByPlaceholderText("https://masterhand.example.com"),
      "https://host",
    )
    await fireEvent.changeText(screen.getByPlaceholderText("••••••••"), "pw")
    await fireEvent.press(screen.getByText("Sign in"))
  }

  it.each([
    [429, "Too many attempts; wait 15 minutes"],
    [400, "Check the server URL and password"],
    [500, "Error 500"],
  ])("maps a %i response to its message", async (status, message) => {
    await submit(jest.fn(async () => Promise.reject(new ApiError(status, "x"))))

    expect(await screen.findByText(message)).toBeOnTheScreen()
  })

  it("reports an unreachable server for non-HTTP failures", async () => {
    await submit(jest.fn(async () => Promise.reject(new Error("network down"))))

    expect(await screen.findByText("Could not reach the server")).toBeOnTheScreen()
  })

  it("normalizes the server URL before saving it", async () => {
    client = makeClient()
    createClientMock.mockReturnValue(client)
    await render(<App />)

    await fireEvent.changeText(
      await screen.findByPlaceholderText("https://masterhand.example.com"),
      "https://host/",
    )
    await fireEvent.changeText(screen.getByPlaceholderText("••••••••"), "pw")
    await fireEvent.press(screen.getByText("Sign in"))

    await waitFor(() => expect(storage.saveServerUrl).toHaveBeenCalledWith("https://host"))
    expect(await screen.findByText("Sessions")).toBeOnTheScreen()
  })

  it("clears the token when the server rejects it mid-session", async () => {
    await renderAuthenticated()

    const options = createClientMock.mock.calls
      .map((call) => call[0] as { onUnauthorized?: () => void })
      .find((value) => value.onUnauthorized)
    await act(async () => {
      options?.onUnauthorized?.()
    })

    expect(storage.clearToken).toHaveBeenCalled()
    expect(await screen.findByText("Your opencode agents, from anywhere.")).toBeOnTheScreen()
  })
})

describe("App — sessions", () => {
  it("creates a standard session from the header", async () => {
    await renderAuthenticated()

    await fireEvent.press(await screen.findByText("+ New"))

    expect(client.api.sessions.create).toHaveBeenCalledWith("ws1", { isolated: false })
  })

  it("creates an isolated session when the toggle is on", async () => {
    await renderAuthenticated()

    await fireEvent.press(screen.getAllByText("Isolated")[1]!)
    await fireEvent.press(screen.getByText("+ New"))

    expect(client.api.sessions.create).toHaveBeenCalledWith("ws1", { isolated: true })
  })

  it("banners a failed session creation", async () => {
    client = makeClient()
    client.api.sessions.create.mockRejectedValue(new Error("nope"))
    createClientMock.mockReturnValue(client)
    await renderAuthenticated()

    await fireEvent.press(await screen.findByText("+ New"))

    expect(await screen.findByText("Could not create the session")).toBeOnTheScreen()
  })

  it("opens a session and deletes it after confirmation", async () => {
    const session = makeSession()
    await renderAuthenticated({ sessions: [session] })
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {})

    await fireEvent.press(screen.getAllByLabelText("Delete session")[0]!)
    const buttons = alert.mock.calls[0]?.[2]
    buttons?.find((button) => button.style === "destructive")?.onPress?.()

    await waitFor(() => expect(client.api.sessions.remove).toHaveBeenCalledWith("ws1", "ses_1"))
    alert.mockRestore()
  })

  it("banners a failed deletion", async () => {
    client = makeClient()
    client.api.sessions.remove.mockRejectedValue(new Error("nope"))
    createClientMock.mockReturnValue(client)
    await renderAuthenticated({ sessions: [makeSession()] })
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {})

    await fireEvent.press(screen.getAllByLabelText("Delete session")[0]!)
    alert.mock.calls[0]?.[2]?.find((button) => button.style === "destructive")?.onPress?.()

    expect(await screen.findByText("Could not delete the session")).toBeOnTheScreen()
    alert.mockRestore()
  })
})

describe("App — workspaces", () => {
  it("selects another workspace from the sheet", async () => {
    await renderAuthenticated({ workspaces: [workspace, otherWorkspace] })

    await fireEvent.press(screen.getByText("Workspace"))
    await fireEvent.press(screen.getByText("other"))

    expect(storage.saveWorkspaceID).toHaveBeenCalledWith("ws2")
  })

  it("adds a workspace and selects it", async () => {
    await renderAuthenticated()

    await fireEvent.press(screen.getByText("Workspace"))
    await fireEvent.press(screen.getByText("Add workspace"))
    await fireEvent.changeText(screen.getByPlaceholderText("my-project"), "fresh")
    await fireEvent.press(screen.getByText("Add"))

    await waitFor(() => expect(client.workspaces.create).toHaveBeenCalledWith({ name: "fresh" }))
    expect(storage.saveWorkspaceID).toHaveBeenCalledWith("ws_new")
  })

  it("removes the selected workspace after confirmation", async () => {
    await renderAuthenticated()
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {})

    await fireEvent.press(screen.getByText("Workspace"))
    await fireEvent.press(screen.getByText("Remove workspace"))
    alert.mock.calls[0]?.[2]?.find((button) => button.style === "destructive")?.onPress?.()

    await waitFor(() => expect(client.workspaces.remove).toHaveBeenCalledWith("ws1", { deleteFiles: false }))
    expect(storage.clearWorkspaceID).toHaveBeenCalled()
    alert.mockRestore()
  })

  it("banners a failed workspace removal", async () => {
    client = makeClient()
    client.workspaces.remove.mockRejectedValue(new Error("nope"))
    createClientMock.mockReturnValue(client)
    await renderAuthenticated()
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {})

    await fireEvent.press(screen.getByText("Workspace"))
    await fireEvent.press(screen.getByText("Remove workspace"))
    alert.mock.calls[0]?.[2]?.find((button) => button.style === "destructive")?.onPress?.()

    expect(await screen.findByText("Could not remove the workspace")).toBeOnTheScreen()
    alert.mockRestore()
  })
})

describe("App — permissions and events", () => {
  it("shows a permission asked over the stream and answers it", async () => {
    await renderAuthenticated()

    await act(async () => {
      streamOptions().onEvent({ type: "permission.asked", data: permission })
    })

    expect(await screen.findByText("Permission required")).toBeOnTheScreen()
    await fireEvent.press(screen.getByText("Once"))

    await waitFor(() =>
      expect(client.api.respondPermission).toHaveBeenCalledWith("ses_1", "perm_1", "once"),
    )
    await waitFor(() => expect(screen.queryByText("Permission required")).toBeNull())
  })

  it("drops a permission when the server replies elsewhere", async () => {
    await renderAuthenticated()

    await act(async () => {
      streamOptions().onEvent({ type: "permission.asked", data: permission })
    })
    expect(await screen.findByText("Permission required")).toBeOnTheScreen()

    await act(async () => {
      streamOptions().onEvent({ type: "permission.replied", data: { requestID: "perm_1" } })
    })
    await waitFor(() => expect(screen.queryByText("Permission required")).toBeNull())
  })

  it("banners a failed permission answer", async () => {
    client = makeClient()
    client.api.respondPermission.mockRejectedValue(new Error("nope"))
    createClientMock.mockReturnValue(client)
    await renderAuthenticated()

    await act(async () => {
      streamOptions().onEvent({ type: "permission.asked", data: permission })
    })
    await fireEvent.press(await screen.findByText("Once"))

    expect(await screen.findByText("Could not answer the permission request")).toBeOnTheScreen()
  })

  it("surfaces a structured session error as a banner", async () => {
    await renderAuthenticated()

    await act(async () => {
      streamOptions().onEvent({
        type: "session.execution.failed",
        data: { sessionID: "ses_1", error: { type: "Unknown", message: "boom\nstack trace" } },
      })
    })

    expect(await screen.findByText("boom")).toBeOnTheScreen()
  })

  it("reconciles permissions on (re)connect", async () => {
    client = makeClient()
    client.api.permissions.mockResolvedValue([permission])
    createClientMock.mockReturnValue(client)
    await renderAuthenticated({ directories: ["/workspaces/demo"], sessions: [makeSession()] })

    await act(async () => {
      streamOptions().onEvent({ type: "server.connected" })
    })

    expect(await screen.findByText("Permission required")).toBeOnTheScreen()
    expect(client.api.permissions).toHaveBeenCalledWith("/workspaces/demo")
  })

  it("auto-accepts a permission for a session with that setting", async () => {
    client = makeClient()
    client.api.permissions.mockResolvedValue([permission])
    createClientMock.mockReturnValue(client)
    await renderAuthenticated({
      autoAccept: ["ses_1"],
      directories: ["/workspaces/demo"],
      sessions: [makeSession()],
    })

    await waitFor(() =>
      expect(client.api.respondPermission).toHaveBeenCalledWith("ses_1", "perm_1", "once"),
    )
  })

  it("banners when auto-accept cannot answer", async () => {
    client = makeClient()
    client.api.permissions.mockResolvedValue([permission])
    client.api.respondPermission.mockRejectedValue(new Error("nope"))
    createClientMock.mockReturnValue(client)
    await renderAuthenticated({
      autoAccept: ["ses_1"],
      directories: ["/workspaces/demo"],
      sessions: [makeSession()],
    })

    expect(await screen.findByText("Could not answer the permission request")).toBeOnTheScreen()
  })

  it("shows an inline question from the stream and answers it", async () => {
    await renderAuthenticated({ sessions: [makeSession()], messages: [questionMessage()] })
    await fireEvent.press(screen.getByText("My session"))

    await act(async () => {
      streamOptions().onEvent({ type: "form.created", data: { form: questionForm } })
    })

    expect(await screen.findByTestId("question-card")).toBeOnTheScreen()
    await fireEvent.press(screen.getByText("Red"))
    await fireEvent.press(screen.getByText("Submit"))

    await waitFor(() => expect(client.api.respondForm).toHaveBeenCalledWith("ses_1", "frm_1", { q0: "Red" }))
    expect(await screen.findByTestId("question-answered")).toBeOnTheScreen()
  })

  it("dismisses a question and prunes it when answered elsewhere", async () => {
    await renderAuthenticated({ sessions: [makeSession()], messages: [questionMessage()] })
    await fireEvent.press(screen.getByText("My session"))

    await act(async () => {
      streamOptions().onEvent({ type: "form.created", data: { form: questionForm } })
    })
    expect(await screen.findByTestId("question-card")).toBeOnTheScreen()

    await fireEvent.press(screen.getByText("Dismiss"))
    await waitFor(() => expect(client.api.cancelForm).toHaveBeenCalledWith("ses_1", "frm_1"))
    await waitFor(() => expect(screen.queryByTestId("question-card")).toBeNull())

    await act(async () => {
      streamOptions().onEvent({ type: "form.created", data: { form: questionForm } })
    })
    expect(await screen.findByTestId("question-card")).toBeOnTheScreen()
    await act(async () => {
      streamOptions().onEvent({ type: "form.replied", data: { id: "frm_1" } })
    })
    await waitFor(() => expect(screen.queryByTestId("question-card")).toBeNull())
  })

  it("banners a failed question answer", async () => {
    client = makeClient()
    client.api.respondForm.mockRejectedValue(new Error("nope"))
    createClientMock.mockReturnValue(client)
    await renderAuthenticated({ sessions: [makeSession()], messages: [questionMessage()] })
    await fireEvent.press(screen.getByText("My session"))

    await act(async () => {
      streamOptions().onEvent({ type: "form.created", data: { form: questionForm } })
    })
    await fireEvent.press(await screen.findByText("Red"))
    await fireEvent.press(screen.getByText("Submit"))

    expect(await screen.findByText(/Could not answer the question/)).toBeOnTheScreen()
  })

  it("surfaces a question raised in another session", async () => {
    const other = makeSession({ id: "ses_2", title: "Other session" })
    await renderAuthenticated({ sessions: [makeSession(), other], messages: [questionMessage()] })
    await fireEvent.press(screen.getByText("My session"))

    await act(async () => {
      streamOptions().onEvent({
        type: "form.created",
        data: { form: { ...questionForm, sessionID: "ses_2" } },
      })
    })

    const jump = await screen.findByText(/waiting for your answer/)
    await fireEvent.press(jump)
    expect(await screen.findByText("Other session")).toBeOnTheScreen()
  })
})

describe("App — foreground recovery", () => {
  it("reconnects when the app becomes active", async () => {
    await renderAuthenticated()
    const forceReconnect = eventStreamMock.mock.results.at(-1)?.value as jest.Mock

    appStateHandler?.("background")
    expect(forceReconnect).not.toHaveBeenCalled()

    appStateHandler?.("active")
    expect(forceReconnect).toHaveBeenCalled()
  })

  it("reconciles on the stream's connect callback", async () => {
    client = makeClient()
    client.api.permissions.mockResolvedValue([permission])
    createClientMock.mockReturnValue(client)
    await renderAuthenticated({ directories: ["/workspaces/demo"], sessions: [makeSession()] })

    act(() => {
      streamOptions().onConnect?.()
    })

    await waitFor(() => expect(client.api.permissions).toHaveBeenCalledWith("/workspaces/demo"))
    expect(await screen.findByText("Permission required")).toBeOnTheScreen()
  })
})
