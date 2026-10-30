import { Linking } from "react-native"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react-native"
import type { ChatMessage, SessionIsolation } from "@masterhand/client-core"
import { queryKeys, RequestTimeoutError } from "@masterhand/client-core"
import { ChatScreen } from "../src/screens/ChatScreen"
import { fakeClient, makeQueryClient, QueryWrapper } from "./support/render"

const assistant: ChatMessage = {
  info: {
    id: "a1",
    sessionID: "s1",
    role: "assistant",
    time: { created: 1000, completed: 2000 },
    modelID: "test-model",
    cost: 0.001,
    tokens: { input: 20, output: 5 } as ChatMessage["info"]["tokens"],
  },
  parts: [{ id: "p1", sessionID: "s1", messageID: "a1", type: "text", text: "reply from agent" }],
}

async function setup(
  props: Partial<React.ComponentProps<typeof ChatScreen>> = {},
  configure?: (client: ReturnType<typeof fakeClient>) => void,
) {
  const client = fakeClient()
  configure?.(client)
  const queryClient = makeQueryClient()
  const handlers = {
    onToggleAutoAccept: jest.fn(),
    onOpenSession: jest.fn(),
    onBack: jest.fn(),
    ...props,
  }
  await render(
    <ChatScreen
      client={client}
      sessionID="s1"
      title="My session"
      busy={false}
      connected
      workspaceID={null}
      autoAccept={false}
      {...handlers}
    />,
    { wrapper: ({ children }) => <QueryWrapper client={queryClient}>{children}</QueryWrapper> },
  )
  return { client, handlers, queryClient }
}

describe("ChatScreen", () => {
  it("renders the title, the messages and the usage line", async () => {
    await setup({}, (client) => {
      client.api.messages.mockResolvedValue([assistant])
    })

    expect(await screen.findByText("reply from agent")).toBeOnTheScreen()
    expect(screen.getByText("My session")).toBeOnTheScreen()
    // Icons + numbers only; labels live in the accessibility names (#92).
    // Scope to the session row: the message stats mirror the same language.
    const usage = screen.getByLabelText("Session usage")
    expect(within(usage).getByLabelText("Cost: $0.0010")).toBeOnTheScreen()
    expect(within(usage).getByLabelText("Input tokens: 20")).toBeOnTheScreen()
    expect(within(usage).getByLabelText("Output tokens: 5")).toBeOnTheScreen()
    expect(within(usage).getByLabelText("Speed: 5 tok/s")).toBeOnTheScreen()
    // Cache read/write are not shown even when the provider reports them.
    expect(screen.queryByText(/cache/i)).toBeNull()
  })

  it("rounds the session speed to a whole number (#127)", async () => {
    // 5 generated tokens over 1230 ms -> 4.065… tok/s, never a raw float.
    const fractional: ChatMessage = {
      ...assistant,
      info: { ...assistant.info, time: { created: 1000, completed: 2230 } },
    }
    await setup({}, (client) => {
      client.api.messages.mockResolvedValue([fractional])
    })

    const usage = await screen.findByLabelText("Session usage")
    expect(within(usage).getByLabelText("Speed: 4 tok/s")).toBeOnTheScreen()
    expect(within(usage).getByText("4 tok/s")).toBeOnTheScreen()
    expect(screen.queryByText(/4\.06/)).toBeNull()
  })

  it("shows a ghost bubble while a plain prompt is being delivered (#125)", async () => {
    const { client } = await setup({}, (c) => {
      c.api.messages.mockResolvedValue([])
    })
    client.api.prompt.mockImplementation(() => new Promise<void>(() => {}))

    await fireEvent.changeText(await screen.findByPlaceholderText("Write a message…"), "hello ghost")
    await fireEvent.press(screen.getByText("Send"))

    expect(await screen.findByText("Sending…")).toBeOnTheScreen()
    expect(screen.getByLabelText("Sending message")).toBeOnTheScreen()
  })

  it("replaces the ghost with the real bubble when the marker is delivered (#125)", async () => {
    const { client, queryClient } = await setup({}, (c) => {
      c.api.messages.mockResolvedValue([])
    })
    client.api.prompt.mockImplementation(() => new Promise<void>(() => {}))

    await fireEvent.changeText(await screen.findByPlaceholderText("Write a message…"), "hello ghost")
    await fireEvent.press(screen.getByText("Send"))
    const marker = (
      client.api.prompt.mock.calls[0]?.[1] as { metadata: Record<string, string> }
    ).metadata["masterhand.delivery"]
    expect(await screen.findByText("Sending…")).toBeOnTheScreen()

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
          parts: [
            { id: "part_1", sessionID: "s1", messageID: "msg_live", type: "text", text: "hello ghost" },
          ],
        },
      ])
    })

    expect(screen.queryByText("Sending…")).toBeNull()
    expect(screen.getByText("hello ghost")).toBeOnTheScreen()
  })

  it("prompts to start when there are no messages", async () => {
    await setup()

    expect(
      await screen.findByText("Write a message to start working with the agent."),
    ).toBeOnTheScreen()
  })

  it("goes back from the header", async () => {
    const { handlers } = await setup()

    await fireEvent.press(screen.getByText("‹"))

    expect(handlers.onBack).toHaveBeenCalled()
  })

  it("finishes an isolated session and reports the result", async () => {
    const { client } = await setup({
      isolation: {
        isolated: true,
        worktreePath: "/workspaces/.worktrees/demo/abc",
        branch: "masterhand/abc",
        baseRef: "HEAD",
      },
    })
    client.api.sessions.finish.mockResolvedValue({
      committed: true,
      pushed: true,
      prUrl: "https://github.com/ToguDV/masterhand/pull/99",
      branch: "masterhand/abc",
      path: "/workspaces/.worktrees/demo/abc",
      error: null,
    })

    // The branch shows exactly once: the isolation strip owns it, the dock
    // header no longer repeats it.
    expect(screen.getAllByText("masterhand/abc")).toHaveLength(1)
    await fireEvent.press(screen.getByText("Finish & PR"))

    expect(client.api.sessions.finish).toHaveBeenCalledWith("s1")
    expect(await screen.findByText(/Branch pushed\./)).toBeOnTheScreen()
    expect(screen.getByText("Open pull request ↗")).toBeOnTheScreen()
  })

  it("returns to the parent session from a subagent view", async () => {
    const { handlers } = await setup({ parentSessionID: "parent-1" })

    await fireEvent.press(screen.getByText("← Back to main agent"))

    expect(handlers.onOpenSession).toHaveBeenCalledWith("parent-1")
  })

  it("opens the unified Run & preview modal when previews are enabled", async () => {
    const { client } = await setup(
      { workspaceID: "ws1" },
      (client) => {
        client.auth.status.mockResolvedValue({
          ok: true,
          preview: { enabled: true, available: true, portRange: { min: 3000, max: 3010 } },
        })
      },
    )

    await fireEvent.press(await screen.findByLabelText("Run and preview"))

    expect(client.api.preview).toHaveBeenCalledWith("s1")
    expect(await screen.findByLabelText("Preview")).toBeOnTheScreen()
  })

  const isolation: SessionIsolation = {
    isolated: true,
    worktreePath: "/workspaces/.worktrees/demo/abc",
    branch: "masterhand/abc",
    baseRef: "HEAD",
  }

  it("reports a failed finish", async () => {
    const { client } = await setup({ isolation })
    client.api.sessions.finish.mockRejectedValue(new Error("nope"))

    await fireEvent.press(await screen.findByText("Finish & PR"))

    expect(await screen.findByText("Could not finish the session")).toBeOnTheScreen()
  })

  it("shows the error returned by the finish endpoint", async () => {
    const { client } = await setup({ isolation })
    client.api.sessions.finish.mockResolvedValue({
      committed: false,
      pushed: false,
      prUrl: null,
      branch: "masterhand/abc",
      path: "/workspaces/.worktrees/demo/abc",
      error: "merge conflict",
    })

    await fireEvent.press(await screen.findByText("Finish & PR"))

    expect(await screen.findByText("merge conflict")).toBeOnTheScreen()
  })

  it("opens the pull request produced by a finish", async () => {
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined as never)
    const { client } = await setup({ isolation })
    client.api.sessions.finish.mockResolvedValue({
      committed: false,
      pushed: true,
      prUrl: "https://github.com/ToguDV/masterhand/pull/99",
      branch: "masterhand/abc",
      path: "/workspaces/.worktrees/demo/abc",
      error: null,
    })

    await fireEvent.press(await screen.findByText("Finish & PR"))
    await fireEvent.press(await screen.findByText("Open pull request ↗"))

    expect(open).toHaveBeenCalledWith("https://github.com/ToguDV/masterhand/pull/99")
    open.mockRestore()
  })

  it("opens the isolation pull request link from the header bar", async () => {
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined as never)
    await setup({ isolation: { ...isolation, prUrl: "https://github.com/ToguDV/masterhand/pull/7" } })

    await fireEvent.press(await screen.findByText("PR ↗"))

    expect(open).toHaveBeenCalledWith("https://github.com/ToguDV/masterhand/pull/7")
    open.mockRestore()
  })

  it("reconciles an ambiguous finish against the session record", async () => {
    const { client } = await setup(
      {
        workspaceID: "ws1",
        isolation: {
          isolated: true,
          worktreePath: "/workspaces/.worktrees/demo/abc",
          branch: "masterhand/abc",
          baseRef: "HEAD",
        },
      },
      (client) => {
        client.api.sessions.finish.mockRejectedValue(new RequestTimeoutError())
        client.api.sessions.list.mockResolvedValue({
          sessions: [
            {
              id: "s1",
              isolation: {
                isolated: true,
                worktreePath: "/workspaces/.worktrees/demo/abc",
                branch: "masterhand/abc",
                baseRef: "HEAD",
                pushed: true,
                prUrl: null,
              },
            },
          ],
        })
      },
    )

    await fireEvent.press(await screen.findByText("Finish & PR"))

    // The lost response never surfaces as a failure: the record proves the push.
    expect(await screen.findByText(/Branch pushed\./)).toBeOnTheScreen()
    expect(screen.getByText(/this result comes from the session record/)).toBeOnTheScreen()
  })

  it("reports an ambiguous finish with no record evidence as still running", async () => {
    const { client } = await setup(
      {
        workspaceID: "ws1",
        isolation: {
          isolated: true,
          worktreePath: "/workspaces/.worktrees/demo/abc",
          branch: "masterhand/abc",
          baseRef: "HEAD",
        },
      },
      (client) => {
        client.api.sessions.finish.mockRejectedValue(new RequestTimeoutError())
        client.api.sessions.list.mockResolvedValue({ sessions: [] })
      },
    )

    await fireEvent.press(await screen.findByText("Finish & PR"))

    // Bounded reconciliation (0s + 1.5s + 3s polls) finds nothing: warn, don't fail.
    expect(await screen.findByText(/may still be running/, {}, { timeout: 10000 })).toBeOnTheScreen()
  })

  it("switches workspaces from the dock header", async () => {
    const onSelectWorkspace = jest.fn()
    await setup({
      workspaceID: "ws1",
      workspaces: [
        { id: "ws1", name: "demo", path: "/workspaces/demo", createdAt: 0 },
        { id: "ws2", name: "other", path: "/workspaces/other", createdAt: 0 },
      ],
      onSelectWorkspace,
    })

    await fireEvent.press(await screen.findByLabelText("Workspace"))
    await fireEvent.press(await screen.findByText("other"))

    expect(onSelectWorkspace).toHaveBeenCalledWith("ws2")
  })

  it("closes the unified Run & preview modal", async () => {
    await setup({ workspaceID: "ws1" }, (client) => {
      client.auth.status.mockResolvedValue({
        ok: true,
        preview: { enabled: true, available: true, portRange: { min: 3000, max: 3010 } },
      })
    })

    await fireEvent.press(await screen.findByLabelText("Run and preview"))
    await fireEvent.press(await screen.findByLabelText("Close run and preview"))

    await waitFor(() => expect(screen.queryByLabelText("Close run and preview")).toBeNull())
  })

  it("starts at the bottom with no visible scroll on entry", async () => {
    await setup({}, (client) => {
      client.api.messages.mockResolvedValue([assistant])
    })
    expect(await screen.findByText("reply from agent")).toBeOnTheScreen()
    // Messages are in but the list has not pinned to the bottom yet: it stays
    // invisible so the user never sees the top of the chat flash by.
    expect(screen.getByTestId("chat-list-wrap").props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ opacity: 0 })]),
    )

    fireEvent(screen.getByTestId("chat-list"), "contentSizeChange", 300, 5000)

    await waitFor(() => {
      expect(screen.getByTestId("chat-list-wrap").props.style).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ opacity: 0 })]),
      )
    })
  })

  it("shows a scroll-to-bottom shortcut when scrolled up", async () => {
    await setup({}, (client) => {
      client.api.messages.mockResolvedValue([assistant])
    })
    expect(await screen.findByText("reply from agent")).toBeOnTheScreen()
    const list = await screen.findByTestId("chat-list")
    expect(screen.queryByLabelText("Scroll to bottom")).toBeNull()

    fireEvent.scroll(list, {
      nativeEvent: {
        contentOffset: { y: 0, x: 0 },
        contentSize: { height: 5000, width: 300 },
        layoutMeasurement: { height: 800, width: 300 },
      },
    })

    expect(await screen.findByLabelText("Scroll to bottom")).toBeOnTheScreen()
  })

  it("hides the shortcut after jumping back to the bottom", async () => {    await setup({}, (client) => {
      client.api.messages.mockResolvedValue([assistant])
    })
    expect(await screen.findByText("reply from agent")).toBeOnTheScreen()
    const list = await screen.findByTestId("chat-list")
    fireEvent.scroll(list, {
      nativeEvent: {
        contentOffset: { y: 0, x: 0 },
        contentSize: { height: 5000, width: 300 },
        layoutMeasurement: { height: 800, width: 300 },
      },
    })
    const jump = await screen.findByLabelText("Scroll to bottom")
    await fireEvent.press(jump)

    await waitFor(() => expect(screen.queryByLabelText("Scroll to bottom")).toBeNull())
  })
})
