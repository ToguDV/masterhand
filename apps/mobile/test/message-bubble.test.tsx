import { fireEvent, render, screen } from "@testing-library/react-native"
import type { ChatMessage, ChatMessageInfo, ChatPart } from "@masterhand/client-core"
import { createMarkdownStyles, markdownColorScheme, MessageBubble } from "../src/components/MessageBubble"
import { palettes, systemFonts } from "../src/theme"

function message(info: Partial<ChatMessageInfo>, parts: ChatPart[]): ChatMessage {
  return {
    info: {
      id: "m1",
      sessionID: "s1",
      role: "assistant",
      time: { created: 1 },
      ...info,
    },
    parts,
  }
}

function bubble(info: Partial<ChatMessageInfo>, parts: ChatPart[], onOpenSession?: (id: string) => void) {
  return <MessageBubble entry={message(info, parts)} onOpenSession={onOpenSession} />
}

const textPart = (text: string): ChatPart => ({
  id: "p-text",
  sessionID: "s1",
  messageID: "m1",
  type: "text",
  text,
})

const reasoningPart = (text: string): ChatPart => ({
  id: "p-reason",
  sessionID: "s1",
  messageID: "m1",
  type: "reasoning",
  text,
})

const toolPart = (state: Record<string, unknown>): ChatPart =>
  ({
    id: "p-tool",
    sessionID: "s1",
    messageID: "m1",
    type: "tool",
    tool: "bash",
    callID: "c1",
    state,
  }) as unknown as ChatPart

const subagentPart = (state: Record<string, unknown>): ChatPart =>
  ({
    id: "p-sub",
    sessionID: "s1",
    messageID: "m1",
    type: "tool",
    tool: "subagent",
    callID: "c1",
    state,
  }) as unknown as ChatPart

describe("MessageBubble", () => {
  it("renders a user message as plain text", async () => {
    await render(bubble({ role: "user" }, [textPart("hello there")]))

    expect(screen.getByText("hello there")).toBeOnTheScreen()
  })

  it("uses the deep-emerald user bubble tokens (issue #100)", async () => {
    await render(bubble({ role: "user" }, [textPart("hello there")]))

    // The default test theme is light; the bubble is the deep emerald fill
    // with the token text color, never the old indigo.
    expect(screen.getByTestId("user-bubble")).toHaveStyle({
      backgroundColor: palettes.light.bubbleUser,
    })
    expect(screen.getByText("hello there")).toHaveStyle({ color: palettes.light.bubbleUserText })
  })

  it("renders nothing for an empty user message", async () => {
    await render(bubble({ role: "user" }, [textPart("   ")]))

    expect(screen.queryByText("   ")).toBeNull()
  })

  it("renders assistant markdown text", async () => {
    await render(bubble({ time: { created: 1, completed: 2 } }, [textPart("# Heading\n\nbody text")]))

    // The markdown renderer is stubbed (see test/mocks); assert the source is
    // handed to it rather than re-testing markdown parsing here.
    expect(screen.getByText(/# Heading/)).toBeOnTheScreen()
    expect(screen.getByText(/body text/)).toBeOnTheScreen()
  })

  it("shows Thinking… while a streamed message has no parts yet", async () => {
    await render(bubble({}, []))

    expect(screen.getByText("Thinking…")).toBeOnTheScreen()
  })

  it("shows the structured error and the compact usage line when completed", async () => {
    await render(
      bubble(
        {
          time: { created: 1000, completed: 3000 },
          modelID: "test-model",
          cost: 0.0021,
          tokens: { input: 1000, output: 42 } as ChatMessageInfo["tokens"],
          error: { name: "x", message: "boom" } as unknown as ChatMessageInfo["error"],
        },
        [textPart("done")],
      ),
    )

    expect(screen.getByText("boom")).toBeOnTheScreen()
    // Icons + numbers only; labels live in the accessibility names (#126).
    expect(screen.getByText("test-model")).toBeOnTheScreen()
    expect(screen.getByLabelText("Cost: $0.0021")).toBeOnTheScreen()
    expect(screen.getByLabelText("Input tokens: 1000")).toBeOnTheScreen()
    expect(screen.getByText("1k")).toBeOnTheScreen()
    expect(screen.getByLabelText("Output tokens: 42")).toBeOnTheScreen()
    expect(screen.getByLabelText("Speed: 21 tok/s")).toBeOnTheScreen()
    // The old verbose text chain is gone.
    expect(screen.queryByText(/input ·/)).toBeNull()
  })

  it("never renders cache tokens in the message stats (#126)", async () => {
    await render(
      bubble(
        {
          time: { created: 1000, completed: 2000 },
          modelID: "test-model",
          tokens: { input: 10, output: 2, cache: { read: 100, write: 50 } } as ChatMessageInfo["tokens"],
        },
        [textPart("done")],
      ),
    )

    expect(screen.getByLabelText("Message usage")).toBeOnTheScreen()
    expect(screen.queryByText(/cache/i)).toBeNull()
  })

  it("reveals reasoning text on demand", async () => {
    await render(bubble({}, [reasoningPart("because reasons")]))

    expect(screen.queryByText("because reasons")).toBeNull()
    await fireEvent.press(screen.getByText("▸ Reasoning"))
    expect(screen.getByText("because reasons")).toBeOnTheScreen()
  })

  it("expands a tool card to show its command and output", async () => {
    await render(
      bubble({ time: { created: 1, completed: 2 } }, [
        toolPart({ status: "completed", title: "list files", input: { cmd: "ls" }, output: "file.txt" }),
      ]),
    )

    expect(screen.getByText("ls")).toBeOnTheScreen()
    expect(screen.getByText(/list files/)).toBeOnTheScreen()
    await fireEvent.press(screen.getByText("ls"))
    expect(screen.getAllByText("ls").length).toBeGreaterThan(0)
    expect(screen.getByText("file.txt")).toBeOnTheScreen()
    // No raw JSON dump anywhere in the card.
    expect(screen.queryByText(/"cmd": "ls"/)).toBeNull()
  })

  it("renders a subagent card and opens the child session", async () => {
    const onOpenSession = jest.fn()
    await render(
      bubble({ time: { created: 1, completed: 2 } }, [
        subagentPart({
          status: "completed",
          input: { agent: "explore", description: "map the repo", prompt: "Find the entry point" },
          output: "<task><summary>done</summary><task_result>Found 3 files</task_result></task>",
          metadata: { sessionID: "child-1" },
        }),
      ], onOpenSession),
    )

    expect(screen.getByText("SUBAGENT")).toBeOnTheScreen()
    expect(screen.getByText("explore")).toBeOnTheScreen()
    expect(screen.getByText("map the repo")).toBeOnTheScreen()

    await fireEvent.press(screen.getByText("map the repo"))
    expect(screen.getByText("Find the entry point")).toBeOnTheScreen()
    // The <task>/<summary> wrapper is stripped from the output.
    expect(screen.getByText("Found 3 files")).toBeOnTheScreen()

    await fireEvent.press(screen.getByText("Open session →"))
    expect(onOpenSession).toHaveBeenCalledWith("child-1")
  })

  it("ignores parts it cannot render", async () => {
    await render(
      bubble({ time: { created: 1, completed: 2 } }, [
        { id: "p-step", sessionID: "s1", messageID: "m1", type: "step-start" } as unknown as ChatPart,
        textPart("visible text"),
      ]),
    )

    expect(screen.getByText(/visible text/)).toBeOnTheScreen()
  })

  it("shows a tool error when the tool failed", async () => {
    await render(
      bubble({ time: { created: 1, completed: 2 } }, [
        toolPart({ status: "error", title: "failing tool", input: {}, error: "command failed" }),
      ]),
    )

    await fireEvent.press(screen.getByText("failing tool"))
    expect(screen.getByText("command failed")).toBeOnTheScreen()
  })

  it("falls back to a generic message for an empty agent error", async () => {
    await render(
      bubble(
        { time: { created: 1, completed: 2 }, error: { name: "x", message: "" } as unknown as ChatMessageInfo["error"] },
        [textPart("done")],
      ),
    )

    expect(screen.getByText("Agent error")).toBeOnTheScreen()
  })

  it("omits zero cost and tokens from the usage line", async () => {
    await render(
      bubble(
        { time: { created: 1, completed: 2 }, modelID: "test-model", cost: 0, tokens: { output: 0 } as ChatMessageInfo["tokens"] },
        [textPart("done")],
      ),
    )

    expect(screen.getByText("test-model")).toBeOnTheScreen()
  })
})

describe("markdown theme", () => {
  it("follows the active theme instead of forcing dark", () => {
    expect(markdownColorScheme("light")).toBe("light")
    expect(markdownColorScheme("dark")).toBe("dark")
  })

  it("keeps bold and italic readable in light mode (web parity)", () => {
    const styles = createMarkdownStyles(palettes.light, systemFonts)

    // No white-on-paper text: every inline run carries the theme ink.
    expect(styles.body).toMatchObject({ color: palettes.light.text })
    expect(styles.strong).toMatchObject({ color: palettes.light.text })
    expect(styles.em).toMatchObject({ color: palettes.light.text })
    expect(styles.text).toMatchObject({ color: palettes.light.text })
  })

  it("keeps inline code on a readable surface in both modes (web parity)", () => {
    for (const theme of ["light", "dark"] as const) {
      const styles = createMarkdownStyles(palettes[theme], systemFonts)

      // Inline code is dark-on-muted in light mode (like the web), never the
      // pale code text on the pale muted surface.
      expect(styles.code_inline).toMatchObject({
        backgroundColor: palettes[theme].surfaceMuted,
        color: palettes[theme].text,
      })
    }
  })

  it("themes fenced code blocks instead of leaving them unstyled", () => {
    for (const theme of ["light", "dark"] as const) {
      const styles = createMarkdownStyles(palettes[theme], systemFonts)

      expect(styles.fence).toMatchObject({ borderColor: palettes[theme].hairline })
      expect(styles.fence_code).toMatchObject({ backgroundColor: palettes[theme].codeSurface })
      expect(styles.fence_token).toMatchObject({ color: palettes[theme].codeText })
    }
  })
})
