import { Platform } from "react-native"
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native"
import type { ChatMessage } from "@masterhand/client-core"
import { ChatScreen } from "../src/screens/ChatScreen"
import { fakeClient, makeQueryClient, QueryWrapper } from "./support/render"

const assistant: ChatMessage = {
  info: {
    id: "a1",
    sessionID: "s1",
    role: "assistant",
    time: { created: 1000, completed: 2000 },
  },
  parts: [{ id: "p1", sessionID: "s1", messageID: "a1", type: "text", text: "reply from agent" }],
}

const defaultOS = Platform.OS

afterEach(() => {
  Platform.OS = defaultOS
})

async function renderChat() {
  const client = fakeClient()
  client.api.messages.mockResolvedValue([assistant])
  const queryClient = makeQueryClient()
  await render(
    <ChatScreen
      client={client}
      sessionID="s1"
      title="My session"
      busy={false}
      connected
      workspaceID={null}
      autoAccept={false}
      onToggleAutoAccept={jest.fn()}
      onOpenSession={jest.fn()}
      onBack={jest.fn()}
    />,
    { wrapper: ({ children }) => <QueryWrapper client={queryClient}>{children}</QueryWrapper> },
  )
  expect(await screen.findByText("reply from agent")).toBeOnTheScreen()
  return screen.findByTestId("chat-list")
}

function scrollTo(list: Awaited<ReturnType<typeof renderChat>>, y: number) {
  fireEvent.scroll(list, {
    nativeEvent: {
      contentOffset: { y, x: 0 },
      contentSize: { height: 9000, width: 300 },
      layoutMeasurement: { height: 800, width: 300 },
    },
  })
}

/**
 * Inverted list: offset 0 is the newest message. The native scroll view must
 * re-anchor the bottom-most visible row while the reader is away from the
 * bottom (streaming text and new messages grow the native head). While
 * following, that anchor stays off so the instant JS follow owns the case.
 */
describe("ChatScreen native scroll anchoring", () => {
  it("anchors on iOS only while the reader is away from the bottom", async () => {
    Platform.OS = "ios"
    const list = await renderChat()

    // Pinned at the bottom: no native anchoring (the JS follow is instant and
    // an always-on anchor would emit a scroll that flips the follow flag).
    expect(list.props.maintainVisibleContentPosition).toBeUndefined()

    scrollTo(list, 100)
    // 100 px from the bottom: outside follow, inside the jump threshold.
    expect(screen.queryByLabelText("Scroll to bottom")).toBeNull()
    // VirtualizedList adds +1 to skip the list header (goal review/pending):
    // the anchor starts at the newest message.
    await waitFor(() =>
      expect(screen.getByTestId("chat-list").props.maintainVisibleContentPosition).toEqual({
        minIndexForVisible: 1,
      }),
    )

    scrollTo(list, 0)
    await waitFor(() =>
      expect(
        screen.getByTestId("chat-list").props.maintainVisibleContentPosition,
      ).toBeUndefined(),
    )
  })

  it("anchors while the reader is away from the bottom on Android too", async () => {
    Platform.OS = "android"
    const list = await renderChat()

    expect(list.props.maintainVisibleContentPosition).toBeUndefined()

    scrollTo(list, 100)
    // VirtualizedList's header adjustment (see the iOS case) applies here too.
    await waitFor(() =>
      expect(screen.getByTestId("chat-list").props.maintainVisibleContentPosition).toEqual({
        minIndexForVisible: 1,
      }),
    )

    scrollTo(list, 0)
    await waitFor(() =>
      expect(
        screen.getByTestId("chat-list").props.maintainVisibleContentPosition,
      ).toBeUndefined(),
    )
  })
})
