import { fireEvent, render, screen, waitFor } from "@testing-library/react-native"
import { AuditModal } from "../src/components/AuditModal"
import { fakeClient, makeQueryClient, QueryWrapper } from "./support/render"

async function setup(client = fakeClient(), onClose = jest.fn()) {
  const queryClient = makeQueryClient()
  await render(<AuditModal client={client} onClose={onClose} />, {
    wrapper: ({ children }) => <QueryWrapper client={queryClient}>{children}</QueryWrapper>,
  })
  return { client, onClose, queryClient }
}

describe("AuditModal", () => {
  it("lists denied commands with their reason", async () => {
    const client = fakeClient()
    client.api.audit.mockResolvedValue([
      {
        id: 2,
        at: Date.now(),
        sessionID: "ses_1",
        workspaceID: null,
        kind: "permission_denied",
        command: "pkill -f node",
        reason: "Permission denied: shell",
        source: "opencode",
      },
    ])
    await setup(client)

    expect(await screen.findByText("pkill -f node")).toBeOnTheScreen()
    expect(screen.getByText("Permission denied: shell")).toBeOnTheScreen()
    expect(screen.getByText("permission denied")).toBeOnTheScreen()
  })

  it("clears the log", async () => {
    const client = fakeClient()
    client.api.audit.mockResolvedValue([
      {
        id: 1,
        at: Date.now(),
        sessionID: null,
        workspaceID: null,
        kind: "permission_denied",
        command: "killall node",
        reason: "Permission denied: shell",
        source: "opencode",
      },
    ])
    await setup(client)

    await fireEvent.press(await screen.findByText("Clear"))

    expect(client.api.clearAudit).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.getByText(/Nothing blocked yet/)).toBeOnTheScreen())
  })

  it("shows the empty state and closes", async () => {
    const client = fakeClient()
    const { onClose } = await setup(client)

    expect(await screen.findByText(/Nothing blocked yet/)).toBeOnTheScreen()
    await fireEvent.press(screen.getByText("Close"))
    expect(onClose).toHaveBeenCalled()
  })
})
