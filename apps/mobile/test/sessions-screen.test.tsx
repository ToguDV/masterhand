import { Alert } from "react-native"
import { fireEvent, render, screen } from "@testing-library/react-native"
import type { Session, SessionStatuses, WorkspaceRecord } from "@masterhand/client-core"
import { SessionsScreen } from "../src/screens/SessionsScreen"

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
const isolated = makeSession({
  id: "ses_2",
  title: "Isolated session",
  isolation: {
    isolated: true,
    worktreePath: "/workspaces/.worktrees/demo/abc",
    branch: "masterhand/abc",
    baseRef: "HEAD",
  },
})
const child = makeSession({ id: "ses_child", title: "Subagent child", parentID: "ses_1" })

async function setup(props: Partial<React.ComponentProps<typeof SessionsScreen>> = {}) {
  const handlers = {
    onOpen: jest.fn(),
    onNew: jest.fn(),
    onSignOut: jest.fn(),
    onSelectWorkspace: jest.fn(),
    onAddWorkspace: jest.fn(async () => {}),
    onRemoveWorkspace: jest.fn(),
    onDeleteSession: jest.fn(),
    ...props,
  }
  await render(
    <SessionsScreen
      sessions={[standard, isolated, child]}
      loading={false}
      statuses={{} as SessionStatuses}
      connected
      creating={false}
      banner={null}
      workspaces={[workspace]}
      workspaceID={workspace.id}
      canCreate
      {...handlers}
    />,
  )
  return handlers
}

describe("SessionsScreen", () => {
  it("lists root sessions and hides subagent children", async () => {
    await setup()

    expect(screen.getByText("Standard session")).toBeOnTheScreen()
    expect(screen.getByText("Isolated session")).toBeOnTheScreen()
    expect(screen.queryByText("Subagent child")).toBeNull()
  })

  it("shows the isolation branch badge", async () => {
    await setup()

    expect(screen.getByText("masterhand/abc")).toBeOnTheScreen()
  })

  it("filters by isolation mode", async () => {
    await setup()

    await fireEvent.press(screen.getByText("Isolated"))
    expect(screen.queryByText("Standard session")).toBeNull()
    expect(screen.getByText("Isolated session")).toBeOnTheScreen()

    await fireEvent.press(screen.getByText("Standard"))
    expect(screen.queryByText("Isolated session")).toBeNull()
    expect(screen.getByText("Standard session")).toBeOnTheScreen()
  })

  it("opens a session when its row is pressed", async () => {
    const handlers = await setup()

    await fireEvent.press(screen.getByText("Standard session"))

    expect(handlers.onOpen).toHaveBeenCalledWith("ses_1")
  })

  it("creates a new session from the header popover with the isolated flag", async () => {
    const handlers = await setup()

    // The new-session action is a header icon whose popover hosts the toggle.
    await fireEvent.press(screen.getByLabelText("New session"))
    expect(screen.getByText("Runs in its own git worktree and branch")).toBeOnTheScreen()
    await fireEvent.press(screen.getByLabelText("Isolated session"))
    await fireEvent.press(screen.getByText("Create session"))

    expect(handlers.onNew).toHaveBeenCalledWith(true)
  })

  it("blocks creating and explains why when there is no workspace", async () => {
    const handlers = await setup({ sessions: [], canCreate: false, workspaces: [], workspaceID: null })

    expect(screen.getByText("Add a workspace to start working on a project.")).toBeOnTheScreen()

    await fireEvent.press(screen.getByLabelText("New session"))
    expect(screen.queryByText("Create session")).toBeNull()
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

  it("explains an empty filter result", async () => {
    await setup({ sessions: [standard] })

    await fireEvent.press(screen.getByText("Isolated"))

    expect(screen.getByText("No sessions match this filter.")).toBeOnTheScreen()
  })

  it("signs out from the header", async () => {
    const handlers = await setup()

    await fireEvent.press(screen.getByText("Sign out"))

    expect(handlers.onSignOut).toHaveBeenCalled()
  })

  it("disables the new-session action while creating", async () => {
    await setup({ creating: true })

    // No text label anymore: the trigger is disabled and shows a spinner.
    const trigger = screen.getByLabelText("New session")
    expect(trigger.props.accessibilityState?.disabled).toBe(true)
    await fireEvent.press(trigger)
    expect(screen.queryByText("Create session")).toBeNull()
  })

  it("opens the workspace sheet and confirms removal", async () => {
    const handlers = await setup()
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {})

    await fireEvent.press(screen.getByText("Workspace"))
    await fireEvent.press(screen.getByText("Remove workspace"))

    const destructive = alert.mock.calls[0]?.[2]?.find((button) => button.style === "destructive")
    destructive?.onPress?.()
    expect(handlers.onRemoveWorkspace).toHaveBeenCalledWith("ws1", { deleteFiles: false })

    alert.mockRestore()
  })
})
