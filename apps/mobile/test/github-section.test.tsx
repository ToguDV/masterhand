import { Linking } from "react-native"
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ApiError, RequestTimeoutError, type Client, type GithubStatus } from "@masterhand/client-core"
import { GithubSection, githubErrorMessage } from "../src/components/GithubSection"

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
  updatedAt: "2026-01-01T00:00:00.000Z",
  injected: true,
}

function fakeClient(overrides: Partial<Record<"status" | "connect" | "disconnect", unknown>> = {}) {
  const github = {
    status: jest.fn(async () => DISCONNECTED),
    connect: jest.fn(async () => CONNECTED),
    disconnect: jest.fn(async () => DISCONNECTED),
    ...overrides,
  }
  return { client: { github } as unknown as Client, github }
}

describe("GithubSection", () => {
  it("connects a token and shows the account", async () => {
    const { client, github } = fakeClient()
    await renderSection(client)
    const input = await screen.findByLabelText("Fine-grained personal access token")
    await fireEvent.changeText(input, "github_pat_abcdefghijklmnopqrstuvwxyz")
    await fireEvent.press(screen.getByLabelText("Connect GitHub"))

    await waitFor(() => expect(github.connect).toHaveBeenCalledWith("github_pat_abcdefghijklmnopqrstuvwxyz"))
    expect(await screen.findByText("Octo Cat")).toBeOnTheScreen()
    expect(screen.getByText(/@octocat/)).toBeOnTheScreen()
  })

  it("disconnects the account", async () => {
    const { client, github } = fakeClient({ status: jest.fn(async () => CONNECTED) })
    await renderSection(client)
    expect(await screen.findByText("Octo Cat")).toBeOnTheScreen()
    await fireEvent.press(screen.getByLabelText("Disconnect GitHub"))
    await waitFor(() => expect(github.disconnect).toHaveBeenCalled())
    expect(await screen.findByLabelText("Connect GitHub")).toBeOnTheScreen()
  })
})

describe("GithubSection states", () => {
  it("maps failures to actionable copy", () => {
    expect(githubErrorMessage(new ApiError(400, "bad"))).toMatch(/GitHub rejected that token/)
    expect(githubErrorMessage(new ApiError(404, "missing"))).toMatch(/does not support GitHub integration/)
    expect(githubErrorMessage(new ApiError(502, "down"))).toMatch(/Could not reach GitHub/)
    expect(githubErrorMessage(new ApiError(502, JSON.stringify({ error: "github_rejected" })))).toMatch(/permissions|rate limit/)
    expect(githubErrorMessage(new RequestTimeoutError())).toMatch(/did not answer in time/)
    expect(githubErrorMessage(new Error("boom"))).toMatch(/Could not update the GitHub integration/)
  })

  it("shows a load error without hiding the form", async () => {
    const { client } = fakeClient({ status: jest.fn(async () => { throw new ApiError(404, "missing") }) })
    await renderSection(client)
    expect(await screen.findByText(/does not support GitHub integration/)).toBeOnTheScreen()
  })

  it("warns when a failed disconnect left credential files behind", async () => {
    const { client } = fakeClient({
      status: jest.fn(async () => ({ ...DISCONNECTED, agentConfigError: "EACCES" })),
    })
    await renderSection(client)
    expect(await screen.findByText(/Credential cleanup failed: EACCES/)).toBeOnTheScreen()
  })

  it("warns when the token is saved but injection failed", async () => {
    const { client } = fakeClient({
      status: jest.fn(async () => ({
        ...CONNECTED,
        updatedAt: null,
        injected: false,
        agentConfigError: "AGENT_CONFIG_DIR is not configured",
      })),
    })
    await renderSection(client)
    expect(await screen.findByText(/agent container has not received it/)).toBeOnTheScreen()
    expect(screen.getByText(/connected just now/)).toBeOnTheScreen()
  })

  it("reconciles a timed-out connect through the status endpoint", async () => {
    const status = jest.fn().mockResolvedValueOnce(DISCONNECTED).mockResolvedValue(CONNECTED)
    const { client, github } = fakeClient({
      status,
      connect: jest.fn(async () => {
        throw new RequestTimeoutError()
      }),
    })
    await renderSection(client)
    await fireEvent.changeText(await screen.findByLabelText("Fine-grained personal access token"), "github_pat_abcdefghijklmnopqrstuvwxyz")
    await fireEvent.press(screen.getByLabelText("Connect GitHub"))
    expect(await screen.findByText("Octo Cat")).toBeOnTheScreen()
    expect(github.connect).toHaveBeenCalled()
  })

  it("replaces or cancels the token and opens the token page", async () => {
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined)
    const { client } = fakeClient({ status: jest.fn(async () => CONNECTED) })
    await renderSection(client)
    await fireEvent.press(await screen.findByLabelText("Replace GitHub token"))
    expect(screen.getByText("Cancel")).toBeOnTheScreen()
    await fireEvent.press(screen.getByText("Cancel"))
    expect(screen.queryByText("Cancel")).toBeNull()
    await fireEvent.press(screen.getByLabelText("Replace GitHub token"))
    await fireEvent.press(screen.getByLabelText("Create a GitHub token"))
    expect(open).toHaveBeenCalledWith("https://github.com/settings/personal-access-tokens/new")
    open.mockRestore()
  })
})
