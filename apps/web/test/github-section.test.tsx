// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Client, GithubStatus } from "@masterhand/client-core"
import { GithubSection } from "../src/components/GithubSection"

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

function renderSection(client: Client) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <GithubSection client={client} />
    </QueryClientProvider>,
  )
}

const DISCONNECTED: GithubStatus = {
  connected: false,
  login: null,
  name: null,
  avatarUrl: null,
  scopes: [],
  updatedAt: null,
  injected: false,
  agentConfigError: null,
}

const CONNECTED: GithubStatus = {
  ...DISCONNECTED,
  connected: true,
  login: "octocat",
  name: "Octo Cat",
  avatarUrl: "https://example/avatar.png",
  updatedAt: "2026-01-01T00:00:00.000Z",
  injected: true,
}

function fakeClient(overrides: Partial<Record<"status" | "connect" | "disconnect", unknown>> = {}) {
  const github = {
    status: vi.fn(async () => DISCONNECTED),
    connect: vi.fn(async () => CONNECTED),
    disconnect: vi.fn(async () => DISCONNECTED),
    ...overrides,
  }
  return { client: { github } as unknown as Client, github }
}

describe("GithubSection", () => {
  it("connects a token and shows the account", async () => {
    const { client, github } = fakeClient()
    renderSection(client)
    expect(await screen.findByText("Connect GitHub")).toBeTruthy()

    fireEvent.change(screen.getByLabelText("Fine-grained personal access token"), {
      target: { value: "github_pat_abcdefghijklmnopqrstuvwxyz" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Connect GitHub" }))

    await waitFor(() => expect(github.connect).toHaveBeenCalledWith("github_pat_abcdefghijklmnopqrstuvwxyz"))
    expect(await screen.findByText("Octo Cat")).toBeTruthy()
    expect(screen.getByText(/@octocat/)).toBeTruthy()
  })

  it("reports a rejected token without hiding the form", async () => {
    const { client } = fakeClient({
      connect: vi.fn(async () => {
        throw new Error("nope")
      }),
    })
    renderSection(client)
    fireEvent.change(await screen.findByLabelText("Fine-grained personal access token"), {
      target: { value: "github_pat_abcdefghijklmnopqrstuvwxyz" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Connect GitHub" }))
    expect(await screen.findByText("Could not update the GitHub integration.")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Connect GitHub" })).toBeTruthy()
  })

  it("disconnects the account", async () => {
    const { client, github } = fakeClient({ status: vi.fn(async () => CONNECTED) })
    renderSection(client)
    expect(await screen.findByText("Octo Cat")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }))
    await waitFor(() => expect(github.disconnect).toHaveBeenCalled())
    expect(await screen.findByRole("button", { name: "Connect GitHub" })).toBeTruthy()
  })
})
