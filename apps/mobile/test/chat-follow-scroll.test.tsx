import { FlatList } from "react-native"
import { fireEvent, render, screen } from "@testing-library/react-native"
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

/**
 * Kept in its own file: firing VirtualizedList's content-size handler leaves
 * the mocked responder in a state that breaks later mounts in the same file
 * (see the ordering notes in `chat-screen.test.tsx`). One mount, one test.
 */
describe("ChatScreen follow-scroll threshold", () => {
  it("never snaps back a reader parked just above the bottom", async () => {
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
    const list = await screen.findByTestId("chat-list")

    // 100 px from the newest message: outside the follow threshold, still
    // inside the jump-button threshold.
    fireEvent.scroll(list, {
      nativeEvent: {
        contentOffset: { y: 100, x: 0 },
        contentSize: { height: 9000, width: 300 },
        layoutMeasurement: { height: 800, width: 300 },
      },
    })
    expect(screen.queryByLabelText("Scroll to bottom")).toBeNull()

    const scrollToOffset = jest.spyOn(FlatList.prototype, "scrollToOffset")
    fireEvent(list, "contentSizeChange", 300, 9000)
    expect(scrollToOffset).not.toHaveBeenCalled()

    // Back at the bottom: streaming growth re-anchors again.
    fireEvent.scroll(list, {
      nativeEvent: {
        contentOffset: { y: 0, x: 0 },
        contentSize: { height: 9000, width: 300 },
        layoutMeasurement: { height: 800, width: 300 },
      },
    })
    fireEvent(list, "contentSizeChange", 300, 9100)
    expect(scrollToOffset).toHaveBeenCalledWith({ offset: 0, animated: false })
    scrollToOffset.mockRestore()
  })
})
