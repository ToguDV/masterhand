import { useEffect, useRef } from "react"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native"
import {
  ApiError,
  RequestTimeoutError,
  queryKeys,
  usePendingSend,
  type AgentInfo,
  type ChatMessage,
  type ModelInfo,
  type PendingSendController,
  type ProviderInfo,
  type SlashCommand,
} from "@masterhand/client-core"
import { Composer } from "../src/components/Composer"
import { loadSessionPreferences } from "../src/storage"
import { palettes } from "../src/theme"
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

/**
 * Wraps the composer with the real `usePendingSend` controller (the chat
 * container's job) so the delivery reconciliation is exercised end to end.
 * `onController` hands the latest controller to the test after each commit.
 */
function ComposerHarness({
  client,
  onController,
  ...props
}: Omit<React.ComponentProps<typeof Composer>, "ref" | "sessionID" | "pending"> & {
  onController: (controller: PendingSendController) => void
}) {
  const pending = usePendingSend("s1")
  const notify = useRef(onController)
  notify.current = onController
  useEffect(() => {
    notify.current(pending)
  })
  return <Composer client={client} sessionID="s1" pending={pending} {...props} />
}

async function setup(
  props: Partial<React.ComponentProps<typeof Composer>> = {},
  options: { commands?: SlashCommand[] } = {},
) {
  const client = fakeClient()
  const queryClient = makeQueryClient()
  client.api.agents.mockResolvedValue(agents)
  client.api.commands.mockResolvedValue(options.commands ?? [])
  client.api.models.mockResolvedValue({ models, providers, defaultModel: models[0] })
  let controller: PendingSendController | null = null
  const view = await render(
    <ComposerHarness
      client={client}
      busy={false}
      workspaceID={null}
      autoAccept={false}
      onToggleAutoAccept={jest.fn()}
      onController={(next) => {
        controller = next
      }}
      {...props}
    />,
    { wrapper: ({ children }) => <QueryWrapper client={queryClient}>{children}</QueryWrapper> },
  )
  return {
    client,
    queryClient,
    view,
    get pending(): PendingSendController {
      if (!controller) throw new Error("pending controller not captured")
      return controller
    },
  }
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
      expect.objectContaining({ text: "hello", agent: "build", model: { providerID: "test", id: "test-model" } }),
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
      expect.objectContaining({ text: "hi", agent: "build", model: { providerID: "test", id: "alpha" } }),
      { agent: undefined, model: undefined },
    )
  })

  it("offers the effort variants of the selected model", async () => {
    const { client } = await setup()

    await fireEvent.press(await screen.findByLabelText("Effort"))
    await fireEvent.press(screen.getByText("High"))
    await fireEvent.changeText(screen.getByPlaceholderText("Write a message…"), "go")
    await fireEvent.press(screen.getByText("Send"))

    expect(client.api.prompt).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({
        text: "go",
        agent: "build",
        model: { providerID: "test", id: "test-model", variant: "high" },
      }),
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

  it("maps a timed-out send to an explicit may-not-have-been-sent warning", async () => {
    const { client } = await setup()
    client.api.prompt.mockRejectedValue(new RequestTimeoutError())

    await fireEvent.changeText(await screen.findByPlaceholderText("Write a message…"), "hi")
    await fireEvent.press(screen.getByText("Send"))

    expect(await screen.findByText(/your message may not have been sent/)).toBeOnTheScreen()
    // The text survives so the user can check the chat before retrying.
    expect(screen.getByPlaceholderText("Write a message…").props.value).toBe("hi")
  })

  it("tracks a plain prompt in the pending controller (#125)", async () => {
    const ctx = await setup()

    await fireEvent.changeText(await screen.findByPlaceholderText("Write a message…"), "hello")
    await fireEvent.press(screen.getByText("Send"))

    await waitFor(() =>
      expect(ctx.pending.pending).toEqual({
        text: "hello",
        marker: expect.stringMatching(/^delivery_/),
        status: "sending",
      }),
    )
  })

  it("fails the pending send on a hard error but not on an ambiguous timeout (#125)", async () => {
    const ctx = await setup()
    const { client } = ctx
    client.api.prompt.mockRejectedValueOnce(new ApiError(500, "x"))

    await fireEvent.changeText(await screen.findByPlaceholderText("Write a message…"), "one")
    await fireEvent.press(screen.getByText("Send"))
    await screen.findByText("Could not send (HTTP 500)")
    await waitFor(() => expect(ctx.pending.pending?.status).toBe("failed"))

    // An ambiguous timeout keeps the ghost reconciling against the history.
    client.api.prompt.mockRejectedValueOnce(new RequestTimeoutError())
    await fireEvent.changeText(screen.getByPlaceholderText("Write a message…"), "two")
    await fireEvent.press(screen.getByText("Send"))
    await screen.findByText(/your message may not have been sent/)
    await waitFor(() => expect(ctx.pending.pending).toMatchObject({ text: "two", status: "sending" }))
  })

  it("keeps text typed while a slow send is in flight", async () => {
    const { client } = await setup()
    let resolvePrompt: (() => void) | undefined
    client.api.prompt.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolvePrompt = resolve
        }),
    )

    const input = await screen.findByPlaceholderText("Write a message…")
    await fireEvent.changeText(input, "hello")
    await fireEvent.press(screen.getByText("Send"))
    await fireEvent.changeText(input, "follow up")

    await act(async () => resolvePrompt?.())

    expect(input.props.value).toBe("follow up")
  })

  it("releases the composer as soon as the marked message appears in the history", async () => {
    const { client, queryClient } = await setup()
    client.api.prompt.mockImplementation(() => new Promise<void>(() => {}))

    const input = await screen.findByPlaceholderText("Write a message…")
    await fireEvent.changeText(input, "hello")
    await fireEvent.press(screen.getByText("Send"))

    const marker = (
      client.api.prompt.mock.calls[0]?.[1] as { metadata: Record<string, string> }
    ).metadata["masterhand.delivery"]
    await act(async () => {
      queryClient.setQueryData<ChatMessage[]>(queryKeys.messages("s1"), [
        {
          info: {
            id: "msg_live",
            sessionID: "s1",
            role: "user",
            time: { created: Date.now() },
            metadata: { "masterhand.delivery": marker },
          },
          parts: [],
        },
      ])
    })

    expect(input.props.value).toBe("")
  })

  it("switches the agent through the picker", async () => {
    const { client } = await setup()

    await fireEvent.press(await screen.findByText("Build"))
    await fireEvent.press(await screen.findByText("Explore"))
    await fireEvent.changeText(screen.getByPlaceholderText("Write a message…"), "go")
    await fireEvent.press(screen.getByText("Send"))

    expect(client.api.prompt).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ text: "go", agent: "explore", model: { providerID: "test", id: "test-model" } }),
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

  it("keeps slash commands out of the ghost bubble (#125)", async () => {
    const commands: SlashCommand[] = [{ name: "compact", description: "compact history", arguments: [] }]
    const ctx = await setup({}, { commands })

    await fireEvent.changeText(await screen.findByPlaceholderText("Write a message…"), "/compact")
    await fireEvent.press(screen.getByText("Send"))

    expect(ctx.pending.pending).toBeNull()
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
      expect.objectContaining({
        text: "@general hello",
        agent: "build",
        model: { providerID: "test", id: "test-model" },
        agents: [{ name: "general", mention: { start: 0, end: 8, text: "@general" } }],
      }),
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

  it("keeps the /btw text and frames a timeout as ambiguous", async () => {
    const { client } = await setup()
    client.api.prompt.mockRejectedValue(new RequestTimeoutError())

    const input = await screen.findByPlaceholderText("Write a message…")
    await fireEvent.changeText(input, "/btw what changed?")
    await fireEvent.press(screen.getByText("Send"))

    expect(await screen.findByText(/side question may not have started/)).toBeOnTheScreen()
    expect(input.props.value).toBe("/btw what changed?")
  })

  it("deletes the fork when the side question cannot be started", async () => {
    const { client } = await setup()
    client.api.prompt.mockRejectedValue(new ApiError(500, "x"))

    await fireEvent.changeText(await screen.findByPlaceholderText("Write a message…"), "/btw why?")
    await fireEvent.press(screen.getByText("Send"))

    expect(await screen.findByText("Could not start the side question (HTTP 500)")).toBeOnTheScreen()
    expect(client.api.removeSession).toHaveBeenCalledWith("fork_1")
  })

  it("deletes the fork when the composer unmounts while it is in flight", async () => {
    const { client, view } = await setup()
    let resolveFork: ((session: { id: string }) => void) | undefined
    client.api.forkSession.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFork = resolve
        }),
    )

    await fireEvent.changeText(await screen.findByPlaceholderText("Write a message…"), "/btw why?")
    await fireEvent.press(screen.getByText("Send"))

    await act(async () => {
      view.unmount()
    })
    await act(async () => {
      resolveFork?.({ id: "fork_1" })
    })

    expect(client.api.removeSession).toHaveBeenCalledWith("fork_1")
  })

  it("removes the previous fork when a second /btw replaces the panel", async () => {
    const { client } = await setup()
    client.api.forkSession.mockResolvedValueOnce({ id: "fork_1" }).mockResolvedValueOnce({ id: "fork_2" })

    const input = await screen.findByPlaceholderText("Write a message…")
    await fireEvent.changeText(input, "/btw first?")
    await fireEvent.press(screen.getByText("Send"))
    await screen.findByText("Side question")

    await fireEvent.changeText(input, "/btw second?")
    await fireEvent.press(screen.getByText("Send"))

    expect(client.api.removeSession).toHaveBeenCalledWith("fork_1")
  })

  it("starts a goal run from /goal with the typed text and model", async () => {
    const { client } = await setup()
    const input = await screen.findByPlaceholderText("Write a message…")

    await fireEvent.changeText(input, "/goal ship the feature")
    await fireEvent.press(screen.getByText("Send"))

    await waitFor(() =>
      expect(client.api.goal.start).toHaveBeenCalledWith("s1", {
        goal: "ship the feature",
        model: "test/test-model",
      }),
    )
    expect(client.api.prompt).not.toHaveBeenCalled()
    await waitFor(() => expect(input.props.value).toBe(""))
  })

  it("requires a goal after /goal", async () => {
    const { client } = await setup()

    await fireEvent.changeText(await screen.findByPlaceholderText("Write a message…"), "/goal")
    await fireEvent.press(screen.getByText("Send"))

    expect(await screen.findByText("Describe the goal after /goal")).toBeOnTheScreen()
    expect(client.api.goal.start).not.toHaveBeenCalled()
  })

  it("maps a running goal error to its message", async () => {
    const { client } = await setup()
    client.api.goal.start.mockRejectedValue(new ApiError(409, JSON.stringify({ error: "goal_running" })))

    const input = await screen.findByPlaceholderText("Write a message…")
    await fireEvent.changeText(input, "/goal another goal")
    await fireEvent.press(screen.getByText("Send"))

    expect(
      await screen.findByText("A goal run is already active in this session. Pause or cancel it first."),
    ).toBeOnTheScreen()
    // The failed start keeps the text so the user can adjust and retry.
    expect(input.props.value).toBe("/goal another goal")
  })

  it("uses the emerald accent for the active auto-accept state (#92)", async () => {
    await setup({ autoAccept: true })

    const label = await screen.findByText("auto-accept: on")
    // Not the old warning amber: the active state is the single accent.
    expect(label).not.toHaveStyle({ color: palettes.light.warning })
    expect(label).not.toHaveStyle({ color: palettes.dark.warning })
    const accent = [palettes.light.accent, palettes.dark.accent]
    const matched = accent.some((color) => {
      try {
        expect(label).toHaveStyle({ color })
        return true
      } catch {
        return false
      }
    })
    expect(matched).toBe(true)
  })

  it("manages workspaces from the composer top bar (#92)", async () => {
    await setup({
      workspaceID: "ws1",
      workspaces: [{ id: "ws1", name: "demo", path: "/workspaces/demo", createdAt: 0 }],
      onSelectWorkspace: jest.fn(),
    })

    await fireEvent.press(await screen.findByLabelText("Workspace"))
    expect(await screen.findByText("Remove workspace")).toBeOnTheScreen()
  })
})
