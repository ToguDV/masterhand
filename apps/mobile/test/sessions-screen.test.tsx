import { Alert, Text } from "react-native"
import { fireEvent, render, screen } from "@testing-library/react-native"
import type { Session, SessionStatuses, WorkspaceRecord } from "@masterhand/client-core"
import { SessionsScreen } from "../src/screens/SessionsScreen"
import { GestureWrapper } from "./support/render"

const workspace: WorkspaceRecord = {
  id: "ws1",
  name: "demo",
  path: "/workspaces/demo",
  createdAt: 0,
}

function makeSession(overrides: Partial<Session> & { id: string; title: string }): Session {
  return {
    projectID: "proj",
    cost: 0,
    tokens: {},
    time: { created: 0, updated: 0 },
    location: { directory: "/workspaces/demo" },
    ...overrides,
  } as unknown as Session
}

const standard = makeSession({ id: "ses_1", title: "Standard session" })
const child = makeSession({ id: "ses_child", title: "Subagent child", parentID: "ses_1" })

async function setup(props: Partial<React.ComponentProps<typeof SessionsScreen>> = {}) {
  const handlers = {
    onOpen: jest.fn(),
    onNew: jest.fn(),
    onOpenSettings: jest.fn(),
    onSelectWorkspace: jest.fn(),
    onAddWorkspace: jest.fn(async () => {}),
    onRemoveWorkspace: jest.fn(),
    onDeleteSession: jest.fn(),
    ...props,
  }
  await render(
    <GestureWrapper>
    <SessionsScreen
      sessions={[standard, child]}
      loading={false}
      statuses={{} as SessionStatuses}
      connected
      creating={false}
      banner={null}
      workspaces={[workspace]}
      workspaceID={workspace.id}
      canCreate
      {...handlers}
    />
    </GestureWrapper>,
  )
  return handlers
}

describe("SessionsScreen", () => {
  it("lists root sessions and hides subagent children", async () => {
    await setup()

    expect(screen.getByText("Standard session")).toBeOnTheScreen()
    expect(screen.queryByText("Subagent child")).toBeNull()
  })

  it("opens a session when its row is pressed", async () => {
    const handlers = await setup()

    await fireEvent.press(screen.getByText("Standard session"))

    expect(handlers.onOpen).toHaveBeenCalledWith("ses_1")
  })

  it("creates a new session directly from the header action", async () => {
    const handlers = await setup()

    await fireEvent.press(screen.getByLabelText("New session"))

    expect(handlers.onNew).toHaveBeenCalledTimes(1)
  })

  it("blocks creating and explains why when there is no workspace", async () => {
    const handlers = await setup({ sessions: [], canCreate: false, workspaces: [], workspaceID: null })

    expect(screen.getByText("Add a workspace to start working on a project.")).toBeOnTheScreen()

    await fireEvent.press(screen.getByLabelText("New session"))
    expect(handlers.onNew).not.toHaveBeenCalled()
  })

  it("asks for confirmation before deleting a session", async () => {
    const handlers = await setup()
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {})

    await fireEvent.press(screen.getAllByLabelText("Delete session")[0]!)

    const buttons = alert.mock.calls[0]?.[2]
    const destructive = buttons?.find((button) => button.style === "destructive")
    destructive?.onPress?.()
    expect(handlers.onDeleteSession).toHaveBeenCalledWith("ses_1")

    alert.mockRestore()
  })

  it("shows the reconnecting banner when the stream is down", async () => {
    await setup({ connected: false })

    expect(screen.getByText("Reconnecting to the server…")).toBeOnTheScreen()
  })

  it("shows a loading placeholder while sessions load", async () => {
    await setup({ sessions: [], loading: true })

    expect(screen.getByText("Loading…")).toBeOnTheScreen()
  })

  it("explains an empty session list", async () => {
    await setup({ sessions: [] })

    expect(screen.getByText("No sessions yet.")).toBeOnTheScreen()
  })

  it("opens the settings modal from the bottom nav", async () => {
    const handlers = await setup()

    await fireEvent.press(screen.getByLabelText("Settings"))

    expect(handlers.onOpenSettings).toHaveBeenCalled()
  })

  it("groups the new-session + with the Sessions title (#122)", async () => {
    await setup()

    const title = screen.getByTestId("screen-title")
    const plus = screen.getByLabelText("New session")

    // Same left-aligned cluster, not the far right of the header.
    expect(title.parent).toBe(plus.parent)
  })

  it("disables the new-session action while creating", async () => {
    await setup({ creating: true })

    const trigger = screen.getByLabelText("New session")
    expect(trigger.props.accessibilityState?.disabled).toBe(true)
  })

  it("opens the workspace menu and confirms removal", async () => {
    const handlers = await setup()

    await fireEvent.press(screen.getByLabelText("Workspace"))
    await fireEvent.press(screen.getByText("Remove workspace"))
    await fireEvent.press(await screen.findByLabelText("Remove"))

    expect(handlers.onRemoveWorkspace).toHaveBeenCalledWith("ws1", { deleteFiles: false })
  })
})

describe("SessionsScreen sections (#172)", () => {
  it("keeps the sessions tab and settings action when no section slots are provided", async () => {
    await setup()

    expect(screen.getByLabelText("Show sessions")).toBeOnTheScreen()
    expect(screen.queryByLabelText("Show board")).toBeNull()
    expect(screen.queryByLabelText("Show scheduler")).toBeNull()
    expect(screen.getByLabelText("Settings")).toBeOnTheScreen()
    expect(screen.getByText("Standard session")).toBeOnTheScreen()
  })

  it("renders the scheduler slot instead of the session list", async () => {
    await setup({ section: "scheduler", scheduler: <Text>Scheduler stub</Text> })

    expect(screen.getByText("Scheduler stub")).toBeOnTheScreen()
    expect(screen.getByTestId("screen-title")).toHaveTextContent("Scheduler")
    expect(screen.queryByText("Standard session")).toBeNull()
  })

  it("notifies when a section tab is pressed", async () => {
    const onSelectSection = jest.fn()
    await setup({ onSelectSection, scheduler: <Text>Scheduler stub</Text> })

    await fireEvent.press(screen.getByLabelText("Show scheduler"))
    expect(onSelectSection).toHaveBeenCalledWith("scheduler")

    await fireEvent.press(screen.getByLabelText("Show sessions"))
    expect(onSelectSection).toHaveBeenCalledWith("sessions")
  })
})

describe("SessionsScreen board section (#164)", () => {
  it("renders the board slot instead of the session list", async () => {
    await setup({ section: "board", board: <Text>Board stub</Text>, scheduler: <Text>Scheduler stub</Text> })

    expect(screen.getByText("Board stub")).toBeOnTheScreen()
    expect(screen.getByTestId("screen-title")).toHaveTextContent("Board")
    expect(screen.queryByText("Standard session")).toBeNull()
  })

  it("notifies when the board tab is pressed", async () => {
    const onSelectSection = jest.fn()
    await setup({ onSelectSection, board: <Text>Board stub</Text> })

    await fireEvent.press(screen.getByLabelText("Show board"))
    expect(onSelectSection).toHaveBeenCalledWith("board")
  })

  it("hides the board tab when no board slot is provided", async () => {
    await setup({ scheduler: <Text>Scheduler stub</Text> })

    expect(screen.queryByLabelText("Show board")).toBeNull()
    expect(screen.getByLabelText("Show scheduler")).toBeOnTheScreen()
  })
})
