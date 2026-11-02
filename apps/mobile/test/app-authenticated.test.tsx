/**
 * Integration tests for the authenticated half of `App.tsx`.
 *
 * `App` is driven through the real component tree: the data hooks from
 * `@masterhand/client-core` are stubbed so a test can hand it workspaces,
 * sessions and workspaces, and knows exactly which client methods the screens
 * call. The event-stream hook is stubbed too, which lets a test replay opencode
 * events against the real `createEventHandler`.
 */
import { Alert, AppState } from "react-native"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react-native"
import {
  ApiError,
  createClient,
  useBoard,
  useEventStream,
  useMessages,
  useSessions,
  useSessionStatuses,
  useWorkspaces,
  type ChatMessage,
  type FormInfo,
  type Permission,
  type Session,
  type WorkspaceRecord,
} from "@masterhand/client-core"
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
  loadNotificationsEnabled: jest.fn(async () => false),
  saveNotificationsEnabled: jest.fn(async () => {}),
  loadAgentActivityPreferences: jest.fn(async () => ({
    finished: true,
    failed: true,
    permission: true,
    question: true,
  })),
  saveAgentActivityPreferences: jest.fn(async () => {}),
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
    // The chat/composer hooks are stubbed too: this suite only exercises App,
    // and leaving real `useQuery`s alive would keep gc/intervals open.
    useBffStatus: jest.fn(() => ({ data: undefined })),
    useMessages: jest.fn(() => ({ data: [], isLoading: false })),
    useAgents: jest.fn(() => ({ data: [] })),
    useModels: jest.fn(() => ({ data: { models: [], providers: [], defaultModel: null } })),
    // The board section only needs a snapshot per workspace: this suite tests
    // navigation, not the kanban mutations.
    useBoard: jest.fn((_client: unknown, workspaceID?: string | null) => ({
      data: workspaceID ? { workspaceID, columns: [] } : null,
      isPending: false,
      isError: false,
    })),
  }
})

const createClientMock = createClient as unknown as jest.Mock
const eventStreamMock = useEventStream as unknown as jest.Mock
const workspacesMock = useWorkspaces as unknown as jest.Mock
const sessionsMock = useSessions as unknown as jest.Mock
const statusesMock = useSessionStatuses as unknown as jest.Mock
const messagesMock = useMessages as unknown as jest.Mock
const boardMock = useBoard as unknown as jest.Mock

interface MockedStorage {
  loadServerRegistry: jest.Mock
  loadServerToken: jest.Mock
  saveServerRegistry: jest.Mock
  saveServerToken: jest.Mock
  clearServerToken: jest.Mock
  getOrCreateInstallID: jest.Mock
  newServerID: jest.Mock
  loadAutoAcceptSessionsFor: jest.Mock
  saveAutoAcceptSessionsFor: jest.Mock
  loadSessionPreferences: jest.Mock
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
  storage.loadServerRegistry.mockResolvedValue({ profiles: [], activeID: null })
  storage.loadServerToken.mockResolvedValue(null)
  storage.loadAutoAcceptSessionsFor.mockResolvedValue([])
  storage.loadSessionPreferences.mockResolvedValue({})
  workspacesMock.mockReturnValue({ data: [], isLoading: false })
  sessionsMock.mockReturnValue({ data: [], isLoading: false })
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
  jest.restoreAllMocks()
})

async function renderAuthenticated(options: {
  workspaces?: WorkspaceRecord[]
  sessions?: Session[]
  /** Sessions of the second workspace: a switch must load a different list. */
  otherWorkspaceSessions?: Session[]
  autoAccept?: string[]
  workspaceID?: string | null
  messages?: ChatMessage[]
} = {}) {
  const profile = {
    id: "home",
    label: "Home",
    url: "https://host",
    device: { id: "d1", name: "Pixel" },
    lastWorkspaceID: options.workspaceID === undefined ? workspace.id : options.workspaceID,
    lastSessionID: null,
    expired: false,
    lastUsedAt: 1,
  }
  storage.loadServerRegistry.mockResolvedValue({ profiles: [profile], activeID: "home" })
  storage.loadServerToken.mockResolvedValue("stored-token")
  storage.loadAutoAcceptSessionsFor.mockResolvedValue(options.autoAccept ?? [])
  workspacesMock.mockReturnValue({ data: options.workspaces ?? [workspace], isLoading: false })
  // Keyed by workspace like the real hook, with stable array identities: a new
  // reference on every render would re-trigger the list-driven effects.
  const firstSessions = options.sessions ?? []
  const otherSessions = options.otherWorkspaceSessions ?? []
  sessionsMock.mockImplementation(
    (_client: unknown, _live: unknown, _poll: unknown, workspaceIDArg?: string | null) => ({
      data: workspaceIDArg === "ws2" ? otherSessions : firstSessions,
      isLoading: false,
      isSuccess: true,
    }),
  )
  messagesMock.mockReturnValue({ data: options.messages ?? [], isLoading: false })

  await render(<App />)
  await screen.findByLabelText("Show sessions")
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
    await fireEvent.changeText(await screen.findByTestId("server-url-input"), "https://host")
    await fireEvent.changeText(screen.getByTestId("password-input"), "pw")
    await fireEvent.press(screen.getByTestId("connect-button"))
  }

  it.each([
    [429, "Too many attempts; wait 15 minutes."],
    [400, "Check the server URL and password."],
    [500, "The server answered with error 500."],
  ])("maps a %i response to its message", async (status, message) => {
    await submit(jest.fn(async () => Promise.reject(new ApiError(status, "x"))))

    expect(await screen.findByText(message)).toBeOnTheScreen()
  })

  it("reports an unreachable server for non-HTTP failures", async () => {
    await submit(jest.fn(async () => Promise.reject(new Error("network down"))))

    expect(await screen.findByText(/Could not reach host/)).toBeOnTheScreen()
  })

  it("normalizes the server URL before saving it", async () => {
    client = makeClient()
    createClientMock.mockReturnValue(client)
    await render(<App />)

    await fireEvent.changeText(await screen.findByTestId("server-url-input"), "https://host/")
    await fireEvent.changeText(screen.getByTestId("password-input"), "pw")
    await fireEvent.press(screen.getByTestId("connect-button"))

    await waitFor(() =>
      expect(storage.saveServerRegistry).toHaveBeenCalledWith(
        expect.objectContaining({
          profiles: [expect.objectContaining({ url: "https://host" })],
        }),
      ),
    )
    expect(await screen.findByLabelText("Show sessions")).toBeOnTheScreen()
  })

  it("clears the token when the server rejects it mid-session", async () => {
    await renderAuthenticated()

    const options = createClientMock.mock.calls
      .map((call) => call[0] as { onUnauthorized?: () => void })
      .find((value) => value.onUnauthorized)
    await act(async () => {
      options?.onUnauthorized?.()
    })

    expect(storage.clearServerToken).toHaveBeenCalledWith("home")
    expect((await screen.findAllByText(/saved session expired/)).length).toBeGreaterThan(0)
    expect(screen.getByText(/Reconnect to Home/)).toBeOnTheScreen()
  })
})

describe("App — sessions", () => {
  it("creates a session from the header", async () => {
    await renderAuthenticated()

    await fireEvent.press(await screen.findByLabelText("New session"))

    expect(client.api.sessions.create).toHaveBeenCalledWith("ws1")
  })

  it("banners a failed session creation", async () => {
    client = makeClient()
    client.api.sessions.create.mockRejectedValue(new Error("nope"))
    createClientMock.mockReturnValue(client)
    await renderAuthenticated()

    await fireEvent.press(await screen.findByLabelText("New session"))

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

  it("hides the bottom nav in a chat and returns to the session list", async () => {
    await renderAuthenticated({ sessions: [makeSession()] })

    await fireEvent.press(screen.getByText("My session"))
    expect(await screen.findByPlaceholderText("Write a message…")).toBeOnTheScreen()
    expect(screen.queryByLabelText("Show sessions")).toBeNull()
    expect(screen.queryByLabelText("Settings")).toBeNull()

    await fireEvent.press(screen.getByLabelText("Back"))
    expect(await screen.findByLabelText("Show sessions")).toBeOnTheScreen()
    expect(screen.getByText("My session")).toBeOnTheScreen()
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

    await fireEvent.press(screen.getByLabelText("Workspace"))
    await fireEvent.press(screen.getByText("other"))

    expect(storage.saveServerRegistry).toHaveBeenCalledWith(
      expect.objectContaining({
        profiles: [expect.objectContaining({ lastWorkspaceID: "ws2" })],
      }),
    )
  })

  it("keeps the board when switching workspace from the board picker", async () => {
    await renderAuthenticated({
      workspaces: [workspace, otherWorkspace],
      sessions: [makeSession()],
      // The new workspace has sessions too: the board switch must not
      // auto-open one (the old `switchWorkspace` path landed in the chat).
      otherWorkspaceSessions: [
        makeSession({ id: "ses_2", title: "Other session", location: { directory: "/workspaces/other" } }),
      ],
    })

    await fireEvent.press(screen.getByLabelText("Show board"))
    expect(screen.getByTestId("screen-title")).toHaveTextContent("Board")

    await fireEvent.press(screen.getByLabelText("Workspace"))
    await fireEvent.press(await screen.findByText("other"))

    expect(await screen.findByTestId("screen-title")).toHaveTextContent("Board")
    expect(screen.queryByPlaceholderText("Write a message…")).toBeNull()
    expect(boardMock).toHaveBeenLastCalledWith(client, "ws2")
    await waitFor(() =>
      expect(storage.saveServerRegistry).toHaveBeenCalledWith(
        expect.objectContaining({
          profiles: [expect.objectContaining({ lastWorkspaceID: "ws2" })],
        }),
      ),
    )
  })

  it("adds a workspace and selects it", async () => {
    await renderAuthenticated()

    await fireEvent.press(screen.getByLabelText("Workspace"))
    await fireEvent.press(screen.getByText("Add workspace"))
    await fireEvent.changeText(await screen.findByPlaceholderText("my-project"), "fresh")
    await fireEvent.press(screen.getByLabelText("Add"))

    await waitFor(() => expect(client.workspaces.create).toHaveBeenCalledWith({ name: "fresh" }))
    expect(storage.saveServerRegistry).toHaveBeenCalledWith(
      expect.objectContaining({
        profiles: [expect.objectContaining({ lastWorkspaceID: "ws_new" })],
      }),
    )
  })

  it("removes the selected workspace after confirmation", async () => {
    await renderAuthenticated()

    await fireEvent.press(screen.getByLabelText("Workspace"))
    await fireEvent.press(screen.getByText("Remove workspace"))
    await fireEvent.press(await screen.findByLabelText("Remove"))

    await waitFor(() => expect(client.workspaces.remove).toHaveBeenCalledWith("ws1", { deleteFiles: false }))
    await waitFor(() =>
      expect(storage.saveServerRegistry).toHaveBeenCalledWith(
        expect.objectContaining({
          profiles: [expect.objectContaining({ lastWorkspaceID: null })],
        }),
      ),
    )
  })

  it("banners a failed workspace removal", async () => {
    client = makeClient()
    client.workspaces.remove.mockRejectedValue(new Error("nope"))
    createClientMock.mockReturnValue(client)
    await renderAuthenticated()

    await fireEvent.press(screen.getByLabelText("Workspace"))
    await fireEvent.press(screen.getByText("Remove workspace"))
    await fireEvent.press(await screen.findByLabelText("Remove"))

    expect(await screen.findByText("Could not remove the workspace")).toBeOnTheScreen()
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
    await renderAuthenticated({ sessions: [makeSession()] })

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
      sessions: [makeSession()],
    })

    await waitFor(() =>
      expect(client.api.respondPermission).toHaveBeenCalledWith("ses_1", "perm_1", "once"),
    )
  })

  it("retries auto-accept after a transient failure", async () => {
    client = makeClient()
    client.api.permissions.mockResolvedValue([permission])
    client.api.respondPermission
      .mockRejectedValueOnce(new Error("nope"))
      .mockResolvedValue(undefined)
    createClientMock.mockReturnValue(client)
    await renderAuthenticated({
      autoAccept: ["ses_1"],
      sessions: [makeSession()],
    })

    // The retry fires ~1 s after the first failure: answer it, no banner.
    await waitFor(() => expect(client.api.respondPermission).toHaveBeenCalledTimes(2), {
      timeout: 3000,
    })
    expect(screen.queryByText(/Could not auto-accept/)).toBeNull()
  })

  it("stops retrying and banners when auto-accept keeps failing", async () => {
    client = makeClient()
    client.api.permissions.mockResolvedValue([permission])
    client.api.respondPermission.mockRejectedValue(new Error("nope"))
    createClientMock.mockReturnValue(client)
    await renderAuthenticated({
      autoAccept: ["ses_1"],
      sessions: [makeSession()],
    })

    // Initial attempt + retries at ~1 s and ~3 s, then the actionable banner.
    expect(
      await screen.findByText("Could not auto-accept the permission request — answer it in the chat", {}, {
        timeout: 6000,
      }),
    ).toBeOnTheScreen()
    expect(client.api.respondPermission).toHaveBeenCalledTimes(3)
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
    await renderAuthenticated({ sessions: [makeSession()] })

    act(() => {
      streamOptions().onConnect?.()
    })

    await waitFor(() => expect(client.api.permissions).toHaveBeenCalledWith("/workspaces/demo"))
    expect(await screen.findByText("Permission required")).toBeOnTheScreen()
  })
})
