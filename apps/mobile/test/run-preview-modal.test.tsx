import { fireEvent, render, screen, waitFor } from "@testing-library/react-native"
import { ApiError, queryKeys } from "@masterhand/client-core"
import { RunPreviewModal } from "../src/components/RunPreviewModal"
import { fakeClient, makeQueryClient, QueryWrapper } from "./support/render"

async function setup(client = fakeClient(), onClose = jest.fn()) {
  const queryClient = makeQueryClient()
  await render(
    <RunPreviewModal client={client} sessionID="s1" workspaceID="ws1" onClose={onClose} />,
    { wrapper: ({ children }) => <QueryWrapper client={queryClient}>{children}</QueryWrapper> },
  )
  return { client, onClose, queryClient }
}

/**
 * Wait until the initial `preview` fetch has settled. Pressing Start before that
 * is a race: the in-flight fetch can resolve `stopped` right after the modal
 * stores the started status, sending it back to the placeholder.
 */
async function waitForInitialPreview(queryClient: ReturnType<typeof makeQueryClient>) {
  await waitFor(() =>
    expect(queryClient.getQueryState(queryKeys.preview("s1"))?.status).toBe("success"),
  )
}

const config = {
  command: "npm",
  args: ["run", "dev", "--", "--port", "{port}"],
  cwd: null,
  source: "user" as const,
  updatedAt: 1,
}

const runningRun = {
  status: "running" as const,
  command: "npm",
  args: ["run", "dev", "--", "--port", "3200"],
  port: 3200,
  pid: 42,
  error: null,
}

const runningPreview = {
  status: "running" as const,
  url: "https://abc.trycloudflare.com",
  port: 3000,
  error: null,
}

const enabled = { enabled: true, available: true, portRange: { min: 3000, max: 3010 } }

describe("RunPreviewModal — one control, two tabs (#99)", () => {
  it("shows both tabs and switches between them without forcing a tab", async () => {
    const client = fakeClient()
    client.api.run.mockResolvedValue(config)
    client.auth.status.mockResolvedValue({ ok: true, preview: enabled })
    await setup(client)

    expect(await screen.findByText("npm run dev -- --port {port}")).toBeOnTheScreen()
    // Default lands on Run (the preview is not running).
    expect(screen.getByLabelText("Run").props.accessibilityState.selected).toBe(true)

    await fireEvent.press(await screen.findByLabelText("Preview"))
    expect(screen.getByLabelText("Preview").props.accessibilityState.selected).toBe(true)
    expect(screen.getByLabelText("Start preview")).toBeOnTheScreen()

    await fireEvent.press(screen.getByLabelText("Run"))
    expect(screen.getByLabelText("Start run")).toBeOnTheScreen()
  })

  it("opens on Preview when the tunnel is already running", async () => {
    const client = fakeClient()
    client.auth.status.mockResolvedValue({ ok: true, preview: enabled })
    client.api.preview.mockResolvedValue(runningPreview)
    await setup(client)

    expect(await screen.findByText("WebView: https://abc.trycloudflare.com")).toBeOnTheScreen()
    expect(screen.getByLabelText("Stop preview")).toBeOnTheScreen()
  })

  it("shows the configured command and starts the run server", async () => {
    const client = fakeClient()
    client.api.run.mockResolvedValue(config)
    client.api.startSessionRun.mockResolvedValue(runningRun)
    await setup(client)

    expect(await screen.findByText("npm run dev -- --port {port}")).toBeOnTheScreen()
    await fireEvent.press(screen.getByLabelText("Start run"))

    expect(client.api.startSessionRun).toHaveBeenCalledWith("s1", "ws1")
    expect(await screen.findByLabelText("Stop run")).toBeOnTheScreen()
  })

  it("stops a running server and reports a failed stop", async () => {
    const client = fakeClient()
    client.api.run.mockResolvedValue(config)
    client.api.sessionRun.mockResolvedValue(runningRun)
    client.api.stopSessionRun.mockRejectedValue(new Error("nope"))
    await setup(client)

    await fireEvent.press(await screen.findByLabelText("Stop run"))

    expect(client.api.stopSessionRun).toHaveBeenCalledWith("s1", "ws1")
    expect(await screen.findByText("Could not stop the run server")).toBeOnTheScreen()
  })

  it("edits and saves the command as argv lines", async () => {
    const client = fakeClient()
    await setup(client)

    expect(await screen.findByText(/No run command configured/)).toBeOnTheScreen()
    await fireEvent.press(screen.getByLabelText("Edit command"))
    await fireEvent.changeText(screen.getByPlaceholderText("npm"), "pnpm")
    await fireEvent.changeText(screen.getByPlaceholderText(/^run/), "dev\n--port\n{port}")
    await fireEvent.press(screen.getByLabelText("Save run command"))

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

    await fireEvent.press(await screen.findByLabelText("Detect"))

    expect(await screen.findByText("pnpm dev")).toBeOnTheScreen()
    await fireEvent.press(screen.getByLabelText("Apply detected run command"))
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

    await fireEvent.press(await screen.findByLabelText("Detect"))
    expect(await screen.findByText(/No valid .masterhand\/run.json/)).toBeOnTheScreen()

    await fireEvent.press(screen.getByLabelText("Edit command"))
    await fireEvent.press(screen.getByLabelText("Save run command"))
    expect(await screen.findByText(/Could not save the run command/)).toBeOnTheScreen()
    await fireEvent.press(screen.getByLabelText("Cancel run command edit"))

    await fireEvent.press(screen.getByLabelText("Start run"))
    expect(await screen.findByText(/Could not start the run server/)).toBeOnTheScreen()
  })

  it("offers Start and points at the reserved port when the preview is stopped", async () => {
    const client = fakeClient()
    client.auth.status.mockResolvedValue({ ok: true, preview: enabled })
    await setup(client)
    await fireEvent.press(await screen.findByLabelText("Preview"))

    expect(await screen.findByLabelText("Start preview")).toBeOnTheScreen()
    expect(await screen.findByText(/port 3000/)).toBeOnTheScreen()
  })

  it("starts the tunnel and renders the WebView", async () => {
    const client = fakeClient()
    client.auth.status.mockResolvedValue({ ok: true, preview: enabled })
    client.api.startPreview.mockResolvedValue(runningPreview)
    const { queryClient } = await setup(client)
    await waitForInitialPreview(queryClient)
    await fireEvent.press(await screen.findByLabelText("Preview"))

    await fireEvent.press(screen.getByLabelText("Start preview"))

    expect(client.api.startPreview).toHaveBeenCalledWith("s1")
    expect(await screen.findByText("WebView: https://abc.trycloudflare.com")).toBeOnTheScreen()
    expect(screen.queryByLabelText("Start preview")).toBeNull()
    expect(screen.getByLabelText("Stop preview")).toBeOnTheScreen()
  })

  it("stops the tunnel and returns to the placeholder", async () => {
    const client = fakeClient()
    client.auth.status.mockResolvedValue({ ok: true, preview: enabled })
    client.api.preview.mockResolvedValue(runningPreview)
    await setup(client)

    await fireEvent.press(await screen.findByLabelText("Stop preview"))

    expect(client.api.stopPreview).toHaveBeenCalledWith("s1")
    expect(await screen.findByLabelText("Start preview")).toBeOnTheScreen()
    expect(screen.queryByText(/WebView:/)).toBeNull()
  })

  it("explains when cloudflared is unavailable", async () => {
    const client = fakeClient()
    client.auth.status.mockResolvedValue({
      ok: true,
      preview: { enabled: true, available: false, portRange: { min: 3000, max: 3010 } },
    })
    await setup(client)
    await fireEvent.press(await screen.findByLabelText("Preview"))

    expect(await screen.findByText(/cloudflared is not available/)).toBeOnTheScreen()
    expect(screen.queryByLabelText("Start preview")).toBeNull()
  })

  it("surfaces a preview start failure", async () => {
    const client = fakeClient()
    client.auth.status.mockResolvedValue({ ok: true, preview: enabled })
    client.api.startPreview.mockRejectedValue(
      new ApiError(409, JSON.stringify({ error: "preview_not_running" })),
    )
    await setup(client)
    await fireEvent.press(await screen.findByLabelText("Preview"))

    await fireEvent.press(screen.getByLabelText("Start preview"))

    expect(await screen.findByText(/The agent has not started a web server yet/)).toBeOnTheScreen()
    // Still stopped, and the button is retryable.
    expect(screen.getByLabelText("Start preview")).toBeOnTheScreen()
  })

  it("reports a failed stop", async () => {
    const client = fakeClient()
    client.auth.status.mockResolvedValue({ ok: true, preview: enabled })
    client.api.preview.mockResolvedValue(runningPreview)
    client.api.stopPreview.mockRejectedValue(new Error("nope"))
    await setup(client)

    await fireEvent.press(await screen.findByLabelText("Stop preview"))

    expect(await screen.findByText("Could not stop the preview")).toBeOnTheScreen()
  })

  it("shows the starting placeholder while the tunnel boots", async () => {
    const client = fakeClient()
    client.auth.status.mockResolvedValue({ ok: true, preview: enabled })
    client.api.preview.mockResolvedValue({ status: "starting", url: null, port: 3000, error: null })
    await setup(client)
    await fireEvent.press(await screen.findByLabelText("Preview"))

    expect(await screen.findByText("Starting the tunnel…")).toBeOnTheScreen()
  })

  it("closes on request", async () => {
    const client = fakeClient()
    const { onClose } = await setup(client)

    await fireEvent.press(await screen.findByLabelText("Close run and preview"))

    expect(onClose).toHaveBeenCalled()
  })
})
