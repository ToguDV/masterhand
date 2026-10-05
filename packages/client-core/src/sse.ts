// Duplicated in `apps/server/src/sse.ts`: the browser clients and the Node BFF
// build share no module, so both copies must stay in sync.
export interface SseMessage {
  event?: string
  data: string
  id?: string
}

function parseBlock(block: string): SseMessage | null {
  const lines = block.split("\n")
  let data = ""
  let event: string | undefined
  let id: string | undefined

  for (const line of lines) {
    if (!line || line.startsWith(":")) continue
    const colon = line.indexOf(":")
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? "" : line.slice(colon + 1)
    if (value.startsWith(" ")) value = value.slice(1)

    if (field === "data") data += (data ? "\n" : "") + value
    else if (field === "event") event = value
    else if (field === "id") id = value
  }

  if (!data && !event && !id) return null
  return { event, data, id }
}

export interface SseParseOptions {
  /**
   * Called for every raw chunk, including comment-only heartbeats that never
   * yield a message, so callers can watch the connection's liveness.
   */
  onActivity?: () => void
}

export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
  options: SseParseOptions = {},
): AsyncGenerator<SseMessage> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  // A chunk can split a CRLF pair (`\r` ends one chunk, `\n` starts the next).
  // Normalizing per chunk would turn the pair into two line endings (a spurious
  // blank line), so a trailing CR is held until the next chunk arrives.
  let pendingCR = false

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      options.onActivity?.()
      let text = decoder.decode(value, { stream: true })
      if (pendingCR) {
        // The held CR was a line ending: drop the LF half when the chunk
        // completes the pair, otherwise keep the lone CR as a terminator.
        text = text.startsWith("\n") ? `\n${text.slice(1)}` : `\n${text}`
        pendingCR = false
      }
      text = text.replace(/\r\n/g, "\n")
      if (text.endsWith("\r")) {
        pendingCR = true
        text = text.slice(0, -1)
      }
      buffer += text.replace(/\r/g, "\n")

      let separator = buffer.indexOf("\n\n")
      while (separator !== -1) {
        const block = buffer.slice(0, separator)
        buffer = buffer.slice(separator + 2)
        const message = parseBlock(block)
        if (message) yield message
        separator = buffer.indexOf("\n\n")
      }
    }
    if (pendingCR) buffer += "\n"
    const rest = parseBlock(buffer)
    if (rest) yield rest
  } finally {
    reader.releaseLock()
  }
}
