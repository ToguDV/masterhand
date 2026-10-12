import { fireEvent, render, screen } from "@testing-library/react-native"
import { BranchChip, BranchPicker } from "../src/components/BranchPicker"
import { fakeClient, makeQueryClient, QueryWrapper } from "./support/render"

async function setup(configure?: (client: ReturnType<typeof fakeClient>) => void) {
  const client = fakeClient()
  configure?.(client)
  const queryClient = makeQueryClient()
  await render(<BranchPicker client={client} workspaceID="ws1" />, {
    wrapper: ({ children }) => <QueryWrapper client={queryClient}>{children}</QueryWrapper>,
  })
  return { client, queryClient }
}

describe("BranchPicker", () => {
  it("shows the workspace's current branch", async () => {
    await setup((client) => {
      client.api.branches.list.mockResolvedValue({ current: "feature/x", branches: ["main", "feature/x"] })
    })

    expect(await screen.findByText("feature/x")).toBeOnTheScreen()
  })

  it("switches to the selected branch and reconciles the list", async () => {
    const { client } = await setup((c) => {
      c.api.branches.list.mockResolvedValue({ current: "main", branches: ["main", "feature/x"] })
    })

    await screen.findByText("main")
    await fireEvent.press(screen.getByLabelText("Branch"))
    await fireEvent.press(await screen.findByText("feature/x"))

    expect(client.api.branches.checkout).toHaveBeenCalledWith("ws1", "feature/x")
  })

  it("creates a branch from the current one", async () => {
    const { client } = await setup((c) => {
      c.api.branches.list.mockResolvedValue({ current: "main", branches: ["main"] })
    })

    await screen.findByText("main")
    await fireEvent.press(screen.getByLabelText("Branch"))
    await fireEvent.changeText(await screen.findByPlaceholderText("new-branch-name"), "feature/y")
    await fireEvent.press(screen.getByText("Create"))

    expect(client.api.branches.create).toHaveBeenCalledWith("ws1", "feature/y")
  })

  it("reports a failed switch without retrying it", async () => {
    const { client } = await setup((c) => {
      c.api.branches.list.mockResolvedValue({ current: "main", branches: ["main", "feature/x"] })
      c.api.branches.checkout.mockRejectedValue(new Error("nope"))
    })

    await screen.findByText("main")
    await fireEvent.press(screen.getByLabelText("Branch"))
    await fireEvent.press(await screen.findByText("feature/x"))

    expect(await screen.findByText("Could not update the branch")).toBeOnTheScreen()
    expect(client.api.branches.checkout).toHaveBeenCalledTimes(1)
  })

  it("renders a read-only chip for isolated sessions", async () => {
    await render(<BranchChip branch="masterhand/abc" />)

    expect(await screen.findByText("masterhand/abc")).toBeOnTheScreen()
  })
})
