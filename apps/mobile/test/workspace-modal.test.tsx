import { fireEvent, render, screen } from "@testing-library/react-native"
import { ApiError, type WorkspaceRecord } from "@masterhand/client-core"
import { WorkspaceModal } from "../src/components/WorkspaceModal"

const workspaces: WorkspaceRecord[] = [
  { id: "ws1", name: "demo", path: "/workspaces/demo", createdAt: 0 },
  { id: "ws2", name: "other", path: "/workspaces/other", createdAt: 0 },
]

async function setup(props: Partial<React.ComponentProps<typeof WorkspaceModal>> = {}) {
  const handlers = {
    onSelect: jest.fn(),
    onAdd: jest.fn(async () => {}),
    onRemove: jest.fn(),
    onClose: jest.fn(),
    ...props,
  }
  await render(<WorkspaceModal visible workspaces={workspaces} selectedID={null} {...handlers} />)
  return handlers
}

describe("WorkspaceModal", () => {
  it("lists workspaces and selects one, closing the sheet", async () => {
    const handlers = await setup()

    expect(screen.getByText("demo")).toBeOnTheScreen()
    expect(screen.getByText("other")).toBeOnTheScreen()

    await fireEvent.press(screen.getByText("demo"))
    expect(handlers.onSelect).toHaveBeenCalledWith("ws1")
    expect(handlers.onClose).toHaveBeenCalled()
  })

  it("previews the five most recent workspaces and expands with Show all", async () => {
    const many: WorkspaceRecord[] = Array.from({ length: 7 }, (_, index) => ({
      id: `ws${index}`,
      name: `project-${index}`,
      path: `/workspaces/project-${index}`,
      createdAt: index,
    }))
    await setup({ workspaces: many })

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
    await setup({ workspaces: many })

    await fireEvent.changeText(screen.getByPlaceholderText("Search…"), "project-1")
    expect(screen.getByText("project-1")).toBeOnTheScreen()
    expect(screen.queryByText("project-6")).toBeNull()
  })

  it("shows an empty state without workspaces", async () => {
    await setup({ workspaces: [] })

    expect(screen.getByText("No workspaces yet.")).toBeOnTheScreen()
  })

  it("adds a workspace with the trimmed name", async () => {
    const handlers = await setup()

    await fireEvent.press(screen.getByText("Add workspace"))
    await fireEvent.changeText(screen.getByPlaceholderText("my-project"), "  new-project  ")
    await fireEvent.press(screen.getByText("Add"))

    expect(handlers.onAdd).toHaveBeenCalledWith({ name: "new-project" })
  })

  it("explains a duplicate workspace error", async () => {
    const onAdd = jest.fn(async () => {
      throw new ApiError(409, "exists")
    })
    await setup({ onAdd })

    await fireEvent.press(screen.getByText("Add workspace"))
    await fireEvent.changeText(screen.getByPlaceholderText("my-project"), "demo")
    await fireEvent.press(screen.getByText("Add"))

    expect(await screen.findByText("That workspace already exists")).toBeOnTheScreen()
    expect(screen.getByText("Add")).toBeOnTheScreen()
  })

  it("removes the selected workspace, with the delete-files option", async () => {
    const handlers = await setup({ selectedID: "ws1" })

    await fireEvent.press(screen.getByText("Remove workspace"))
    expect(handlers.onRemove).toHaveBeenCalledWith("ws1", { deleteFiles: false })

    await fireEvent.press(screen.getByText("Also delete files from disk"))
    await fireEvent.press(screen.getByText("Remove workspace"))
    expect(handlers.onRemove).toHaveBeenLastCalledWith("ws1", { deleteFiles: true })
  })

  it("explains an invalid folder name", async () => {
    const onAdd = jest.fn(async () => {
      throw new ApiError(400, "bad name")
    })
    await setup({ onAdd })

    await fireEvent.press(screen.getByText("Add workspace"))
    await fireEvent.changeText(screen.getByPlaceholderText("my-project"), "a/b")
    await fireEvent.press(screen.getByText("Add"))

    expect(await screen.findByText("Enter a valid folder name (no slashes or leading dots)")).toBeOnTheScreen()
  })

  it("falls back to a generic error", async () => {
    const onAdd = jest.fn(async () => {
      throw new Error("boom")
    })
    await setup({ onAdd })

    await fireEvent.press(screen.getByText("Add workspace"))
    await fireEvent.changeText(screen.getByPlaceholderText("my-project"), "fresh")
    await fireEvent.press(screen.getByText("Add"))

    expect(await screen.findByText("Could not add the workspace")).toBeOnTheScreen()
  })

  it("cancels the add form", async () => {
    await setup()

    await fireEvent.press(screen.getByText("Add workspace"))
    expect(screen.getByPlaceholderText("my-project")).toBeOnTheScreen()

    await fireEvent.press(screen.getByText("Cancel"))
    expect(screen.queryByPlaceholderText("my-project")).toBeNull()
  })

  it("resets the form when the sheet is hidden", async () => {
    const props = {
      workspaces,
      selectedID: null,
      onSelect: jest.fn(),
      onAdd: jest.fn(async () => {}),
      onRemove: jest.fn(),
      onClose: jest.fn(),
    }
    const { rerender } = await render(<WorkspaceModal visible {...props} />)

    await fireEvent.press(screen.getByText("Add workspace"))
    await fireEvent.changeText(screen.getByPlaceholderText("my-project"), "typed")
    await rerender(<WorkspaceModal visible={false} {...props} />)
    await rerender(<WorkspaceModal visible {...props} />)

    expect(screen.queryByPlaceholderText("my-project")).toBeNull()
  })
})
