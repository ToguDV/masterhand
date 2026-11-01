// @vitest-environment jsdom
import { createElement, type ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { queryKeys, type PreviewStatus, type RunStatus } from "@masterhand/client-core"
import { RunPreviewSheet } from "../src/components/RunPreviewPanel"

/**
 * Render tests for the run/preview sheet's preview lifecycle. The client
 * singleton is replaced with a scripted fake so the real query hooks run
 * without a network.
 */

const fake = vi.hoisted(() => ({
  auth: { status: vi.fn() },
  api: {
    preview: vi.fn(),
    startPreview: vi.fn(),
    stopPreview: vi.fn(),
    run: vi.fn(),
    saveRun: vi.fn(),
    detectRun: vi.fn(),
    sessionRun: vi.fn(),
    startSessionRun: vi.fn(),
    stopSessionRun: vi.fn(),
  },
}))

vi.mock("../src/client", () => ({ client: fake }))

afterEach(cleanup)

const enabled = { enabled: true, available: true, portRange: { min: 3000, max: 3010 } }

const stoppedRun: RunStatus = {
  status: "stopped",
  command: null,
  args: [],
  port: null,
  pid: null,
  error: null,
}

const firstPreview: PreviewStatus = {
  status: "running",
  url: "https://first.trycloudflare.com",
  port: 3000,
  error: null,
}

const secondPreview: PreviewStatus = {
  ...firstPreview,
  url: "https://second.trycloudflare.com",
}

beforeEach(() => {
  fake.auth.status.mockReset().mockResolvedValue({ ok: true, preview: enabled })
  fake.api.preview.mockReset().mockResolvedValue({ status: "stopped", url: null, port: null, error: null })
  fake.api.startPreview.mockReset()
  fake.api.stopPreview.mockReset().mockResolvedValue(undefined)
  fake.api.run.mockReset().mockResolvedValue(null)
  fake.api.saveRun.mockReset()
  fake.api.detectRun.mockReset()
  fake.api.sessionRun.mockReset().mockResolvedValue(stoppedRun)
  fake.api.startSessionRun.mockReset()
  fake.api.stopSessionRun.mockReset()
})

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children)
  }
  return {
    ...render(createElement(RunPreviewSheet, { sessionID: "s1", workspaceID: "ws1", onClose: vi.fn() }), {
      wrapper: Wrapper,
    }),
    queryClient,
  }
}

async function waitForPreview(queryClient: QueryClient): Promise<void> {
  await waitFor(() =>
    expect(queryClient.getQueryState(queryKeys.preview("s1"))?.status).toBe("success"),
  )
}

describe("RunPreviewSheet preview lifecycle", () => {
  it("does not let a late status fetch overwrite the new tunnel URL", async () => {
    fake.api.preview.mockReset().mockResolvedValueOnce(firstPreview).mockResolvedValue(firstPreview)
    const { queryClient } = renderPanel()
    await waitForPreview(queryClient)

    // The running preview auto-opens the Preview tab.
    expect(await screen.findByTitle("Session preview")).toBeTruthy()
    expect(screen.getByTitle("Session preview").getAttribute("src")).toBe(firstPreview.url)

    // A status poll starts before the stop/start and stays in flight.
    let resolveLateBeforeStop!: (value: PreviewStatus) => void
    const lateBeforeStop = new Promise<PreviewStatus>((resolve) => {
      resolveLateBeforeStop = resolve
    })
    fake.api.preview.mockImplementationOnce(() => lateBeforeStop)
    let refetchBeforeStop!: Promise<unknown>
    await act(async () => {
      refetchBeforeStop = queryClient.refetchQueries({ queryKey: queryKeys.preview("s1"), exact: true })
    })
    await waitFor(() => expect(fake.api.preview).toHaveBeenCalledTimes(2))

    fireEvent.click(screen.getByLabelText("Stop preview"))

    expect(await screen.findByLabelText("Start preview")).toBeTruthy()
    expect(screen.getByText("Last preview URL")).toBeTruthy()
    expect(screen.getByLabelText("Open last preview URL").getAttribute("href")).toBe(firstPreview.url)
    expect(queryClient.getQueryData(queryKeys.preview("s1"))).toMatchObject({
      status: "stopped",
      lastUrl: firstPreview.url,
    })

    // Start resolves while a second status fetch is in flight: that fetch
    // captured the pre-start state and must not win when it resolves.
    let resolveStart!: (value: PreviewStatus) => void
    const startResponse = new Promise<PreviewStatus>((resolve) => {
      resolveStart = resolve
    })
    fake.api.startPreview.mockReturnValueOnce(startResponse)
    fireEvent.click(screen.getByLabelText("Start preview"))
    await waitFor(() => expect(fake.api.startPreview).toHaveBeenCalledWith("s1"))

    let resolveLateDuringStart!: (value: PreviewStatus) => void
    const lateDuringStart = new Promise<PreviewStatus>((resolve) => {
      resolveLateDuringStart = resolve
    })
    fake.api.preview.mockImplementationOnce(() => lateDuringStart)
    let refetchDuringStart!: Promise<unknown>
    await act(async () => {
      refetchDuringStart = queryClient.refetchQueries({ queryKey: queryKeys.preview("s1"), exact: true })
    })
    await waitFor(() => expect(fake.api.preview).toHaveBeenCalledTimes(3))

    await act(async () => {
      resolveStart(secondPreview)
      await startResponse
    })

    expect(await screen.findByTitle("Session preview")).toBeTruthy()
    expect(screen.getByTitle("Session preview").getAttribute("src")).toBe(secondPreview.url)
    expect(screen.getByLabelText("Open preview").getAttribute("href")).toBe(secondPreview.url)

    // Both stale fetches resolve with the previous tunnel URL: discard them.
    await act(async () => {
      resolveLateBeforeStop(firstPreview)
      resolveLateDuringStart(firstPreview)
      await Promise.allSettled([refetchBeforeStop, refetchDuringStart])
    })

    expect(queryClient.getQueryData(queryKeys.preview("s1"))).toMatchObject({
      status: "running",
      url: secondPreview.url,
    })
    expect(screen.getByTitle("Session preview").getAttribute("src")).toBe(secondPreview.url)
  })

  it("shows the retained URL, clearly labelled, after the preview errors", async () => {
    const lastUrl = "https://failed.trycloudflare.com"
    fake.api.preview.mockResolvedValue({
      status: "error",
      url: null,
      lastUrl,
      port: 3000,
      error: "cloudflared exited (1)",
    })
    const { queryClient } = renderPanel()
    await waitForPreview(queryClient)

    fireEvent.click(screen.getByRole("tab", { name: "Preview" }))

    const openLast = await screen.findByLabelText("Open last preview URL")
    expect(openLast.getAttribute("href")).toBe(lastUrl)
    expect(screen.getByText("Last preview URL")).toBeTruthy()
    expect(screen.getByText(lastUrl)).toBeTruthy()
    expect(screen.queryByLabelText("Open preview")).toBeNull()
    expect(screen.queryByTitle("Session preview")).toBeNull()
    expect(screen.getByRole("status").textContent).toContain("cloudflared exited (1)")
  })
})
