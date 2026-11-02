import { fireEvent, render, screen } from "@testing-library/react-native"
import type { WorkspaceRecord } from "@masterhand/client-core"
import { WorkspacePicker } from "../src/components/WorkspacePicker"

const workspaces: WorkspaceRecord[] = [
  { id: "ws1", name: "demo", path: "/workspaces/demo", createdAt: 0 },
  { id: "ws2", name: "other", path: "/workspaces/other", createdAt: 1 },
]

async function setup(props: Partial<React.ComponentProps<typeof WorkspacePicker>> = {}) {
  const handlers = {
    onSelect: jest.fn(),
    onAdd: jest.fn(async () => {}),
    onRemove: jest.fn(),
    ...props,
  }
  await render(
    <WorkspacePicker workspaces={workspaces} workspaceID="ws1" {...handlers} />,
  )
  return handlers
}

describe("WorkspacePicker", () => {
  it("shows the selected workspace on the trigger", async () => {
    await setup()

    expect(screen.getByLabelText("Workspace").props.accessibilityValue?.text).toBe("demo")
  })

  it("opens the compact menu and selects a workspace", async () => {
    const handlers = await setup()

    await fireEvent.press(screen.getByLabelText("Workspace"))
    await fireEvent.press(screen.getByText("other"))

    expect(handlers.onSelect).toHaveBeenCalledWith("ws2")
    expect(screen.queryByTestId("workspace-option-ws2")).toBeNull()
  })

  it("hides the remove action when no workspace is selected", async () => {
    await setup({ workspaceID: null })

    await fireEvent.press(screen.getByLabelText("Workspace"))

    expect(screen.queryByText("Remove workspace")).toBeNull()
    expect(screen.getByText("Add workspace")).toBeOnTheScreen()
  })

  it("previews the five most recent workspaces and expands with Show all", async () => {
    const many: WorkspaceRecord[] = Array.from({ length: 7 }, (_, index) => ({
      id: `ws${index}`,
      name: `project-${index}`,
      path: `/workspaces/project-${index}`,
      createdAt: index,
    }))
    await setup({ workspaces: many, workspaceID: null })

    await fireEvent.press(screen.getByLabelText("Workspace"))

    // Newest first: 6..2, with 1 and 0 behind "Show all".
    expect(screen.getByText("project-6")).toBeOnTheScreen()
    expect(screen.getByText("project-2")).toBeOnTheScreen()
    expect(screen.queryByText("project-1")).toBeNull()

    await fireEvent.press(screen.getByText("Show all 7"))
    expect(screen.getByText("project-1")).toBeOnTheScreen()
    expect(screen.getByText("project-0")).toBeOnTheScreen()
  })

  it("searches workspaces by name", async () => {
    const many: WorkspaceRecord[] = Array.from({ length: 7 }, (_, index) => ({
      id: `ws${index}`,
      name: `project-${index}`,
      path: `/workspaces/project-${index}`,
      createdAt: index,
    }))
    await setup({ workspaces: many, workspaceID: null })

    await fireEvent.press(screen.getByLabelText("Workspace"))
    await fireEvent.changeText(screen.getByPlaceholderText("Search…"), "project-1")

    expect(screen.getByText("project-1")).toBeOnTheScreen()
    expect(screen.queryByText("project-6")).toBeNull()
  })

  it("shows an empty state without workspaces", async () => {
    await setup({ workspaces: [], workspaceID: null })

    await fireEvent.press(screen.getByLabelText("Workspace"))

    expect(screen.getByText("No workspaces yet.")).toBeOnTheScreen()
  })

  it("adds a workspace from the menu", async () => {
    const handlers = await setup()

    await fireEvent.press(screen.getByLabelText("Workspace"))
    await fireEvent.press(screen.getByText("Add workspace"))
    await fireEvent.changeText(await screen.findByPlaceholderText("my-project"), "new-project")
    await fireEvent.press(screen.getByLabelText("Add"))

    expect(handlers.onAdd).toHaveBeenCalledWith({ name: "new-project" })
  })

  it("removes the selected workspace from the menu", async () => {
    const handlers = await setup()

    await fireEvent.press(screen.getByLabelText("Workspace"))
    await fireEvent.press(screen.getByText("Remove workspace"))
    await fireEvent.press(await screen.findByLabelText("Remove"))

    expect(handlers.onRemove).toHaveBeenCalledWith("ws1", { deleteFiles: false })
  })
})
