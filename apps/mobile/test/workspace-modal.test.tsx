import { fireEvent, render, screen } from "@testing-library/react-native"
import { ApiError, type WorkspaceRecord } from "@masterhand/client-core"
import { WorkspaceModal } from "../src/components/WorkspaceModal"

const workspace: WorkspaceRecord = { id: "ws1", name: "demo", path: "/workspaces/demo", createdAt: 0 }

async function setup(props: Partial<React.ComponentProps<typeof WorkspaceModal>> = {}) {
  const handlers = {
    onAdd: jest.fn(async () => {}),
    onRemove: jest.fn(),
    onClose: jest.fn(),
    ...props,
  }
  await render(<WorkspaceModal visible mode="add" workspace={null} {...handlers} />)
  return handlers
}

describe("WorkspaceModal", () => {
  it("adds a workspace with the trimmed name", async () => {
    const handlers = await setup()

    await fireEvent.changeText(screen.getByPlaceholderText("my-project"), "  new-project  ")
    await fireEvent.press(screen.getByLabelText("Add"))

    expect(handlers.onAdd).toHaveBeenCalledWith({ name: "new-project" })
    expect(handlers.onClose).toHaveBeenCalled()
  })

  it("explains a duplicate workspace error", async () => {
    const onAdd = jest.fn(async () => {
      throw new ApiError(409, "exists")
    })
    await setup({ onAdd })

    await fireEvent.changeText(screen.getByPlaceholderText("my-project"), "demo")
    await fireEvent.press(screen.getByLabelText("Add"))

    expect(await screen.findByText("That workspace already exists")).toBeOnTheScreen()
    expect(screen.getByLabelText("Add")).toBeOnTheScreen()
  })

  it("explains an invalid folder name", async () => {
    const onAdd = jest.fn(async () => {
      throw new ApiError(400, "bad name")
    })
    await setup({ onAdd })

    await fireEvent.changeText(screen.getByPlaceholderText("my-project"), "a/b")
    await fireEvent.press(screen.getByLabelText("Add"))

    expect(await screen.findByText("Enter a valid folder name (no slashes or leading dots)")).toBeOnTheScreen()
  })

  it("falls back to a generic error", async () => {
    const onAdd = jest.fn(async () => {
      throw new Error("boom")
    })
    await setup({ onAdd })

    await fireEvent.changeText(screen.getByPlaceholderText("my-project"), "fresh")
    await fireEvent.press(screen.getByLabelText("Add"))

    expect(await screen.findByText("Could not add the workspace")).toBeOnTheScreen()
  })

  it("does not add an empty or whitespace-only name", async () => {
    const handlers = await setup()

    await fireEvent.changeText(screen.getByPlaceholderText("my-project"), "   ")
    await fireEvent.press(screen.getByLabelText("Add"))

    expect(handlers.onAdd).not.toHaveBeenCalled()
  })

  it("resets the form when the sheet is hidden", async () => {
    const props = {
      mode: "add" as const,
      workspace: null,
      onAdd: jest.fn(async () => {}),
      onRemove: jest.fn(),
      onClose: jest.fn(),
    }
    const { rerender } = await render(<WorkspaceModal visible {...props} />)

    await fireEvent.changeText(screen.getByPlaceholderText("my-project"), "typed")
    await rerender(<WorkspaceModal visible={false} {...props} />)
    await rerender(<WorkspaceModal visible {...props} />)

    expect(screen.getByPlaceholderText("my-project").props.value).toBe("")
  })

  it("removes the workspace without deleting files by default", async () => {
    const handlers = await setup({ mode: "remove", workspace })

    expect(screen.getByText("demo")).toBeOnTheScreen()
    await fireEvent.press(screen.getByLabelText("Remove"))

    expect(handlers.onRemove).toHaveBeenCalledWith("ws1", { deleteFiles: false })
    expect(handlers.onClose).toHaveBeenCalled()
  })

  it("removes the workspace and its files when the toggle is on", async () => {
    const handlers = await setup({ mode: "remove", workspace })

    await fireEvent.press(screen.getByText(/Also delete its folder/))
    await fireEvent.press(screen.getByLabelText("Remove"))

    expect(handlers.onRemove).toHaveBeenCalledWith("ws1", { deleteFiles: true })
  })

  it("toggles the delete-files option from the switch", async () => {
    const handlers = await setup({ mode: "remove", workspace })

    await fireEvent(screen.getByTestId("workspace-delete-files"), "valueChange", true)
    await fireEvent.press(screen.getByLabelText("Remove"))

    expect(handlers.onRemove).toHaveBeenCalledWith("ws1", { deleteFiles: true })
  })

  it("does not remove twice when the action is pressed twice", async () => {
    const handlers = await setup({ mode: "remove", workspace })

    await fireEvent.press(screen.getByLabelText("Remove"))
    await fireEvent.press(screen.getByLabelText("Remove"))

    expect(handlers.onRemove).toHaveBeenCalledTimes(1)
  })

  it("cancels the removal", async () => {
    const handlers = await setup({ mode: "remove", workspace })

    await fireEvent.press(screen.getByText("Cancel"))

    expect(handlers.onRemove).not.toHaveBeenCalled()
    expect(handlers.onClose).toHaveBeenCalled()
  })
})
