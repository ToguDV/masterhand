import { act, fireEvent, render, screen } from "@testing-library/react-native"
import { ApiError, type AgentInfo, type ModelInfo, type ProviderInfo, type SlashCommand } from "@masterhand/client-core"
import { Composer } from "../src/components/Composer"
import { loadSessionPreferences } from "../src/storage"
import { fakeClient, makeQueryClient, QueryWrapper } from "./support/render"

jest.mock("../src/storage", () => ({
  loadSessionPreferences: jest.fn(async () => ({})),
  saveSessionPreferences: jest.fn(async () => {}),
}))

const loadPreferences = loadSessionPreferences as unknown as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  loadPreferences.mockResolvedValue({})
})

const agents: AgentInfo[] = [
  { id: "build", name: "Build", mode: "primary" },
  { id: "explore", name: "Explore", mode: "primary" },
  { id: "general", name: "General", mode: "subagent" },
  { id: "tester", name: "Tester", mode: "subagent" },
] as unknown as AgentInfo[]

const providers: ProviderInfo[] = [{ id: "test", name: "Test" }] as unknown as ProviderInfo[]

const models: ModelInfo[] = [
  { id: "test-model", providerID: "test", name: "Test Model", variants: [{ id: "low" }, { id: "high" }], enabled: true },
  { id: "alpha", providerID: "test", name: "Alpha", variants: [], enabled: true },
] as unknown as ModelInfo[]

async function setup(
  props: Partial<React.ComponentProps<typeof Composer>> = {},
  options: { commands?: SlashCommand[] } = {},
) {
  const client = fakeClient()
  client.api.agents.mockResolvedValue(agents)
  client.api.commands.mockResolvedValue(options.commands ?? [])
  client.api.models.mockResolvedValue({ models, providers, defaultModel: models[0] })
  await render(
    <Composer
      client={client}
      sessionID="s1"
      busy={false}
      workspaceID={null}
      autoAccept={false}
      onToggleAutoAccept={jest.fn()}
      {...props}
    />,
    { wrapper: ({ children }) => <QueryWrapper client={makeQueryClient()}>{children}</QueryWrapper> },
  )
  return { client }
}

describe("Composer", () => {
  it("shows the default agent and model from the catalog", async () => {
    await setup()

    expect(await screen.findByText("Build")).toBeOnTheScreen()
    expect(screen.getByText("Test · Test Model")).toBeOnTheScreen()
  })

  it("sends the typed prompt with the selected agent and model", async () => {
    const { client } = await setup()

    await fireEvent.changeText(await screen.findByPlaceholderText("Write a message…"), "hello")
    await fireEvent.press(screen.getByText("Send"))

    expect(client.api.prompt).toHaveBeenCalledWith(
      "s1",
      { text: "hello", agent: "build", model: { providerID: "test", id: "test-model" } },
      { agent: undefined, model: undefined },
    )
  })

  it("cannot send an empty prompt", async () => {
    const { client } = await setup()

    await fireEvent.press(await screen.findByText("Send"))

    expect(client.api.prompt).not.toHaveBeenCalled()
  })

  it("ignores a second submit dispatched in the same tick", async () => {
    const { client } = await setup()
    let resolvePrompt: (() => void) | undefined
    client.api.prompt.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolvePrompt = resolve
        }),
    )

    await fireEvent.changeText(await screen.findByPlaceholderText("Write a message…"), "hello")
    const send = screen.getByText("Send")

    // Two presses without React committing `sending` in between: the state flag
    // alone lets both through, so the composer must hold a synchronous lock.
    await act(async () => {
      fireEvent.press(send)
      fireEvent.press(send)
    })

    expect(client.api.prompt).toHaveBeenCalledTimes(1)
    await act(async () => resolvePrompt?.())
  })

  it("shows Stop while busy and aborts the session", async () => {
    const { client } = await setup({ busy: true })

    await fireEvent.press(await screen.findByText("Stop"))

    expect(client.api.abortSession).toHaveBeenCalledWith("s1")
    expect(screen.queryByText("Send")).toBeNull()
  })

  it("toggles auto-accept", async () => {
    const onToggleAutoAccept = jest.fn()
    await setup({ onToggleAutoAccept })

    await fireEvent.press(await screen.findByText("auto-accept"))

    expect(onToggleAutoAccept).toHaveBeenCalledWith(true)
  })

  it("switches the model through the picker", async () => {
    const { client } = await setup()

    await fireEvent.press(await screen.findByText("Test · Test Model"))
    await fireEvent.press(screen.getByText("Test · Alpha"))
    await fireEvent.changeText(screen.getByPlaceholderText("Write a message…"), "hi")
    await fireEvent.press(screen.getByText("Send"))

    expect(client.api.prompt).toHaveBeenCalledWith(
      "s1",
      { text: "hi", agent: "build", model: { providerID: "test", id: "alpha" } },
      { agent: undefined, model: undefined },
    )
  })

  it("offers the effort variants of the selected model", async () => {
    const { client } = await setup()

    await fireEvent.press(await screen.findByText("effort: default"))
    await fireEvent.press(screen.getByText("High"))
    await fireEvent.changeText(screen.getByPlaceholderText("Write a message…"), "go")
    await fireEvent.press(screen.getByText("Send"))

    expect(client.api.prompt).toHaveBeenCalledWith(
      "s1",
      { text: "go", agent: "build", model: { providerID: "test", id: "test-model", variant: "high" } },
      { agent: undefined, model: undefined },
    )
  })

  it("reports a failed send with the HTTP status", async () => {
    const { client } = await setup()
    client.api.prompt.mockRejectedValue(new ApiError(500, "x"))

    await fireEvent.changeText(await screen.findByPlaceholderText("Write a message…"), "hi")
    await fireEvent.press(screen.getByText("Send"))

    expect(await screen.findByText("Could not send (HTTP 500)")).toBeOnTheScreen()
  })

  it("reports a network failure to send", async () => {
    const { client } = await setup()
    client.api.prompt.mockRejectedValue(new Error("offline"))

    await fireEvent.changeText(await screen.findByPlaceholderText("Write a message…"), "hi")
    await fireEvent.press(screen.getByText("Send"))

    expect(await screen.findByText("Could not send")).toBeOnTheScreen()
  })

  it("switches the agent through the picker", async () => {
    const { client } = await setup()

    await fireEvent.press(await screen.findByText("Build"))
    await fireEvent.press(await screen.findByText("Explore"))
    await fireEvent.changeText(screen.getByPlaceholderText("Write a message…"), "go")
    await fireEvent.press(screen.getByText("Send"))

    expect(client.api.prompt).toHaveBeenCalledWith(
      "s1",
      { text: "go", agent: "explore", model: { providerID: "test", id: "test-model" } },
      { agent: undefined, model: undefined },
    )
  })

  it("restores the saved per-session selection", async () => {
    loadPreferences.mockResolvedValue({ agent: "explore", model: "test/alpha" })
    await setup()

    expect(await screen.findByText("Explore")).toBeOnTheScreen()
    expect(screen.getByText("Test · Alpha")).toBeOnTheScreen()
  })

  it("opens the command list on / and runs the selected command", async () => {
    const commands: SlashCommand[] = [
      {
        name: "review",
        description: "review changes [commit|branch|pr]",
        arguments: [{ position: 1, freeForm: false, suggestions: ["commit", "branch", "pr"] }],
      },
    ]
    const { client } = await setup({}, { commands })
    const input = await screen.findByPlaceholderText("Write a message…")

    await fireEvent.changeText(input, "/rev")
    await fireEvent.press(await screen.findByText("/review"))

    // Argument suggestions only surface values that match the typed content.
    await fireEvent.changeText(input, "/review c")
    await fireEvent.press(await screen.findByText("commit"))
    expect(input.props.value).toBe("/review commit ")
    // Picking a value closes the list instead of re-suggesting it forever.
    expect(screen.queryByText("branch")).toBeNull()

    await fireEvent.press(screen.getByText("Send"))

    expect(client.api.runCommand).toHaveBeenCalledWith(
      "s1",
      { name: "review", text: "commit", agent: "build", model: { providerID: "test", id: "test-model" } },
      { agent: undefined, model: undefined },
    )
    expect(client.api.prompt).not.toHaveBeenCalled()
  })

  it("lists every argument value while the parameter is empty", async () => {
    const commands: SlashCommand[] = [
      {
        name: "review",
        description: "review changes [commit|branch|pr]",
        arguments: [{ position: 1, freeForm: false, suggestions: ["commit", "branch", "pr"] }],
      },
    ]
    await setup({}, { commands })
    const input = await screen.findByPlaceholderText("Write a message…")

    await fireEvent.changeText(input, "/rev")
    await fireEvent.press(await screen.findByText("/review"))

    // Picking the command leaves an empty parameter: list all of its values.
    expect(await screen.findByText("commit")).toBeOnTheScreen()
    expect(screen.getByText("branch")).toBeOnTheScreen()
    expect(screen.getByText("pr")).toBeOnTheScreen()
  })

  it("hides argument suggestions that do not match the typed content", async () => {
    const commands: SlashCommand[] = [
      {
        name: "review",
        description: "review changes [commit|branch|pr]",
        arguments: [{ position: 1, freeForm: false, suggestions: ["commit", "branch", "pr"] }],
      },
    ]
    await setup({}, { commands })
    const input = await screen.findByPlaceholderText("Write a message…")

    await fireEvent.changeText(input, "/rev")
    await fireEvent.press(await screen.findByText("/review"))
    await fireEvent.changeText(input, "/review zzz")

    expect(screen.queryByText("commit")).toBeNull()
  })

  it("dismisses suggestions on blur and restores them on focus", async () => {
    const commands: SlashCommand[] = [
      {
        name: "review",
        description: "review changes [commit|branch|pr]",
        arguments: [{ position: 1, freeForm: false, suggestions: ["commit", "branch", "pr"] }],
      },
    ]
    await setup({}, { commands })
    const input = await screen.findByPlaceholderText("Write a message…")

    await fireEvent.changeText(input, "/rev")
    expect(await screen.findByText("/review")).toBeOnTheScreen()

    await fireEvent(input, "blur")
    expect(screen.queryByText("/review")).toBeNull()

    await fireEvent(input, "focus")
    expect(await screen.findByText("/review")).toBeOnTheScreen()
  })

  it("opens the subagent list on @ and attaches the mention", async () => {
    const { client } = await setup()

    await fireEvent.changeText(await screen.findByPlaceholderText("Write a message…"), "@gen")
    await fireEvent.press(await screen.findByText("@general"))
    await fireEvent.changeText(screen.getByPlaceholderText("Write a message…"), "@general hello")
    await fireEvent.press(screen.getByText("Send"))

    expect(client.api.prompt).toHaveBeenCalledWith(
      "s1",
      {
        text: "@general hello",
        agent: "build",
        model: { providerID: "test", id: "test-model" },
        agents: [{ name: "general", mention: { start: 0, end: 8, text: "@general" } }],
      },
      { agent: undefined, model: undefined },
    )
  })

  it("runs /btw in a forked session and discards it on close", async () => {
    const { client } = await setup()

    await fireEvent.changeText(await screen.findByPlaceholderText("Write a message…"), "/btw what changed?")
    await fireEvent.press(screen.getByText("Send"))

    expect(client.api.forkSession).toHaveBeenCalledWith("s1")
    expect(client.api.prompt).toHaveBeenCalledWith("fork_1", {
      text: "what changed?",
      agent: "build",
      model: { providerID: "test", id: "test-model" },
    })
    expect(await screen.findByText("Side question")).toBeOnTheScreen()

    await fireEvent.press(screen.getByText("Close"))
    expect(client.api.removeSession).toHaveBeenCalledWith("fork_1")
  })
})
