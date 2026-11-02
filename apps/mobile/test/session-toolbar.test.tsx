import { Text } from "react-native"
import { fireEvent, render, screen } from "@testing-library/react-native"
import { SessionToolbar } from "../src/components/SessionToolbar"
import { makeQueryClient, QueryWrapper } from "./support/render"

async function setup(
  branch: React.ReactNode = null,
  trailing: React.ReactNode = null,
  props: Partial<{
    onSelectWorkspace: (id: string) => void
    onAddWorkspace: (input: { name: string }) => Promise<void>
    onRemoveWorkspace: (id: string, options: { deleteFiles: boolean }) => void
  }> = {},
) {
  const queryClient = makeQueryClient()
  const handlers = {
    onSelectWorkspace: jest.fn(),
    onAddWorkspace: jest.fn(async () => {}),
    onRemoveWorkspace: jest.fn(),
    ...props,
  }
  await render(
    <SessionToolbar
      workspaces={[{ id: "ws1", name: "demo", path: "/workspaces/demo", createdAt: 0 }]}
      workspaceID="ws1"
      branch={branch}
      trailing={trailing}
      {...handlers}
    />,
    { wrapper: ({ children }) => <QueryWrapper client={queryClient}>{children}</QueryWrapper> },
  )
  return handlers
}

describe("SessionToolbar", () => {
  it("shows the workspace, the branch control and the trailing stats", async () => {
    await setup(<Text>test-branch</Text>, <Text>test-stats</Text>)

    expect(await screen.findByText("demo")).toBeOnTheScreen()
    expect(screen.getByText("test-branch")).toBeOnTheScreen()
    expect(screen.getByText("test-stats")).toBeOnTheScreen()
  })

  it("manages workspaces from the header trigger", async () => {
    await setup()

    await fireEvent.press(await screen.findByLabelText("Workspace"))
    expect(await screen.findByText("Remove workspace")).toBeOnTheScreen()
  })

  it("selects a workspace from the header sheet", async () => {
    const queryClient = makeQueryClient()
    const onSelectWorkspace = jest.fn()
    await render(
      <SessionToolbar
        workspaces={[
          { id: "ws1", name: "demo", path: "/workspaces/demo", createdAt: 0 },
          { id: "ws2", name: "other", path: "/workspaces/other", createdAt: 0 },
        ]}
        workspaceID="ws1"
        onSelectWorkspace={onSelectWorkspace}
        onAddWorkspace={jest.fn(async () => {})}
        onRemoveWorkspace={jest.fn()}
      />,
      { wrapper: ({ children }) => <QueryWrapper client={queryClient}>{children}</QueryWrapper> },
    )

    await fireEvent.press(await screen.findByLabelText("Workspace"))
    await fireEvent.press(await screen.findByText("other"))

    expect(onSelectWorkspace).toHaveBeenCalledWith("ws2")
  })

  it("adds a workspace through the header sheet", async () => {
    const { onAddWorkspace } = await setup()

    await fireEvent.press(await screen.findByLabelText("Workspace"))
    await fireEvent.press(await screen.findByText("Add workspace"))
    await fireEvent.changeText(await screen.findByTestId("workspace-name-input"), "demo-2")
    await fireEvent.press(screen.getByLabelText("Add"))

    expect(onAddWorkspace).toHaveBeenCalledWith({ name: "demo-2" })
  })

  it("removes a workspace through the header sheet", async () => {
    const { onRemoveWorkspace } = await setup()

    await fireEvent.press(await screen.findByLabelText("Workspace"))
    await fireEvent.press(await screen.findByText("Remove workspace"))
    await fireEvent.press(await screen.findByLabelText("Remove"))

    expect(onRemoveWorkspace).toHaveBeenCalledWith("ws1", { deleteFiles: false })
  })
})
