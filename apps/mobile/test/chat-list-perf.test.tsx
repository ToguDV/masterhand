import { fireEvent, render, screen } from "@testing-library/react-native"
import type { ChatMessage, ChatMessageInfo, ChatPart } from "@masterhand/client-core"
import { queryKeys } from "@masterhand/client-core"
import { ChatScreen } from "../src/screens/ChatScreen"
import { isSameChatEntry } from "../src/components/MessageBubble"
import { fakeClient, makeQueryClient, QueryWrapper } from "./support/render"

const previewDataUrl = `data:image/png;base64,${"A".repeat(4096)}`

function userMessage(): ChatMessage {
  return {
    info: {
      id: "u1",
      sessionID: "s1",
      role: "user",
      time: { created: 1000 },
      attachments: [
        { id: "a1", name: "photo.png", mime: "image/png", size: 2048, url: "/api/x", inline: true, previewDataUrl },
      ],
    },
    parts: [{ id: "u1:text", sessionID: "s1", messageID: "u1", type: "text", text: "look" }],
  }
}

async function setupList() {
  const client = fakeClient()
  client.api.messages.mockResolvedValue([userMessage()])
  const queryClient = makeQueryClient()
  queryClient.setQueryData<ChatMessage[]>(queryKeys.messages("s1"), [userMessage()])
  await render(<ChatScreen client={client} sessionID="s1" title="s" busy={false} connected workspaceID={null} autoAccept={false} onToggleAutoAccept={() => {}} onBack={() => {}} />, {
    wrapper: ({ children }) => <QueryWrapper client={queryClient}>{children}</QueryWrapper>,
  })
}

describe("chat list perf (flicker at bottom)", () => {
  it("reuses equal message entries instead of remounting image rows", () => {
    const first = userMessage()
    const second = userMessage()
    expect(second).not.toBe(first)
    expect(second.info.attachments?.[0]?.previewDataUrl).toBe(first.info.attachments?.[0]?.previewDataUrl)
    expect(isSameChatEntry(first, second)).toBe(true)
  })

  it("re-renders when visible content actually changed", () => {
    const base = userMessage()
    const editedText: ChatMessage = {
      ...base,
      info: { ...base.info },
      parts: [{ id: "u1:text", sessionID: "s1", messageID: "u1", type: "text", text: "look at this" }],
    }
    expect(isSameChatEntry(base, editedText)).toBe(false)

    const completed: ChatMessage = {
      ...base,
      info: { ...base.info, time: { created: 1000, completed: 2000 } },
    }
    expect(isSameChatEntry(base, completed)).toBe(false)

    const withFile: ChatMessage = {
      ...base,
      info: {
        ...base.info,
        attachments: [
          ...(base.info.attachments ?? []),
          { id: "a2", name: "notes.txt", mime: "text/plain", size: 10, url: "/api/y", inline: true },
        ],
      },
    }
    expect(isSameChatEntry(base, withFile)).toBe(false)
  })

  it("virtualizes the conversation list", async () => {
    await setupList()
    const list = await screen.findByTestId("chat-list")
    expect(list.props.windowSize).toBeLessThanOrEqual(7)
    expect(list.props.maxToRenderPerBatch).toBeLessThanOrEqual(10)
    expect(list.props.removeClippedSubviews).toBe(true)
  })

  it("tracks whether the user is near the bottom for follow-scroll", async () => {
    await setupList()
    const list = await screen.findByTestId("chat-list")
    expect(list.props.onScroll).toBeDefined()
    expect(list.props.onContentSizeChange).toBeDefined()
    // Near the bottom and far from it must not throw; the handler only flips
    // the follow flag (the content-size handler owns the actual scroll).
    fireEvent.scroll(list, {
      nativeEvent: {
        contentOffset: { y: 4000, x: 0 },
        contentSize: { height: 5000, width: 300 },
        layoutMeasurement: { height: 800, width: 300 },
      },
    })
    fireEvent.scroll(list, {
      nativeEvent: {
        contentOffset: { y: 0, x: 0 },
        contentSize: { height: 5000, width: 300 },
        layoutMeasurement: { height: 800, width: 300 },
      },
    })
  })
})

function assistantMessage(parts: ChatPart[]): ChatMessage {
  return {
    info: { id: "a1", sessionID: "s1", role: "assistant", time: { created: 1000 } },
    parts,
  }
}

const assistantText = (text: string): ChatPart => ({
  id: "p-text",
  sessionID: "s1",
  messageID: "a1",
  type: "text",
  text,
})

const toolPart = (state: Record<string, unknown>): ChatPart =>
  ({
    id: "p-tool",
    sessionID: "s1",
    messageID: "a1",
    type: "tool",
    tool: "bash",
    callID: "c1",
    state: { status: "completed", title: "ls", input: { cmd: "ls" }, output: "ok", ...state },
  }) as unknown as ChatPart

describe("isSameChatEntry", () => {
  it("ignores rebuilt identities across info fields, tokens and attachments", () => {
    const base = assistantMessage([assistantText("hi")])
    const twin = assistantMessage([assistantText("hi")])
    expect(isSameChatEntry(base, twin)).toBe(true)
    expect(isSameChatEntry(base, base)).toBe(true)

    const withTokens: ChatMessage = {
      ...base,
      info: {
        ...base.info,
        tokens: { input: 10, output: 2, cache: { read: 1, write: 2 } } as ChatMessageInfo["tokens"],
      },
    }
    const withTokensTwin: ChatMessage = {
      ...base,
      info: {
        ...base.info,
        tokens: { input: 10, output: 2, cache: { read: 1, write: 2 } } as ChatMessageInfo["tokens"],
      },
    }
    expect(isSameChatEntry(withTokens, withTokensTwin)).toBe(true)
    expect(
      isSameChatEntry(withTokens, {
        ...base,
        info: { ...base.info, tokens: { input: 11, output: 2 } as ChatMessageInfo["tokens"] },
      }),
    ).toBe(false)
    expect(
      isSameChatEntry(withTokens, {
        ...base,
        info: {
          ...base.info,
          tokens: { input: 10, output: 2, cache: { read: 9, write: 2 } } as ChatMessageInfo["tokens"],
        },
      }),
    ).toBe(false)
    expect(isSameChatEntry(withTokens, base)).toBe(false)
    expect(isSameChatEntry(base, withTokens)).toBe(false)
  })

  it("notices info, attachment and part-identity changes", () => {
    const base = assistantMessage([assistantText("hi")])
    const patch = (info: Partial<ChatMessage["info"]>): ChatMessage => ({
      ...base,
      info: { ...base.info, ...info },
    })
    expect(isSameChatEntry(base, patch({ role: "user" }))).toBe(false)
    expect(isSameChatEntry(base, patch({ agent: "explore" }))).toBe(false)
    expect(isSameChatEntry(base, patch({ providerID: "p" }))).toBe(false)
    expect(isSameChatEntry(base, patch({ modelID: "m" }))).toBe(false)
    expect(isSameChatEntry(base, patch({ cost: 1 }))).toBe(false)
    expect(
      isSameChatEntry(base, patch({ error: { name: "x", message: "boom" } as never })),
    ).toBe(false)
    const streamed1500 = patch({ time: { created: 1000, streamed: 1500 } })
    const streamed1500Twin = patch({ time: { created: 1000, streamed: 1500 } })
    expect(isSameChatEntry(streamed1500, streamed1500Twin)).toBe(true)
    expect(isSameChatEntry(base, streamed1500)).toBe(false)
    expect(isSameChatEntry(streamed1500, patch({ time: { created: 1000, streamed: 1600 } }))).toBe(false)

    const withAttachment: ChatMessage = {
      ...base,
      info: {
        ...base.info,
        attachments: [{ id: "a1", name: "p.png", mime: "image/png", size: 8, url: "/u", inline: true }],
      },
    }
    const renamed: ChatMessage = {
      ...withAttachment,
      info: {
        ...withAttachment.info,
        attachments: [
          { id: "a1", name: "q.png", mime: "image/png", size: 8, url: "/u", inline: true },
        ],
      },
    }
    expect(isSameChatEntry(withAttachment, renamed)).toBe(false)
    expect(isSameChatEntry(withAttachment, base)).toBe(false)
    expect(isSameChatEntry(base, withAttachment)).toBe(false)

    const otherID = assistantMessage([assistantText("hi")])
    otherID.info = { ...otherID.info, id: "a2" }
    expect(isSameChatEntry(base, otherID)).toBe(false)
    const otherPart = assistantMessage([{ ...assistantText("hi"), id: "p-other" } as ChatPart])
    expect(isSameChatEntry(base, otherPart)).toBe(false)
  })

  it("compares reasoning, tool and unknown parts structurally", () => {
    const reasoning = (text: string): ChatPart =>
      ({ id: "p-r", sessionID: "s1", messageID: "a1", type: "reasoning", text }) as ChatPart
    expect(isSameChatEntry(assistantMessage([reasoning("a")]), assistantMessage([reasoning("a")]))).toBe(
      true,
    )
    expect(isSameChatEntry(assistantMessage([reasoning("a")]), assistantMessage([reasoning("b")]))).toBe(
      false,
    )

    const running = toolPart({ status: "running", output: undefined })
    const done = toolPart({ status: "completed" })
    expect(isSameChatEntry(assistantMessage([running]), assistantMessage([running]))).toBe(true)
    expect(isSameChatEntry(assistantMessage([running]), assistantMessage([done]))).toBe(false)
    expect(
      isSameChatEntry(assistantMessage([done]), assistantMessage([toolPart({ output: "changed" })])),
    ).toBe(false)

    const unknown = (id: string): ChatPart =>
      ({ id, sessionID: "s1", messageID: "a1", type: "step-start" }) as unknown as ChatPart
    expect(isSameChatEntry(assistantMessage([unknown("s")]), assistantMessage([unknown("s")]))).toBe(
      true,
    )
    expect(
      isSameChatEntry(assistantMessage([unknown("s")]), assistantMessage([assistantText("hi")])),
    ).toBe(false)
  })
})
