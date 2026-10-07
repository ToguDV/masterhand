import { describe, expect, it } from "vitest"
import type {
  ChatMessage,
  ChatPart,
  ChatToolPart,
  ChatToolState,
  SessionMessageAssistant,
  SessionMessageAssistantTool,
  SessionMessageInfo,
  SessionMessageUser,
  TokenUsageInfo,
} from "../src/types"
import {
  appendDelta,
  directoryName,
  formatCount,
  formatRelative,
  formatSpeed,
  formatTokens,
  isTaskTool,
  makeToolPart,
  mergeLiveMessages,
  placeholderAssistant,
  sessionUsage,
  setMessageCost,
  setStreamText,
  subagentInfo,
  subagentOutput,
  toChatMessage,
  tokenCounts,
  tokenSpeed,
  toolTitle,
  updateToolPart,
  upsertToolPart,
} from "../src/chat"

const SESSION = "ses_1"

function tokens(
  output: number,
  input = 0,
  reasoning = 0,
  cache: { read: number; write: number } = { read: 0, write: 0 },
): TokenUsageInfo {
  return { input, output, reasoning, cache }
}

function userMessage(id: string, text = "hi", created = 1): SessionMessageUser {
  return { type: "user", id, time: { created }, text }
}

function idleMessage(id: string): SessionMessageInfo {
  return { type: "idle", id, time: { created: 1 }, outcome: "succeeded" } as SessionMessageInfo
}

function toolMessage(
  id: string,
  name: string,
  state: SessionMessageAssistantTool["state"],
): SessionMessageAssistantTool {
  return { type: "tool", id, name, state, time: { created: 1 } }
}

function assistantMessage(overrides: Partial<SessionMessageAssistant> = {}): SessionMessageAssistant {
  return {
    type: "assistant",
    id: "msg_a",
    time: { created: 1, streamed: 2, completed: 3 },
    agent: "build",
    model: { id: "claude", providerID: "anthropic" },
    content: [],
    ...overrides,
  }
}

function chatMessage(id: string, parts: ChatPart[] = [], role: "user" | "assistant" = "assistant"): ChatMessage {
  return { info: { id, sessionID: SESSION, role, time: { created: 1 } }, parts }
}

function textPart(id: string, text: string, messageID = "msg_1"): ChatPart {
  return { id, sessionID: SESSION, messageID, type: "text", text }
}

function toolPart(id: string, state: ChatToolState, tool = "bash"): ChatToolPart {
  return { id, sessionID: SESSION, messageID: "msg_1", type: "tool", tool, callID: id, state }
}

describe("toChatMessage", () => {
  it("adapts a v2 user message with its text", () => {
    const message = toChatMessage(userMessage("msg_u", "hello", 7), SESSION)
    expect(message).toEqual({
      info: { id: "msg_u", sessionID: SESSION, role: "user", time: { created: 7 } },
      parts: [{ id: "msg_u:text", sessionID: SESSION, messageID: "msg_u", type: "text", text: "hello" }],
    })
  })

  it("keeps the metadata of a user message (the per-send delivery marker)", () => {
    const message = toChatMessage(
      {
        type: "user",
        id: "msg_u",
        time: { created: 7 },
        text: "hello",
        metadata: { "masterhand.delivery": "d1" },
      },
      SESSION,
    )
    expect(message?.info.metadata).toEqual({ "masterhand.delivery": "d1" })
  })

  it("adapts a v2 assistant message with metadata, content and usage", () => {
    const assistant = assistantMessage({
      content: [
        { type: "text", text: "answer" },
        { type: "reasoning", text: "thinking" },
      ],
      cost: 0.5,
      tokens: tokens(42),
      error: { type: "ProviderError", message: "nope", status: 500 },
    })

    const message = toChatMessage(assistant, SESSION)
    expect(message?.info).toEqual({
      id: "msg_a",
      sessionID: SESSION,
      role: "assistant",
      time: { created: 1, streamed: 2, completed: 3 },
      agent: "build",
      providerID: "anthropic",
      modelID: "claude",
      cost: 0.5,
      tokens: tokens(42),
      error: { type: "ProviderError", message: "nope", status: 500 },
    })
    expect(message?.parts.map((part) => part.type)).toEqual(["text", "reasoning"])
    expect(message?.parts[0]?.id).toBe("msg_a:text:0")
    expect(message?.parts[1]?.id).toBe("msg_a:reasoning:0")
  })

  it("tolerates assistant messages without model or usage", () => {
    const assistant = {
      type: "assistant",
      id: "msg_a",
      time: { created: 1 },
      agent: "build",
      content: [{ type: "text", text: "x" }],
    } as SessionMessageAssistant

    const message = toChatMessage(assistant, SESSION)
    expect(message?.info.providerID).toBeUndefined()
    expect(message?.info.modelID).toBeUndefined()
    expect(message?.info.cost).toBeUndefined()
    expect(message?.info.tokens).toBeUndefined()
  })

  it("returns null for non-chat message entries", () => {
    expect(toChatMessage(idleMessage("msg_idle"), SESSION)).toBeNull()
    expect(
      toChatMessage({ type: "system", id: "msg_sys", time: { created: 1 }, text: "x" }, SESSION),
    ).toBeNull()
  })

  it("maps tool states to the chat view model", () => {
    const streaming = toChatMessage(
      assistantMessage({
        content: [toolMessage("tool_1", "bash", { status: "streaming", input: '{"cmd"' })],
      }),
      SESSION,
    )
    const pending = streaming?.parts[0] as ChatToolPart
    expect(pending).toMatchObject({
      type: "tool",
      tool: "bash",
      callID: "tool_1",
      state: { status: "pending", input: {}, raw: '{"cmd"' },
    })

    const running = toChatMessage(
      assistantMessage({
        content: [
          toolMessage("tool_2", "read", {
            status: "running",
            input: { file: "a.ts" },
            metadata: { title: "Reading" },
          }),
        ],
      }),
      SESSION,
    )
    const started = running?.parts[0] as ChatToolPart
    expect(started.state).toEqual({
      status: "running",
      input: { file: "a.ts" },
      metadata: { title: "Reading" },
      title: "Reading",
      timing: { created: 1, ran: undefined, completed: undefined },
    })

    const completed = toChatMessage(
      assistantMessage({
        content: [
          toolMessage("tool_3", "bash", {
            status: "completed",
            input: {},
            content: [
              { type: "text", text: "out" },
              { type: "file", uri: "file://x", mime: "text/plain", name: "x.ts" },
            ],
            metadata: { title: "Done" },
          }),
        ],
      }),
      SESSION,
    )
    const done = completed?.parts[0] as ChatToolPart
    expect(done.state).toEqual({
      status: "completed",
      input: {},
      output: "out\n[x.ts] file://x",
      metadata: { title: "Done" },
      title: "Done",
      timing: { created: 1, ran: undefined, completed: undefined },
    })

    const failed = toChatMessage(
      assistantMessage({
        content: [
          toolMessage("tool_4", "bash", {
            status: "error",
            input: {},
            error: { type: "ToolError", message: "kaboom" },
            content: [{ type: "text", text: "details" }],
          }),
        ],
      }),
      SESSION,
    )
    const error = failed?.parts[0] as ChatToolPart
    expect(error.state).toEqual({
      status: "error",
      input: {},
      output: "details",
      error: "kaboom",
      metadata: undefined,
      timing: { created: 1, ran: undefined, completed: undefined },
    })
  })

  it("survives an error tool state without an error payload", () => {
    const failed = toChatMessage(
      assistantMessage({
        content: [
          toolMessage("tool_5", "bash", {
            status: "error",
            input: {},
          } as unknown as SessionMessageAssistantTool["state"]),
        ],
      }),
      SESSION,
    )
    const part = failed?.parts[0] as ChatToolPart
    expect(part.state).toMatchObject({ status: "error", error: "Tool failed" })
  })

  it("omits tool output when there is no renderable content", () => {
    const running = toChatMessage(
      assistantMessage({
        content: [
          toolMessage("tool_1", "bash", { status: "running", input: {}, metadata: {} }),
        ],
      }),
      SESSION,
    )
    expect((running?.parts[0] as ChatToolPart).state.title).toBeUndefined()

    const completed = toChatMessage(
      assistantMessage({
        content: [
          toolMessage("tool_2", "bash", {
            status: "completed",
            input: {},
            content: [],
          } as unknown as SessionMessageAssistantTool["state"]),
        ],
      }),
      SESSION,
    )
    expect((completed?.parts[0] as ChatToolPart).state.output).toBeUndefined()
  })

  it("names file outputs by their URI when they have no name", () => {
    const completed = toChatMessage(
      assistantMessage({
        content: [
          toolMessage("tool_1", "read", {
            status: "completed",
            input: {},
            content: [{ type: "file", uri: "file://plain", mime: "text/plain" }],
          }),
        ],
      }),
      SESSION,
    )
    expect((completed?.parts[0] as ChatToolPart).state.output).toBe("[file://plain] file://plain")
  })
})

describe("content projection", () => {
  it("projects text, reasoning and tool parts with per-kind ordinal ids", () => {
    const message = toChatMessage(
      assistantMessage({
        content: [
          { type: "text", text: "hello" },
          { type: "reasoning", text: "think" },
          toolMessage("t1", "bash", { status: "running", input: {}, metadata: {} }),
        ],
      }),
      SESSION,
    )
    const parts = message?.parts ?? []

    expect(parts.map((part) => [part.id, part.type])).toEqual([
      ["msg_a:text:0", "text"],
      ["msg_a:reasoning:0", "reasoning"],
      ["t1", "tool"],
    ])
    expect(parts[0]).toEqual({ id: "msg_a:text:0", sessionID: SESSION, messageID: "msg_a", type: "text", text: "hello" })
    expect(parts[2]).toMatchObject({ type: "tool", tool: "bash", callID: "t1" })
  })

  it("numbers repeated parts of the same kind with the streaming scheme", () => {
    const message = toChatMessage(
      assistantMessage({
        content: [
          { type: "text", text: "first" },
          toolMessage("t1", "bash", { status: "running", input: {}, metadata: {} }),
          { type: "text", text: "second" },
          { type: "reasoning", text: "why" },
        ],
      }),
      SESSION,
    )

    expect(message?.parts.map((part) => part.id)).toEqual(["msg_a:text:0", "t1", "msg_a:text:1", "msg_a:reasoning:0"])
  })

  it("returns no parts for empty content", () => {
    expect(toChatMessage(assistantMessage(), SESSION)?.parts).toEqual([])
  })
})

describe("message list helpers", () => {
  it("creates a placeholder assistant message", () => {
    expect(placeholderAssistant(SESSION, "msg_new", 42)).toEqual({
      info: { id: "msg_new", sessionID: SESSION, role: "assistant", time: { created: 42 } },
      parts: [],
    })
  })
})

describe("streaming reducers", () => {
  it("appends deltas to a new text part", () => {
    let list = [chatMessage("msg_1")]
    list = appendDelta(list, { sessionID: SESSION, messageID: "msg_1", ordinal: 0, kind: "text", delta: "hel" }, 5)
    list = appendDelta(list, { sessionID: SESSION, messageID: "msg_1", ordinal: 0, kind: "text", delta: "lo" }, 6)

    expect(list[0]?.parts).toEqual([
      { id: "msg_1:text:0", sessionID: SESSION, messageID: "msg_1", type: "text", text: "hello" },
    ])
  })

  it("appends reasoning deltas to their own part", () => {
    let list = [chatMessage("msg_1")]
    list = appendDelta(list, { sessionID: SESSION, messageID: "msg_1", ordinal: 1, kind: "reasoning", delta: "why" }, 5)
    expect(list[0]?.parts[0]).toMatchObject({ id: "msg_1:reasoning:1", type: "reasoning", text: "why" })
  })

  it("creates a placeholder message when the target is missing", () => {
    const list = appendDelta(
      [],
      { sessionID: SESSION, messageID: "msg_new", ordinal: 0, kind: "text", delta: "x" },
      99,
    )
    expect(list[0]?.info).toEqual({
      id: "msg_new",
      sessionID: SESSION,
      role: "assistant",
      time: { created: 99 },
    })
    expect(list[0]?.parts).toHaveLength(1)
  })

  it("leaves a part untouched when its type does not match the stream", () => {
    const existing = textPart("msg_1:reasoning:0", "already text")
    const list = [chatMessage("msg_1", [existing])]
    const next = appendDelta(list, { sessionID: SESSION, messageID: "msg_1", ordinal: 0, kind: "reasoning", delta: "d" })
    expect(next[0]?.parts).toEqual([existing])
  })

  it("replaces streamed text with the final text", () => {
    let list = [chatMessage("msg_1")]
    list = setStreamText(list, { sessionID: SESSION, messageID: "msg_1", ordinal: 0, kind: "text", text: "final" }, 5)
    expect(list[0]?.parts).toEqual([
      { id: "msg_1:text:0", sessionID: SESSION, messageID: "msg_1", type: "text", text: "final" },
    ])

    list = setStreamText(list, { sessionID: SESSION, messageID: "msg_1", ordinal: 0, kind: "text", text: "corrected" }, 6)
    expect(list[0]?.parts).toHaveLength(1)
    expect(list[0]?.parts[0]).toMatchObject({ text: "corrected" })
  })

  it("creates the message and part when setting final text on missing targets", () => {
    const list = setStreamText(
      [],
      { sessionID: SESSION, messageID: "msg_new", ordinal: 2, kind: "reasoning", text: "done" },
      77,
    )
    expect(list[0]?.info.id).toBe("msg_new")
    expect(list[0]?.parts[0]).toEqual({
      id: "msg_new:reasoning:2",
      sessionID: SESSION,
      messageID: "msg_new",
      type: "reasoning",
      text: "done",
    })
  })
})

describe("mergeLiveMessages", () => {
  it("keeps streamed text while the projected step is still open", () => {
    const live = [chatMessage("msg_1", [textPart("msg_1:text:0", "Working…")])]
    const projected = [chatMessage("msg_1", [textPart("msg_1:text:0", "")])]

    expect(mergeLiveMessages(live, projected)).toEqual(live)
  })

  it("keeps live parts the projection does not carry yet", () => {
    const live = [
      chatMessage("msg_1", [
        textPart("msg_1:text:0", "Working…"),
        textPart("msg_1:text:1", "more", "msg_1"),
      ]),
    ]
    const projected = [chatMessage("msg_1", [textPart("msg_1:text:0", "")])]

    expect(mergeLiveMessages(live, projected)[0]?.parts.map((part) => part.id)).toEqual([
      "msg_1:text:0",
      "msg_1:text:1",
    ])
  })

  it("takes the authoritative projection once the message completes", () => {
    const live = [chatMessage("msg_1", [textPart("msg_1:text:0", "Working…")])]
    const completed: ChatMessage = {
      info: { id: "msg_1", sessionID: SESSION, role: "assistant", time: { created: 1, completed: 2 } },
      parts: [textPart("msg_1:text:0", "final text")],
    }

    expect(mergeLiveMessages(live, [completed])).toEqual([completed])
  })

  it("keeps the projected tool state over the live one", () => {
    const live = [chatMessage("msg_1", [toolPart("call_1", { status: "running", input: {} })])]
    const projected = [
      chatMessage("msg_1", [toolPart("call_1", { status: "completed", input: {}, output: "done" })]),
    ]

    const merged = mergeLiveMessages(live, projected)
    expect(merged[0]?.parts).toEqual(projected[0]?.parts)
  })

  it("returns the projection when there is no live cache", () => {
    const projected = [chatMessage("msg_1", [textPart("msg_1:text:0", "")])]
    expect(mergeLiveMessages(undefined, projected)).toBe(projected)
    expect(mergeLiveMessages([], projected)).toBe(projected)
  })
})

describe("tool reducers", () => {
  it("builds tool parts", () => {
    expect(makeToolPart(SESSION, "msg_1", "call_1", "bash", { status: "pending", input: {} })).toEqual({
      id: "call_1",
      sessionID: SESSION,
      messageID: "msg_1",
      type: "tool",
      tool: "bash",
      callID: "call_1",
      state: { status: "pending", input: {} },
    })
  })

  it("inserts a tool part and replaces it by callID", () => {
    let list = [chatMessage("msg_1")]
    list = upsertToolPart(list, SESSION, "msg_1", toolPart("call_1", { status: "pending", input: {} }), 5)
    expect(list[0]?.parts).toHaveLength(1)

    list = upsertToolPart(list, SESSION, "msg_1", toolPart("call_1", { status: "running", input: { a: 1 } }), 6)
    expect(list[0]?.parts).toHaveLength(1)
    expect((list[0]?.parts[0] as ChatToolPart).state.status).toBe("running")
  })

  it("updates an existing tool part through the updater", () => {
    const list = [chatMessage("msg_1", [toolPart("call_1", { status: "pending", input: {} })])]
    const next = updateToolPart(
      list,
      SESSION,
      "msg_1",
      "call_1",
      (part) => ({ ...part, state: { ...part.state, status: "running" } }),
      (part) => part,
    )
    expect((next[0]?.parts[0] as ChatToolPart).state.status).toBe("running")
  })

  it("creates a missing tool part through the fallback", () => {
    const list = updateToolPart(
      [chatMessage("msg_1")],
      SESSION,
      "msg_1",
      "call_9",
      (part) => part,
      (part) => ({ ...part, tool: "detected", state: { ...part.state, status: "running" } }),
    )
    expect(list[0]?.parts[0]).toEqual(
      toolPart("call_9", { status: "running", input: {} }, "detected"),
    )
  })
})

describe("setMessageCost", () => {
  it("stores cost and tokens without touching the timestamps", () => {
    const list = setMessageCost([chatMessage("msg_1")], SESSION, "msg_1", {
      cost: 0.25,
      tokens: tokens(7),
    })
    expect(list[0]?.info.cost).toBe(0.25)
    expect(list[0]?.info.tokens).toEqual(tokens(7))
    expect(list[0]?.info.time).toEqual({ created: 1 })
  })

  it("marks the message completed when the step finishes", () => {
    const list = setMessageCost([chatMessage("msg_1")], SESSION, "msg_1", { finish: "stop" })
    expect(list[0]?.info.time.completed).toBeTypeOf("number")
    expect(list[0]?.info.time.streamed).toBeTypeOf("number")
  })

  it("keeps an existing completion timestamp", () => {
    const message = chatMessage("msg_1")
    message.info.time.completed = 3
    const list = setMessageCost([message], SESSION, "msg_1", { finish: "stop" })
    expect(list[0]?.info.time.completed).toBe(3)
  })

  it("creates a placeholder when the message is missing", () => {
    const list = setMessageCost([], SESSION, "msg_new", { cost: 1 })
    expect(list[0]?.info).toMatchObject({ id: "msg_new", cost: 1, role: "assistant" })
    expect(list[0]?.parts).toEqual([])
  })
})

describe("sessionUsage", () => {
  it("totals cost, every token category and the model time across assistant messages only", () => {
    const list: ChatMessage[] = [
      chatMessage("msg_u", [], "user"),
      {
        ...chatMessage("msg_a1"),
        info: {
          ...chatMessage("msg_a1").info,
          time: { created: 1, completed: 3001 },
          cost: 0.5,
          tokens: tokens(100, 1000, 20, { read: 50, write: 10 }),
        },
      },
      {
        ...chatMessage("msg_a2"),
        info: {
          ...chatMessage("msg_a2").info,
          time: { created: 10, completed: 1010 },
          cost: 0.25,
          tokens: tokens(50, 200, 5, { read: 30, write: 2 }),
        },
      },
    ]
    expect(sessionUsage(list)).toEqual({
      cost: 0.75,
      durationMs: 4000,
      input: 1200,
      output: 150,
      reasoning: 25,
      cacheRead: 80,
      cacheWrite: 12,
    })
  })

  it("tolerates assistant messages without usage", () => {
    expect(sessionUsage([chatMessage("msg_a")])).toEqual({
      cost: 0,
      durationMs: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    })
    expect(sessionUsage([])).toEqual({
      cost: 0,
      durationMs: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    })
  })
})

describe("tokenCounts and formatTokens", () => {
  it("normalizes a full TokenUsageInfo", () => {
    expect(tokenCounts(tokens(100, 1000, 20, { read: 50, write: 10 }))).toEqual({
      input: 1000,
      output: 100,
      reasoning: 20,
      cacheRead: 50,
      cacheWrite: 10,
    })
  })

  it("normalizes missing tokens to zeros", () => {
    expect(tokenCounts(undefined)).toEqual({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
  })

  it("formats every non-zero category with abbreviated counts, skipping the rest", () => {
    expect(formatTokens(tokenCounts(tokens(100, 1000, 20, { read: 50, write: 10 })))).toBe(
      "1k input · 100 output · 20 reasoning · 50 cache read · 10 cache write",
    )
    expect(formatTokens(tokenCounts(tokens(100, 1500)))).toBe("1.5k input · 100 output")
    expect(formatTokens(tokenCounts(undefined))).toBe("")
  })
})

describe("formatCount", () => {
  it("abbreviates thousands, millions and billions", () => {
    expect(formatCount(999)).toBe("999")
    expect(formatCount(1000)).toBe("1k")
    expect(formatCount(1200)).toBe("1.2k")
    expect(formatCount(12345)).toBe("12.3k")
    expect(formatCount(1_000_000)).toBe("1m")
    expect(formatCount(1_500_000)).toBe("1.5m")
    expect(formatCount(1_250_000_000)).toBe("1.3b")
  })

  it("promotes a value that would round up to the next unit", () => {
    expect(formatCount(999_999)).toBe("1m")
    expect(formatCount(999_999_999)).toBe("1b")
  })

  it("passes through non-finite values", () => {
    expect(formatCount(Number.POSITIVE_INFINITY)).toBe("0")
    expect(formatCount(Number.NaN)).toBe("0")
  })
})

describe("tokenSpeed and formatSpeed", () => {
  it("measures generated tokens (output + reasoning) per second", () => {
    expect(tokenSpeed(tokenCounts(tokens(100, 1000, 100)), 4000)).toBe(50)
    expect(tokenSpeed(tokenCounts(tokens(100, 1000)), 2000)).toBe(50)
  })

  it("returns null when there is nothing to measure", () => {
    expect(tokenSpeed(tokenCounts(undefined), 1000)).toBeNull()
    expect(tokenSpeed(tokenCounts(tokens(100)), 0)).toBeNull()
  })

  it("formats a speed as a whole number", () => {
    expect(formatSpeed(42.348)).toBe("42 tok/s")
    expect(formatSpeed(45.67)).toBe("46 tok/s")
    expect(formatSpeed(42)).toBe("42 tok/s")
    expect(formatSpeed(0.4)).toBe("0 tok/s")
    expect(formatSpeed(null)).toBe("")
  })
})

describe("message helpers", () => {
  it("labels tool parts by state", () => {
    expect(toolTitle(toolPart("c", { status: "running", input: {}, title: "Running ls" }))).toBe("Running ls")
    expect(toolTitle(toolPart("c", { status: "running", input: {} }))).toBe("bash")
    expect(toolTitle(toolPart("c", { status: "completed", input: {}, title: "Done" }))).toBe("Done")
    expect(toolTitle(toolPart("c", { status: "completed", input: {} }))).toBe("bash")
    expect(toolTitle(toolPart("c", { status: "error", input: {} }))).toBe("Error")
    expect(toolTitle(toolPart("c", { status: "pending", input: {} }))).toBe("Preparing…")
  })
})

describe("subagent helpers", () => {
  const subagent = toolPart(
    "call_1",
    {
      status: "completed",
      input: { agent: "explore", description: "Find files", prompt: "look for x" },
      output:
        '<subagent id="ses_child" state="completed">\n<summary>ignored</summary>\n<task_result>found it</task_result>\n</subagent>',
      metadata: { sessionID: "ses_child", background: false },
    },
    "subagent",
  )

  it("detects only the subagent tool", () => {
    expect(isTaskTool(subagent)).toBe(true)
    expect(isTaskTool(toolPart("c", { status: "pending", input: {} }, "bash"))).toBe(false)
    expect(isTaskTool(textPart("p", "hi"))).toBe(false)
  })

  it("normalizes the subagent input and metadata", () => {
    expect(subagentInfo(subagent)).toEqual({
      name: "explore",
      description: "Find files",
      prompt: "look for x",
      sessionID: "ses_child",
      background: false,
    })
  })

  it("falls back when a running subagent has no metadata yet", () => {
    const running = toolPart(
      "call_2",
      {
        status: "running",
        input: { agent: "" },
        title: "Working",
        metadata: { sessionId: "ses_x", background: true },
      },
      "subagent",
    )
    expect(subagentInfo(running)).toEqual({
      name: "subagent",
      description: "Working",
      prompt: null,
      sessionID: "ses_x",
      background: true,
    })
  })

  it("falls back to the tool title when input and metadata are empty", () => {
    const empty = toolPart("call_3", { status: "pending", input: {} }, "subagent")
    expect(subagentInfo(empty)).toEqual({
      name: "subagent",
      description: "Preparing…",
      prompt: null,
      sessionID: null,
      background: false,
    })
  })

  it("strips the subagent wrapper tags from completed output", () => {
    expect(subagentOutput(subagent)).toBe("found it")
    expect(
      subagentOutput(
        toolPart(
          "call_4",
          {
            status: "completed",
            input: {},
            output: '<task id="x">\n<task_result>done</task_result>\n</task>',
          },
          "subagent",
        ),
      ),
    ).toBe("done")
  })

  it("returns null without completed output", () => {
    const running = toolPart("call_5", { status: "running", input: {} }, "subagent")
    expect(subagentOutput(running)).toBeNull()
    expect(
      subagentOutput(toolPart("call_6", { status: "completed", input: {} }, "subagent")),
    ).toBeNull()
    expect(
      subagentOutput(
        toolPart(
          "call_7",
          {
            status: "completed",
            input: {},
            output: "<task><task_result>   </task_result></task>",
          },
          "subagent",
        ),
      ),
    ).toBeNull()
  })
})

describe("formatting utilities", () => {
  it("extracts the directory name", () => {
    expect(directoryName("/home/user/projects/app")).toBe("app")
    expect(directoryName("/home/user/projects/app/")).toBe("app")
    expect(directoryName("/")).toBe("/")
    expect(directoryName("")).toBe("")
  })

  it("formats relative timestamps", () => {
    const now = 10_000_000_000
    expect(formatRelative(now, now)).toBe("now")
    expect(formatRelative(now + 5_000, now)).toBe("now")
    expect(formatRelative(now - 5 * 60_000, now)).toBe("5 min ago")
    expect(formatRelative(now - 3 * 3_600_000, now)).toBe("3 h ago")
    expect(formatRelative(now - 2 * 86_400_000, now)).toBe("2 d ago")
    expect(formatRelative(now - 40 * 86_400_000, now)).toBe(new Date(now - 40 * 86_400_000).toLocaleDateString())
  })

})
