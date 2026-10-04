import { fireEvent, render, screen, waitFor } from "@testing-library/react-native"
import { RunModal } from "../src/components/RunModal"
import { fakeClient, makeQueryClient, QueryWrapper } from "./support/render"

async function setup(client = fakeClient(), onClose = jest.fn()) {
  const queryClient = makeQueryClient()
  await render(<RunModal client={client} sessionID="s1" workspaceID="ws1" onClose={onClose} />, {
    wrapper: ({ children }) => <QueryWrapper client={queryClient}>{children}</QueryWrapper>,
  })
  return { client, onClose, queryClient }
}

const config = {
  command: "npm",
  args: ["run", "dev", "--", "--port", "{port}"],
  cwd: null,
  source: "user" as const,
  updatedAt: 1,
}

const running = {
  status: "running" as const,
  command: "npm",
  args: ["run", "dev", "--", "--port", "3200"],
  port: 3200,
  pid: 42,
  error: null,
}

describe("RunModal", () => {
  it("shows the configured command and starts the run server", async () => {
    const client = fakeClient()
    client.api.run.mockResolvedValue(config)
    client.api.startSessionRun.mockResolvedValue(running)
    await setup(client)

    expect(await screen.findByText("npm run dev -- --port {port}")).toBeOnTheScreen()
    await fireEvent.press(screen.getByText("Start"))

    expect(client.api.startSessionRun).toHaveBeenCalledWith("s1", "ws1")
    expect(await screen.findByText("Stop")).toBeOnTheScreen()
  })

  it("stops a running server and reports a failed stop", async () => {
    const client = fakeClient()
    client.api.run.mockResolvedValue(config)
    client.api.sessionRun.mockResolvedValue(running)
    client.api.stopSessionRun.mockRejectedValue(new Error("nope"))
    await setup(client)

    await fireEvent.press(await screen.findByText("Stop"))

    expect(client.api.stopSessionRun).toHaveBeenCalledWith("s1", "ws1")
    expect(await screen.findByText("Could not stop the run server")).toBeOnTheScreen()
  })

  it("edits and saves the command as argv lines", async () => {
    const client = fakeClient()
    await setup(client)

    expect(await screen.findByText(/No run command configured/)).toBeOnTheScreen()
    await fireEvent.press(screen.getByText("Edit command"))
    await fireEvent.changeText(screen.getByPlaceholderText("npm"), "pnpm")
    await fireEvent.changeText(screen.getByPlaceholderText(/^run/), "dev\n--port\n{port}")
    await fireEvent.press(screen.getByText("Save"))

    await waitFor(() =>
      expect(client.api.saveRun).toHaveBeenCalledWith("ws1", {
        command: "pnpm",
        args: ["dev", "--port", "{port}"],
      }),
    )
  })

  it("detects and applies .masterhand/run.json", async () => {
    const client = fakeClient()
    await setup(client)

    await fireEvent.press(await screen.findByText("Detect"))

    expect(await screen.findByText("pnpm dev")).toBeOnTheScreen()
    await fireEvent.press(screen.getByText("Apply"))
    await waitFor(() =>
      expect(client.api.saveRun).toHaveBeenCalledWith("ws1", { command: "pnpm", args: ["dev"], cwd: null }),
    )
  })

  it("surfaces detect, save and start failures", async () => {
    const client = fakeClient()
    client.api.run.mockResolvedValue(config)
    client.api.detectRun.mockRejectedValue(new Error("missing"))
    client.api.saveRun.mockRejectedValue(new Error("bad"))
    client.api.startSessionRun.mockRejectedValue(new Error("boom"))
    await setup(client)

    await fireEvent.press(await screen.findByText("Detect"))
    expect(await screen.findByText(/No valid .masterhand\/run.json/)).toBeOnTheScreen()

    await fireEvent.press(screen.getByText("Edit command"))
    await fireEvent.press(screen.getByText("Save"))
    expect(await screen.findByText(/Could not save the run command/)).toBeOnTheScreen()
    await fireEvent.press(screen.getByText("Cancel"))

    await fireEvent.press(screen.getByText("Start"))
    expect(await screen.findByText(/Could not start the run server/)).toBeOnTheScreen()
  })

  it("closes on request", async () => {
    const client = fakeClient()
    const { onClose } = await setup(client)

    await fireEvent.press(await screen.findByText("Close"))

    expect(onClose).toHaveBeenCalled()
  })
})
