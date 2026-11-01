import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react-native"
import { Linking } from "react-native"
import { ApiError, queryKeys } from "@masterhand/client-core"
import { RunPreviewModal } from "../src/components/RunPreviewModal"
import {
  resetWebviewMounts,
  setNextWebViewError,
  setNextWebViewHttpError,
  webviewMounts,
} from "./mocks/react-native-webview"
import { fakeClient, makeQueryClient, QueryWrapper } from "./support/render"

beforeEach(() => {
  resetWebviewMounts()
  setNextWebViewError(null)
  setNextWebViewHttpError(null)
})

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

    expect(await screen.findByTestId("preview-webview-source")).toHaveTextContent(runningPreview.url)
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
    expect(await screen.findByTestId("preview-webview-source")).toHaveTextContent(runningPreview.url)
    expect(screen.queryByLabelText("Start preview")).toBeNull()
    expect(screen.getByLabelText("Stop preview")).toBeOnTheScreen()
  })

  it("shows the live URL and opens it while the preview runs", async () => {
    const client = fakeClient()
    client.auth.status.mockResolvedValue({ ok: true, preview: enabled })
    client.api.preview.mockResolvedValue(runningPreview)
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined as never)
    try {
      await setup(client)

      const url = await screen.findByTestId("preview-url")
      expect(url).toHaveTextContent(runningPreview.url)
      expect(url.props.selectable).toBe(true)
      await fireEvent.press(screen.getByLabelText("Open preview in browser"))

      expect(open).toHaveBeenCalledWith(runningPreview.url)
    } finally {
      open.mockRestore()
    }
  })

  it("loads the new tunnel URL after Stop and Start", async () => {
    const client = fakeClient()
    client.auth.status.mockResolvedValue({ ok: true, preview: enabled })
    const second = { ...runningPreview, url: "https://second.trycloudflare.com" }
    client.api.startPreview.mockResolvedValueOnce(runningPreview).mockResolvedValueOnce(second)
    const { queryClient } = await setup(client)
    await waitForInitialPreview(queryClient)
    await fireEvent.press(await screen.findByLabelText("Preview"))

    await fireEvent.press(screen.getByLabelText("Start preview"))
    expect(await screen.findByTestId("preview-webview-source")).toHaveTextContent(runningPreview.url)
    expect(screen.getByTestId("preview-url")).toHaveTextContent(runningPreview.url)

    await fireEvent.press(screen.getByLabelText("Stop preview"))
    expect(await screen.findByLabelText("Start preview")).toBeOnTheScreen()
    expect(screen.queryByTestId("preview-webview-source")).toBeNull()
    expect(screen.getByTestId("preview-last-url")).toHaveTextContent(runningPreview.url)
    expect(queryClient.getQueryData(queryKeys.preview("s1"))).toMatchObject({
      status: "stopped",
      lastUrl: runningPreview.url,
    })

    await fireEvent.press(screen.getByLabelText("Start preview"))
    expect(await screen.findByTestId("preview-webview-source")).toHaveTextContent(second.url)
    expect(screen.getByTestId("preview-url")).toHaveTextContent(second.url)
    expect(webviewMounts).toEqual([runningPreview.url, second.url])
  })

  it("does not let a late status fetch overwrite the new tunnel URL", async () => {
    const client = fakeClient()
    client.auth.status.mockResolvedValue({ ok: true, preview: enabled })
    const second = { ...runningPreview, url: "https://after-restart.trycloudflare.com" }
    let calls = 0
    let resolveLate!: (value: typeof runningPreview) => void
    const late = new Promise<typeof runningPreview>((resolve) => {
      resolveLate = resolve
    })
    client.api.preview.mockImplementation(() => {
      calls += 1
      if (calls === 1) return Promise.resolve(runningPreview)
      if (calls === 2) return late
      return Promise.resolve(second)
    })
    client.api.startPreview.mockResolvedValue(second)
    const { queryClient } = await setup(client)
    await waitForInitialPreview(queryClient)
    expect(await screen.findByTestId("preview-webview-source")).toHaveTextContent(runningPreview.url)

    // The WebView failure starts a status fetch that stays in flight.
    await fireEvent.press(screen.getByLabelText("Trigger WebView error"))
    await waitFor(() => expect(calls).toBe(2))

    await fireEvent.press(screen.getByLabelText("Stop preview"))
    expect(await screen.findByLabelText("Start preview")).toBeOnTheScreen()
    await fireEvent.press(screen.getByLabelText("Start preview"))
    expect(await screen.findByTestId("preview-webview-source")).toHaveTextContent(second.url)

    // Resolve the old fetch with the previous tunnel URL: it must be discarded.
    await act(async () => {
      resolveLate(runningPreview)
      await Promise.resolve()
    })

    expect(screen.getByTestId("preview-webview-source")).toHaveTextContent(second.url)
    expect(screen.getByTestId("preview-url")).toHaveTextContent(second.url)
    expect(queryClient.getQueryData(queryKeys.preview("s1"))).toMatchObject({
      status: "running",
      url: second.url,
    })
  })

  it("shows an actionable error and retries when the WebView cannot resolve the tunnel", async () => {
    const client = fakeClient()
    client.auth.status.mockResolvedValue({ ok: true, preview: enabled })
    client.api.preview.mockResolvedValue(runningPreview)
    await setup(client)

    await fireEvent.press(await screen.findByLabelText("Trigger WebView error"))

    expect(await screen.findByText("Could not load the preview.")).toBeOnTheScreen()
    expect(screen.getByTestId("preview-failure-description")).toHaveTextContent("net::ERR_NAME_NOT_RESOLVED")
    expect(screen.getByTestId("preview-failure-code")).toHaveTextContent("Error code -2")
    expect(screen.getByTestId("preview-failure-url")).toHaveTextContent(runningPreview.url)

    await fireEvent.press(screen.getByLabelText("Retry preview"))
    expect(await screen.findByTestId("preview-webview-source")).toHaveTextContent(runningPreview.url)
  })

  it("keeps the WebView failure when the status flips to error", async () => {
    const client = fakeClient()
    client.auth.status.mockResolvedValue({ ok: true, preview: enabled })
    const failingUrl = "https://failed.trycloudflare.com"
    const description = "net::ERR_CONNECTION_REFUSED"
    client.api.preview.mockResolvedValueOnce(runningPreview).mockResolvedValue({
      status: "error" as const,
      url: null,
      lastUrl: runningPreview.url,
      port: 3000,
      error: "cloudflared exited (1)",
    })
    await setup(client)
    expect(await screen.findByTestId("preview-webview-source")).toHaveTextContent(runningPreview.url)

    setNextWebViewError({ url: failingUrl, code: -2, description })
    await fireEvent.press(screen.getByLabelText("Trigger WebView error"))

    // The BFF nulls `url` and retains the old one in `lastUrl`; the panel must
    // keep the URL the WebView actually failed on.
    expect(await screen.findByLabelText("Start preview")).toBeOnTheScreen()
    const panel = screen.getByTestId("preview-failure-panel")
    expect(within(panel).getByText("Could not load the preview.")).toBeOnTheScreen()
    expect(within(panel).getByText(description)).toBeOnTheScreen()
    expect(within(panel).getByText("Error code -2")).toBeOnTheScreen()
    expect(within(panel).getByText(failingUrl)).toBeOnTheScreen()
    expect(within(panel).getByLabelText("Retry preview")).toBeOnTheScreen()
    expect(within(panel).getByLabelText("Restart preview")).toBeOnTheScreen()
    expect(within(panel).getByLabelText("Open failing URL in browser")).toBeOnTheScreen()
    expect(screen.getByTestId("preview-last-url")).toHaveTextContent(runningPreview.url)

    const refetches = (client.api.preview as jest.Mock).mock.calls.length
    await fireEvent.press(screen.getByLabelText("Retry preview"))
    await waitFor(() => expect(client.api.preview).toHaveBeenCalledTimes(refetches + 1))
    expect(screen.getByTestId("preview-failure-panel")).toBeOnTheScreen()
    expect(screen.getByTestId("preview-failure-url")).toHaveTextContent(failingUrl)
  })

  it("restarts the tunnel from the preview error to get a fresh hostname", async () => {
    const client = fakeClient()
    client.auth.status.mockResolvedValue({ ok: true, preview: enabled })
    client.api.preview.mockResolvedValue(runningPreview)
    client.api.startPreview.mockResolvedValue({
      ...runningPreview,
      url: "https://new-tunnel.trycloudflare.com",
    })
    await setup(client)

    await fireEvent.press(await screen.findByLabelText("Trigger WebView error"))
    await fireEvent.press(await screen.findByLabelText("Restart preview"))

    expect(client.api.stopPreview).toHaveBeenCalledWith("s1")
    await waitFor(() => expect(client.api.startPreview).toHaveBeenCalledWith("s1"))
    expect(await screen.findByTestId("preview-webview-source")).toHaveTextContent(
      "https://new-tunnel.trycloudflare.com",
    )
  })

  it("surfaces a failed stop on restart and does not start another tunnel", async () => {
    const client = fakeClient()
    client.auth.status.mockResolvedValue({ ok: true, preview: enabled })
    client.api.preview.mockResolvedValue(runningPreview)
    client.api.stopPreview.mockRejectedValue(new Error("nope"))
    await setup(client)

    await fireEvent.press(await screen.findByLabelText("Trigger WebView error"))
    await fireEvent.press(screen.getByLabelText("Restart preview"))

    expect(await screen.findByText("Could not stop the preview")).toBeOnTheScreen()
    expect(client.api.startPreview).not.toHaveBeenCalled()
  })

  it("reports an HTTP error from the tunnel", async () => {
    const client = fakeClient()
    client.auth.status.mockResolvedValue({ ok: true, preview: enabled })
    client.api.preview.mockResolvedValue(runningPreview)
    await setup(client)

    await fireEvent.press(await screen.findByLabelText("Trigger WebView HTTP error"))

    expect(await screen.findByText(/The tunnel answered HTTP 502/)).toBeOnTheScreen()
    expect(screen.getByTestId("preview-failure-url")).toHaveTextContent(runningPreview.url)
  })

  it("names the failing URL and status on an HTTP error", async () => {
    const client = fakeClient()
    client.auth.status.mockResolvedValue({ ok: true, preview: enabled })
    client.api.preview.mockResolvedValue(runningPreview)
    const failingUrl = "https://bad-gateway.trycloudflare.com"
    await setup(client)
    expect(await screen.findByTestId("preview-webview-source")).toHaveTextContent(runningPreview.url)

    setNextWebViewHttpError({ url: failingUrl, statusCode: 502, description: "upstream refused" })
    await fireEvent.press(screen.getByLabelText("Trigger WebView HTTP error"))

    const panel = await screen.findByTestId("preview-failure-panel")
    const status = within(panel).getByTestId("preview-failure-status")
    expect(status).toHaveTextContent(/The tunnel answered HTTP 502/)
    expect(status).toHaveTextContent(/upstream refused/)
    expect(within(panel).getByTestId("preview-failure-url")).toHaveTextContent(failingUrl)
    expect(within(panel).getByLabelText("Retry preview")).toBeOnTheScreen()
    expect(within(panel).getByLabelText("Restart preview")).toBeOnTheScreen()
    expect(within(panel).getByLabelText("Open failing URL in browser")).toBeOnTheScreen()
  })

  it("shows the server's last preview URL with an Open action after a failure", async () => {
    const client = fakeClient()
    client.auth.status.mockResolvedValue({ ok: true, preview: enabled })
    client.api.preview.mockResolvedValue({
      status: "error" as const,
      url: null,
      lastUrl: runningPreview.url,
      port: 3000,
      error: "cloudflared exited (1)",
    })
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined as never)
    try {
      await setup(client)
      await fireEvent.press(await screen.findByLabelText("Preview"))

      expect(await screen.findByText("Last preview URL")).toBeOnTheScreen()
      expect(screen.getByTestId("preview-last-url")).toHaveTextContent(runningPreview.url)
      await fireEvent.press(screen.getByLabelText("Open last preview URL in browser"))

      expect(open).toHaveBeenCalledWith(runningPreview.url)
    } finally {
      open.mockRestore()
    }
  })

  it("stops the tunnel and returns to the placeholder", async () => {
    const client = fakeClient()
    client.auth.status.mockResolvedValue({ ok: true, preview: enabled })
    client.api.preview.mockResolvedValue(runningPreview)
    await setup(client)

    await fireEvent.press(await screen.findByLabelText("Stop preview"))

    expect(client.api.stopPreview).toHaveBeenCalledWith("s1")
    expect(await screen.findByLabelText("Start preview")).toBeOnTheScreen()
    expect(screen.queryByTestId("preview-webview-source")).toBeNull()
    expect(screen.getByTestId("preview-last-url")).toHaveTextContent(runningPreview.url)
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
