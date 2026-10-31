import { render, screen, waitFor } from "@testing-library/react-native"
import { BranchViewer } from "../src/components/BranchViewer"
import { fakeClient, makeQueryClient, QueryWrapper } from "./support/render"

async function setup(configure?: (client: ReturnType<typeof fakeClient>) => void) {
  const client = fakeClient()
  configure?.(client)
  const queryClient = makeQueryClient()
  await render(<BranchViewer client={client} workspaceID="ws1" />, {
    wrapper: ({ children }) => <QueryWrapper client={queryClient}>{children}</QueryWrapper>,
  })
  return { client, queryClient }
}

describe("BranchViewer", () => {
  it("shows the workspace's current branch", async () => {
    const { client } = await setup((c) => {
      c.api.branches.list.mockResolvedValue({ current: "feature/x", branches: ["main", "feature/x"] })
    })

    expect(await screen.findByText("feature/x")).toBeOnTheScreen()
    expect(client.api.branches.list).toHaveBeenCalledWith("ws1")
  })

  it("is not interactive and exposes no picker", async () => {
    await setup((client) => {
      client.api.branches.list.mockResolvedValue({ current: "main", branches: ["main", "feature/x"] })
    })

    await screen.findByText("main")
    expect(screen.queryByLabelText("Branch")).toBeNull()
    expect(screen.queryByText("feature/x")).toBeNull()
  })

  it("renders nothing when the workspace is not a git repository", async () => {
    await setup((client) => {
      client.api.branches.list.mockRejectedValue(new Error("not a repo"))
    })

    await waitFor(() => expect(screen.queryByText("main")).toBeNull())
  })
})
