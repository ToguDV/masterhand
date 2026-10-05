import { describe, expect, it } from "vitest"
import { parseSseStream, type SseMessage } from "../src/sse.js"

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<SseMessage[]> {
  const messages: SseMessage[] = []
  for await (const message of parseSseStream(stream)) messages.push(message)
  return messages
}

describe("parseSseStream", () => {
  it("parses data, event and id fields", async () => {
    const messages = await collect(streamOf("event: ping\nid: 7\ndata: hello\n\n"))
    expect(messages).toEqual([{ event: "ping", id: "7", data: "hello" }])
  })

  it("joins multiple data lines with newlines", async () => {
    const messages = await collect(streamOf("data: line one\ndata: line two\n\n"))
    expect(messages[0]?.data).toBe("line one\nline two")
  })

  it("ignores comments and blank lines", async () => {
    const messages = await collect(streamOf(": keep-alive\n\ndata: real\n\n"))
    expect(messages).toEqual([{ event: undefined, id: undefined, data: "real" }])
  })

  it("normalizes CRLF and CR line endings", async () => {
    const messages = await collect(streamOf("data: a\r\n\r\ndata: b\r\r"))
    expect(messages.map((message) => message.data)).toEqual(["a", "b"])
  })

  it("reassembles blocks split across chunks", async () => {
    const messages = await collect(streamOf("data: he", "llo\n", "\ndata: wor", "ld\n\n"))
    expect(messages.map((message) => message.data)).toEqual(["hello", "world"])
  })

  it("treats a CRLF pair split across chunks as a single line ending", async () => {
    const messages = await collect(streamOf("data: one\r", "\ndata: two\n\n"))
    expect(messages).toEqual([{ event: undefined, id: undefined, data: "one\ntwo" }])
  })

  it("treats a CR ending a chunk as a line ending", async () => {
    const messages = await collect(streamOf("data: a\r", "data: b\n\n"))
    expect(messages).toEqual([{ event: undefined, id: undefined, data: "a\nb" }])
  })

  it("drops blocks without any field", async () => {
    const messages = await collect(streamOf("\n\n\ndata: ok\n\n"))
    expect(messages).toEqual([{ event: undefined, id: undefined, data: "ok" }])
  })

  it("emits a trailing block without a final separator", async () => {
    const messages = await collect(streamOf("data: tail"))
    expect(messages).toEqual([{ event: undefined, id: undefined, data: "tail" }])
  })

  it("treats a field without a colon as empty value", async () => {
    const messages = await collect(streamOf("retry\ndata: x\n\n"))
    expect(messages).toEqual([{ event: undefined, id: undefined, data: "x" }])
  })

  it("reports raw activity for comment-only heartbeat chunks", async () => {
    let activity = 0
    const messages: SseMessage[] = []
    for await (const message of parseSseStream(streamOf(": heartbeat\n\n", ": heartbeat\n\n"), {
      onActivity: () => {
        activity += 1
      },
    })) {
      messages.push(message)
    }
    expect(messages).toEqual([])
    expect(activity).toBe(2)
  })
})
