import { FlatList } from "react-native"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react-native"
import type { ChatMessage } from "@masterhand/client-core"
import { queryKeys } from "@masterhand/client-core"
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

  it("starts at the bottom on entry without scrolling", async () => {
    await setup({}, (client) => {
      client.api.messages.mockResolvedValue([assistant])
    })
    expect(await screen.findByText("reply from agent")).toBeOnTheScreen()
    const list = await screen.findByTestId("chat-list")
    const scrollToOffset = jest.spyOn(FlatList.prototype, "scrollToOffset")

    // Inverted: offset 0 is the newest message, so the session is already at
    // the bottom before any scroll happens — no entry pin, no animation.
    expect(list.props.inverted).toBe(true)
    expect(list.props.data[0].info.id).toBe("a1")
    expect(scrollToOffset).not.toHaveBeenCalled()
    scrollToOffset.mockRestore()
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
        contentOffset: { y: 3000, x: 0 },
        contentSize: { height: 9000, width: 300 },
        layoutMeasurement: { height: 800, width: 300 },
      },
    })

    expect(await screen.findByLabelText("Scroll to bottom")).toBeOnTheScreen()
  })

  it("jumps to the bottom instantly", async () => {
    await setup({}, (client) => {
      client.api.messages.mockResolvedValue([assistant])
    })
    expect(await screen.findByText("reply from agent")).toBeOnTheScreen()
    const list = await screen.findByTestId("chat-list")
    fireEvent.scroll(list, {
      nativeEvent: {
        contentOffset: { y: 3000, x: 0 },
        contentSize: { height: 9000, width: 300 },
        layoutMeasurement: { height: 800, width: 300 },
      },
    })
    const jump = await screen.findByLabelText("Scroll to bottom")
    const scrollToOffset = jest.spyOn(FlatList.prototype, "scrollToOffset")

    await fireEvent.press(jump)

    expect(scrollToOffset).toHaveBeenCalledWith({ offset: 0, animated: false })
    expect(screen.queryByLabelText("Scroll to bottom")).toBeNull()
    scrollToOffset.mockRestore()
  })

  describe("message window", () => {
    function history(count: number, sessionID = "s1", prefix = "h"): ChatMessage[] {
      return Array.from({ length: count }, (_, index) => ({
        info: {
          id: `${prefix}${index}`,
          sessionID,
          role: "assistant",
          time: { created: 1000 + index, completed: 1000 + index },
        },
        parts: [
          {
            id: `${prefix}${index}:text`,
            sessionID,
            messageID: `${prefix}${index}`,
            type: "text",
            text: `message ${index}`,
          },
        ],
      }))
    }

    function scrollUp(list: ReturnType<typeof screen.getByTestId>) {
      fireEvent.scroll(list, {
        nativeEvent: {
          contentOffset: { y: 3000, x: 0 },
          contentSize: { height: 9000, width: 300 },
          layoutMeasurement: { height: 800, width: 300 },
        },
      })
    }

    it("renders only the newest messages on entry", async () => {
      await setup({}, (client) => {
        client.api.messages.mockResolvedValue(history(45))
      })
      expect(await screen.findByText("message 44")).toBeOnTheScreen()
      const list = screen.getByTestId("chat-list")
      expect(list.props.data).toHaveLength(10)
      // Inverted: index 0 is the newest, index 9 the oldest visible.
      expect(list.props.data[0].info.id).toBe("h44")
      expect(list.props.data[9].info.id).toBe("h35")
      expect(screen.queryByText("message 34")).toBeNull()
    })

    it("offers older messages only after scrolling up, and reveals them in pages", async () => {
      await setup({}, (client) => {
        client.api.messages.mockResolvedValue(history(45))
      })
      expect(await screen.findByText("message 44")).toBeOnTheScreen()
      const list = screen.getByTestId("chat-list")
      expect(screen.queryByTestId("load-older-messages")).toBeNull()

      scrollUp(list)

      const pill = await screen.findByLabelText("Show 20 older messages")
      expect(within(pill).getByText("+20 messages")).toBeOnTheScreen()
      const scrollToOffset = jest.spyOn(FlatList.prototype, "scrollToOffset")

      await fireEvent.press(pill)

      // The reveal only appends older rows: nothing scrolls, nothing shifts.
      expect(scrollToOffset).not.toHaveBeenCalled()
      const revealed = screen.getByTestId("chat-list").props.data
      expect(revealed).toHaveLength(30)
      // Oldest visible row is now the 30th newest (h15); h14 stays hidden.
      expect(revealed[29].info.id).toBe("h15")
      await screen.findByLabelText("Show 15 older messages")

      await fireEvent.press(await screen.findByLabelText("Show 15 older messages"))

      expect(screen.getByTestId("chat-list").props.data).toHaveLength(45)
      expect(screen.queryByTestId("load-older-messages")).toBeNull()
      scrollToOffset.mockRestore()
    })

    it("keeps the oldest visible message mounted when new ones arrive while scrolled up", async () => {
      const messages = history(45)
      const { queryClient } = await setup({}, (client) => {
        client.api.messages.mockResolvedValue(messages)
      })
      expect(await screen.findByText("message 44")).toBeOnTheScreen()
      scrollUp(screen.getByTestId("chat-list"))
      await fireEvent.press(await screen.findByLabelText("Show 20 older messages"))

      await act(async () => {
        queryClient.setQueryData<ChatMessage[]>(queryKeys.messages("s1"), [
          ...messages,
          {
            info: { id: "h45", sessionID: "s1", role: "assistant", time: { created: 2000 } },
            parts: [
              {
                id: "h45:text",
                sessionID: "s1",
                messageID: "h45",
                type: "text",
                text: "message 45",
              },
            ],
          },
        ])
      })

      await waitFor(() => expect(screen.getByTestId("chat-list").props.data).toHaveLength(31))
      const data = screen.getByTestId("chat-list").props.data
      expect(data[0].info.id).toBe("h45")
      expect(data[30].info.id).toBe("h15")
      expect(await screen.findByLabelText("Show 15 older messages")).toBeOnTheScreen()
    })

    it("compacts back to the newest page when returning to the bottom", async () => {
      await setup({}, (client) => {
        client.api.messages.mockResolvedValue(history(45))
      })
      const list = await screen.findByTestId("chat-list")
      await waitFor(() => expect(list.props.data).toHaveLength(10), { timeout: 5000 })
      scrollUp(list)
      await fireEvent.press(await screen.findByLabelText("Show 20 older messages", {}, { timeout: 5000 }))
      expect(screen.getByTestId("chat-list").props.data).toHaveLength(30)

      fireEvent.scroll(list, {
        nativeEvent: {
          contentOffset: { y: 0, x: 0 },
          contentSize: { height: 9000, width: 300 },
          layoutMeasurement: { height: 800, width: 300 },
        },
      })

      await waitFor(() => expect(screen.getByTestId("chat-list").props.data).toHaveLength(10))
    })

    it("starts a session change on its newest page, never the previous window", async () => {
      const client = fakeClient()
      client.api.messages.mockImplementation(async (id: string) =>
        id === "s1" ? history(45) : history(20, "s2", "b"),
      )
      const queryClient = makeQueryClient()
      const element = (sessionID: string) => (
        <ChatScreen
          client={client}
          sessionID={sessionID}
          title="s"
          busy={false}
          connected
          workspaceID={null}
          autoAccept={false}
          onToggleAutoAccept={() => {}}
          onBack={() => {}}
        />
      )
      const rendered = await render(element("s1"), {
        wrapper: ({ children }) => <QueryWrapper client={queryClient}>{children}</QueryWrapper>,
      })
      const list = await screen.findByTestId("chat-list")
      await waitFor(() => expect(list.props.data).toHaveLength(10), { timeout: 5000 })
      scrollUp(list)
      await fireEvent.press(await screen.findByLabelText("Show 20 older messages"))
      expect(screen.getByTestId("chat-list").props.data).toHaveLength(30)

      await rendered.rerender(element("s2"))

      // The frozen window belongs to s1: s2 must open on its newest 10 rows,
      // not on an empty or oversized slice for one frame.
      await waitFor(() => {
        const data = screen.getByTestId("chat-list").props.data
        expect(data).toHaveLength(10)
        expect(data[0].info.id).toBe("b19")
        expect(data[9].info.id).toBe("b10")
      })
    })

    // NOTE: this test stays last in the file. Firing VirtualizedList's own
    // layout/content-size handlers schedules internal timers that break the
    // next mount in the same file (a test-env-only artifact, like the drag
    // note in chat-list-perf). Nothing may mount after it.
    it("keeps short content reachable and does not swallow the follow re-anchor", async () => {
      await setup({}, (client) => {
        client.api.messages.mockResolvedValue(history(25))
      })
      const list = await screen.findByTestId("chat-list")
      await waitFor(() => expect(list.props.data).toHaveLength(10), { timeout: 5000 })

      // No scroll is possible: the 10 newest rows fit in the viewport. The
      // size event may arrive before layout; the pill must still appear once
      // both are known.
      fireEvent(list, "contentSizeChange", 300, 400)
      fireEvent(list, "layout", { nativeEvent: { layout: { height: 800, width: 300 } } })
      const pill = await screen.findByLabelText("Show 15 older messages")

      await fireEvent.press(pill)

      const scrollToOffset = jest.spyOn(FlatList.prototype, "scrollToOffset")
      // The size change caused by the reveal is ignored...
      fireEvent(list, "contentSizeChange", 300, 900)
      expect(scrollToOffset).not.toHaveBeenCalled()
      // ...but the next one (streaming growth, still pinned at the bottom) must
      // re-anchor as before.
      fireEvent(list, "contentSizeChange", 300, 1000)
      expect(scrollToOffset).toHaveBeenCalledWith({ offset: 0, animated: false })
      scrollToOffset.mockRestore()
    })
  })
})
