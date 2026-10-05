import { createServer, type IncomingMessage, type ServerResponse } from "node:http"

const port = Number(process.env.MOCK_PORT ?? 4097)

interface TokenUsage {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

interface ModelRef {
  id: string
  providerID: string
  variant?: string
}

interface SessionRecord {
  id: string
  parentID?: string
  fork?: { sessionID: string; boundary: { type: "through"; messageID: string } }
  projectID: string
  agent?: string
  model?: ModelRef
  cost: number
  tokens: TokenUsage
  time: { created: number; updated: number }
  title: string
  location: { directory: string }
  metadata?: Record<string, unknown>
}

interface UserMessage {
  id: string
  sessionID: string
  time: { created: number }
  text: string
  metadata?: Record<string, unknown>
  type: "user"
}

interface AssistantText {
  type: "text"
  text: string
}

interface AssistantTool {
  type: "tool"
  id: string
  name: string
  executed?: boolean
  state: Record<string, unknown>
  time: { created: number; ran?: number; completed?: number }
}

interface AssistantMessage {
  id: string
  sessionID: string
  time: { created: number; streamed?: number; completed?: number }
  type: "assistant"
  agent: string
  model: ModelRef
  content: Array<AssistantText | AssistantTool>
  finish?: string
  cost?: number
  tokens?: TokenUsage
}

type SessionMessage = UserMessage | AssistantMessage

interface PendingPermission {
  request: Record<string, unknown>
  sessionID: string
  directory: string
  resolve: (decision: string) => void
}

/** A v2 form (the primitive behind the agent's `question` tool) awaiting a reply. */
interface PendingForm {
  info: Record<string, unknown>
  sessionID: string
  directory: string
  /** `null` means cancelled. */
  resolve: (answer: Record<string, unknown> | null) => void
}

const sseClients = new Set<ServerResponse>()
const sessions = new Map<string, SessionRecord>()
const conversations = new Map<string, SessionMessage[]>()
/** Order of the first message page per session (cursor pages inherit it). */
const messageOrders = new Map<string, string>()
const pendingPermissions = new Map<string, PendingPermission>()
const pendingForms = new Map<string, PendingForm>()
const activeRuns = new Set<string>()
/** Managed dev-server processes created through the PTY API. */
const ptys = new Map<string, { id: string; title: string; status: string; pid: number; directory: string }>()

// E2E control: makes the mock unreachable (503) and drops its SSE clients, so
// the BFF hub retries and tests can cover the upstream reconnection recovery.
let offline = false
const catalogRequests = { agent: 0, model: 0 }

// E2E control: holds prompt responses so a test can reproduce a stalled send
// (the request never settles). `stall-prompt` holds before processing (nothing
// runs); `stall-response` holds after processing (the agent works and finishes,
// only the HTTP response is lost). `/e2e/release-prompt` flushes held responses.
let stallPrompts = false
let stallResponses = false
const heldPrompts: Array<() => void> = []
/** How many prompt requests reached the mock (read via `/e2e/state`). */
let promptRequests = 0
/** Session the last prompt request targeted, used by the message-injection control. */
let lastPromptSessionID: string | null = null
// E2E control: hold `/fork` responses, fail prompt requests, and count forks so
// the /btw orphan tests can prove created forks are removed.
let stallForks = false
let failPrompts = false
let forksCreated = 0
let forksRemoved = 0
let heldForks = 0
// E2E controls for session-creation reconciliation: `stall-create` holds the
// response after creating (the response is lost), `stall-create-before` holds
// before creating (nothing exists to reconcile). `/e2e/release-create` flushes.
let stallCreate = false
let stallCreateBefore = false
const heldCreates: Array<() => void> = []

// Seed from the clock so ids never repeat across runs: the BFF reuses a
// persistent SQLite DATA_DIR locally, so restarting at `ses_1` every time
// collided with the `isolated_sessions.session_id` primary key.
let sequence = Date.now()
const nextId = (prefix: string): string => `${prefix}_${(++sequence).toString(36)}`
const now = (): number => Date.now()
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function emptyTokens(): TokenUsage {
  return { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) })
  res.end(payload)
}

function empty(res: ServerResponse, status = 204): void {
  res.writeHead(status)
  res.end()
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = ""
    req.on("data", (chunk) => (raw += chunk))
    req.on("end", () => {
      try {
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {})
      } catch {
        resolve({})
      }
    })
  })
}

/** Emits an opencode v2 event (`{ id, type, data, location? }`) to every SSE client. */
function broadcast(type: string, data: unknown, directory?: string): void {
  const event = {
    id: nextId("evt"),
    created: now(),
    type,
    ...(directory ? { location: { directory } } : {}),
    data,
  }
  const frame = `data: ${JSON.stringify(event)}\n\n`
  for (const client of sseClients) client.write(frame)
}

/** Drops every SSE client (the BFF hub reconnects on its own). */
function closeStreams(): void {
  for (const client of sseClients) client.end()
  sseClients.clear()
}

function openStream(res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  // Register before emitting: `server.connected` is the first frame of the
  // stream, and a client that misses it cannot reconcile (review F24-3).
  sseClients.add(res)
  broadcast("server.connected", {})
  const keepalive = setInterval(() => res.write(": ping\n\n"), 25_000)
  res.on("close", () => {
    clearInterval(keepalive)
    sseClients.delete(res)
  })
}

function createSession(input: {
  directory: string
  parentID?: string
  title?: string
  metadata?: Record<string, unknown>
}): SessionRecord {
  const session: SessionRecord = {
    id: nextId("ses"),
    projectID: "global",
    cost: 0,
    tokens: emptyTokens(),
    time: { created: now(), updated: now() },
    title: input.title ?? "",
    location: { directory: input.directory },
    ...(input.metadata ? { metadata: input.metadata } : {}),
  }
  if (input.parentID) session.parentID = input.parentID
  sessions.set(session.id, session)
  conversations.set(session.id, [])
  broadcast(
    "session.created",
    {
      sessionID: session.id,
      projectID: session.projectID,
      location: { directory: input.directory },
      ...(input.parentID ? { parentID: input.parentID } : {}),
      slug: "e2e-session",
      title: session.title,
      version: "2.0.6",
    },
    input.directory,
  )
  return session
}

function appendUserMessage(sessionID: string, text: string, metadata?: Record<string, unknown>): UserMessage {
  const message: UserMessage = {
    id: nextId("msg"),
    sessionID,
    time: { created: now() },
    text,
    ...(metadata ? { metadata } : {}),
    type: "user",
  }
  conversations.get(sessionID)?.push(message)
  const session = sessions.get(sessionID)
  if (session) session.time.updated = now()
  return message
}

function appendAssistantMessage(sessionID: string): AssistantMessage {
  const session = sessions.get(sessionID)
  const message: AssistantMessage = {
    id: nextId("msg"),
    sessionID,
    time: { created: now() },
    type: "assistant",
    agent: session?.agent ?? "build",
    model: session?.model ?? { id: "test-model", providerID: "test" },
    content: [],
  }
  conversations.get(sessionID)?.push(message)
  return message
}

function directoryOf(sessionID: string): string | undefined {
  return sessions.get(sessionID)?.location.directory
}

/** Streams one text part (`started` + deltas + `ended`) for an assistant message. */
function streamText(sessionID: string, messageID: string, ordinal: number, final: string): void {
  const directory = directoryOf(sessionID)
  broadcast("session.text.started", { sessionID, assistantMessageID: messageID, ordinal }, directory)
  broadcast("session.text.delta", { sessionID, assistantMessageID: messageID, ordinal, delta: final }, directory)
  broadcast("session.text.ended", { sessionID, assistantMessageID: messageID, ordinal, text: final }, directory)
}

function completeAssistant(
  session: SessionRecord,
  assistant: AssistantMessage,
  usage: { cost: number; tokens: TokenUsage; finish?: string },
): void {
  const completed = now()
  assistant.time = { created: assistant.time.created, streamed: completed, completed }
  assistant.finish = usage.finish ?? "stop"
  assistant.cost = usage.cost
  assistant.tokens = usage.tokens
  session.cost += usage.cost
  session.time.updated = completed
  broadcast(
    "session.step.ended",
    {
      sessionID: session.id,
      assistantMessageID: assistant.id,
      finish: assistant.finish,
      cost: usage.cost,
      tokens: usage.tokens,
    },
    session.location.directory,
  )
  broadcast("session.execution.succeeded", { sessionID: session.id }, session.location.directory)
}

async function runSubagentPrompt(sessionID: string, text: string): Promise<void> {
  const session = sessions.get(sessionID)
  const conversation = conversations.get(sessionID)
  if (!session || !conversation) return

  activeRuns.add(sessionID)
  broadcast("session.execution.started", { sessionID }, session.location.directory)
  await delay(30)

  const assistant = appendAssistantMessage(sessionID)
  const toolID = nextId("prt")
  const started = now()
  const input = {
    agent: "explore",
    description: "Explore the repository",
    prompt: "List the files in the project",
  }
  broadcast(
    "session.tool.input.started",
    { sessionID, assistantMessageID: assistant.id, id: toolID, name: "subagent" },
    session.location.directory,
  )
  const tool: AssistantTool = {
    type: "tool",
    id: toolID,
    name: "subagent",
    executed: true,
    state: { status: "running", input, metadata: { title: input.description }, time: { created: started } },
    time: { created: started },
  }
  assistant.content = [tool]
  broadcast(
    "session.tool.called",
    { sessionID, assistantMessageID: assistant.id, id: toolID, input, executed: true },
    session.location.directory,
  )

  await delay(80)

  // The subagent runs in its own session, linked through `parentID`.
  const child = createSession({
    directory: session.location.directory,
    parentID: sessionID,
    title: "Explore the repository (@explore subagent)",
  })
  appendUserMessage(child.id, input.prompt)
  const childAssistant = appendAssistantMessage(child.id)
  childAssistant.agent = "explore"
  childAssistant.content = [{ type: "text", text: "Found 3 files" }]
  const childCompleted = now()
  childAssistant.time = { created: childAssistant.time.created, streamed: childCompleted, completed: childCompleted }
  childAssistant.finish = "stop"
  childAssistant.cost = 0
  childAssistant.tokens = emptyTokens()

  await delay(60)

  const output = `<subagent id="${child.id}" state="completed">\n<summary>Explore completed</summary>\n<task_result>Found 3 files</task_result>\n</subagent>`
  const metadata = { sessionID: child.id, status: "completed" }
  tool.state = {
    status: "completed",
    input,
    content: [{ type: "text", text: output }],
    metadata,
    time: { start: started, end: now() },
  }
  broadcast(
    "session.tool.success",
    {
      sessionID,
      assistantMessageID: assistant.id,
      id: toolID,
      content: [{ type: "text", text: output }],
      metadata,
      executed: true,
    },
    session.location.directory,
  )

  completeAssistant(session, assistant, {
    cost: 0.001,
    // Non-zero cache values prove the stats row does not render them.
    tokens: { input: 10, output: 1, reasoning: 0, cache: { read: 5, write: 2 } },
  })
  activeRuns.delete(sessionID)
}

/** Streams a sequence of tool calls (shell, read, write, edit) and a wrap-up text. */
async function runToolsPrompt(sessionID: string): Promise<void> {
  const session = sessions.get(sessionID)
  if (!session) return
  const directory = session.location.directory

  activeRuns.add(sessionID)
  broadcast("session.execution.started", { sessionID }, directory)
  await delay(30)

  const assistant = appendAssistantMessage(sessionID)
  const tools: AssistantTool[] = []
  assistant.content = tools

  async function runTool(
    name: string,
    input: Record<string, unknown>,
    output: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    const id = nextId("prt")
    const created = now()
    broadcast(
      "session.tool.input.started",
      { sessionID, assistantMessageID: assistant.id, id, name },
      directory,
    )
    const tool: AssistantTool = {
      type: "tool",
      id,
      name,
      executed: true,
      state: { status: "running", input, metadata, time: { created } },
      time: { created },
    }
    tools.push(tool)
    await delay(20)
    broadcast(
      "session.tool.called",
      { sessionID, assistantMessageID: assistant.id, id, input, executed: true },
      directory,
    )
    await delay(40)
    const ran = now()
    tool.state = {
      status: "completed",
      input,
      content: [{ type: "text", text: output }],
      metadata,
      time: { created, ran },
    }
    tool.time = { created, ran, completed: now() }
    broadcast(
      "session.tool.success",
      {
        sessionID,
        assistantMessageID: assistant.id,
        id,
        content: [{ type: "text", text: output }],
        metadata,
        executed: true,
      },
      directory,
    )
  }

  await runTool("bash", { command: "npm test -- --run", description: "Run the test suite" }, "Tests passed", {
    exitCode: 0,
  })
  await runTool(
    "read",
    { filePath: "src/app.ts" },
    "Read file src/app.ts, lines 1-2\n1: export const app = 1\n2: export const port = 3000",
  )
  await runTool("write", { filePath: "src/new.ts", content: "export const answer = 42" }, "File written")
  await runTool(
    "edit",
    { filePath: "src/app.ts", oldString: "const value = 1", newString: "const value = 2\nconst more = 3" },
    "Edit applied",
  )

  const text = "All tools done."
  assistant.content = [...tools, { type: "text", text }]
  streamText(sessionID, assistant.id, 0, text)
  completeAssistant(session, assistant, {
    cost: 0.003,
    tokens: { input: 10, output: 3, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  activeRuns.delete(sessionID)
}

/** Streams a shell command denied by the permission guard (audit-log spec). */
async function runDeniedPrompt(sessionID: string): Promise<void> {
  const session = sessions.get(sessionID)
  if (!session) return
  const directory = session.location.directory

  activeRuns.add(sessionID)
  broadcast("session.execution.started", { sessionID }, directory)
  await delay(30)

  const assistant = appendAssistantMessage(sessionID)
  const id = nextId("prt")
  const created = now()
  const input = { command: "pkill -f node" }
  const tool: AssistantTool = {
    type: "tool",
    id,
    name: "bash",
    executed: false,
    state: { status: "running", input, time: { created } },
    time: { created },
  }
  broadcast(
    "session.tool.input.started",
    { sessionID, assistantMessageID: assistant.id, id, name: "bash" },
    directory,
  )
  await delay(20)
  broadcast(
    "session.tool.called",
    { sessionID, assistantMessageID: assistant.id, id, input, executed: true },
    directory,
  )
  await delay(40)
  const ran = now()
  const error = { type: "permission.rejected", message: "Permission denied: shell" }
  tool.state = { status: "error", input, error, time: { created, ran } }
  tool.time = { created, ran, completed: now() }
  broadcast(
    "session.tool.failed",
    { sessionID, assistantMessageID: assistant.id, id, error, content: [], metadata: {}, executed: false },
    directory,
  )

  const text = "That command was blocked by the permission guard."
  assistant.content = [tool, { type: "text", text }]
  streamText(sessionID, assistant.id, 0, text)
  completeAssistant(session, assistant, {
    cost: 0.001,
    tokens: { input: 10, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  activeRuns.delete(sessionID)
}

/**
 * Streams a `question` tool backed by a v2 form and blocks until the client
 * replies (or cancels) through `POST /api/session/:id/form/:formID/reply`.
 */
async function runQuestionPrompt(sessionID: string): Promise<void> {
  const session = sessions.get(sessionID)
  if (!session) return

  activeRuns.add(sessionID)
  broadcast("session.execution.started", { sessionID }, session.location.directory)
  await delay(30)

  const assistant = appendAssistantMessage(sessionID)
  const callID = nextId("prt")
  const created = now()
  const input = {
    questions: [
      {
        header: "Database",
        question: "Which database should the project use?",
        options: [
          { label: "Postgres", description: "Relational, battle tested" },
          { label: "SQLite", description: "Zero setup" },
        ],
        multiple: false,
      },
    ],
  }
  broadcast(
    "session.tool.input.started",
    { sessionID, assistantMessageID: assistant.id, id: callID, name: "question" },
    session.location.directory,
  )
  await delay(20)
  const tool: AssistantTool = {
    type: "tool",
    id: callID,
    name: "question",
    executed: true,
    state: { status: "running", input, metadata: {}, time: { created } },
    time: { created },
  }
  assistant.content = [tool]
  broadcast(
    "session.tool.called",
    { sessionID, assistantMessageID: assistant.id, id: callID, input, executed: true },
    session.location.directory,
  )

  const formID = nextId("frm")
  const form = {
    id: formID,
    sessionID,
    title: "Questions",
    metadata: { kind: "question", tool: { messageID: assistant.id, id: callID } },
    fields: [
      {
        // Real mapping of the `question` tool: key `qN`, title = header,
        // description = the question itself, option values = labels.
        key: "q0",
        type: "string",
        title: "Database",
        description: "Which database should the project use?",
        required: true,
        options: [
          { label: "Postgres", value: "Postgres", description: "Relational, battle tested" },
          { label: "SQLite", value: "SQLite", description: "Zero setup" },
        ],
        custom: true,
      },
      {
        key: "q1",
        type: "string",
        title: "Notes",
        description: "Anything else?",
        options: [],
        custom: true,
      },
    ],
  }
  const answer = await new Promise<Record<string, unknown> | null>((resolve) => {
    pendingForms.set(formID, { info: form, sessionID, directory: session.location.directory, resolve })
    broadcast("form.created", { form }, session.location.directory)
  })
  pendingForms.delete(formID)

  if (answer) broadcast("form.replied", { id: formID, sessionID, answer }, session.location.directory)
  else broadcast("form.cancelled", { id: formID, sessionID }, session.location.directory)

  const ran = now()
  const output = answer ? `Answered: ${JSON.stringify(answer)}` : "Question dismissed"
  tool.state = answer
    ? { status: "completed", input, content: [{ type: "text", text: output }], metadata: {}, time: { created, ran } }
    : { status: "error", input, error: { type: "QuestionCancelled", message: "Dismissed" }, metadata: {}, time: { created, ran } }
  tool.time = { created, ran, completed: now() }

  if (answer) {
    broadcast(
      "session.tool.success",
      {
        sessionID,
        assistantMessageID: assistant.id,
        id: callID,
        content: [{ type: "text", text: output }],
        metadata: {},
        executed: true,
      },
      session.location.directory,
    )
  } else {
    broadcast(
      "session.tool.failed",
      {
        sessionID,
        assistantMessageID: assistant.id,
        id: callID,
        error: { type: "QuestionCancelled", message: "Dismissed" },
        metadata: {},
        executed: true,
      },
      session.location.directory,
    )
  }

  await delay(20)
  assistant.content = [tool, { type: "text", text: answer ? "Thanks, moving on." : "Question dismissed." }]
  completeAssistant(session, assistant, {
    cost: 0.001,
    tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  activeRuns.delete(sessionID)
}

/** Streams a markdown-rich reply (exercised by `markdown.spec.ts`). */
async function runMarkdownPrompt(sessionID: string): Promise<void> {
  const session = sessions.get(sessionID)
  if (!session) return

  activeRuns.add(sessionID)
  broadcast("session.execution.started", { sessionID }, session.location.directory)
  await delay(30)

  const assistant = appendAssistantMessage(sessionID)
  const markdown = [
    "# Report",
    "",
    "Plain first line",
    "second line with **bold**, *italic*, ~~struck~~ and `inline code`.",
    "",
    "- first item",
    "- second item",
    "",
    "| Name | Value |",
    "| ---- | ----- |",
    "| alpha | 1 |",
    "",
    "```ts",
    "const a = 1",
    "```",
    "",
    "See the [docs](https://example.com/docs).",
  ].join("\n")
  assistant.content = [{ type: "text", text: markdown }]
  streamText(sessionID, assistant.id, 0, markdown)
  completeAssistant(session, assistant, {
    cost: 0.002,
    tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  activeRuns.delete(sessionID)
}

async function runPrompt(sessionID: string, text: string): Promise<void> {
  const session = sessions.get(sessionID)
  const conversation = conversations.get(sessionID)
  if (!session || !conversation) return

  if (text.toLowerCase().includes("subagent")) return runSubagentPrompt(sessionID, text)
  if (text.toLowerCase().includes("markdown")) return runMarkdownPrompt(sessionID)
  if (text.toLowerCase().includes("question")) return runQuestionPrompt(sessionID)
  if (text.toLowerCase().includes("denied")) return runDeniedPrompt(sessionID)
  if (text.toLowerCase().includes("tool")) return runToolsPrompt(sessionID)

  activeRuns.add(sessionID)
  broadcast("session.execution.started", { sessionID }, session.location.directory)
  await delay(30)

  const assistant = appendAssistantMessage(sessionID)
  assistant.content = [{ type: "text", text: "Working…" }]
  streamText(sessionID, assistant.id, 0, "Working…")

  await delay(30)

  // A permission request pauses the turn until the client replies through
  // `POST /api/session/:id/permission/:requestID/reply`.
  const permissionID = nextId("per")
  const request: Record<string, unknown> = {
    id: permissionID,
    sessionID,
    action: "bash",
    resources: ["ls"],
    save: ["ls *"],
    metadata: { command: "ls" },
  }
  const decision = new Promise<string>((resolve) =>
    pendingPermissions.set(permissionID, {
      request,
      sessionID,
      directory: session.location.directory,
      resolve,
    }),
  )
  broadcast("permission.asked", request, session.location.directory)
  await decision
  pendingPermissions.delete(permissionID)

  await delay(30)

  assistant.content = [{ type: "text", text: "Done!" }]
  broadcast(
    "session.text.ended",
    { sessionID, assistantMessageID: assistant.id, ordinal: 0, text: "Done!" },
    session.location.directory,
  )
  completeAssistant(session, assistant, {
    cost: 0.001,
    tokens: { input: 10, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  activeRuns.delete(sessionID)
}

const MODELS = [
  { id: "test-model", providerID: "test", name: "Test Model", variants: [{ id: "low" }, { id: "high" }] },
  { id: "alpha", providerID: "test", name: "Alpha", variants: [] },
  { id: "beta", providerID: "test", name: "Beta", variants: [] },
  { id: "gamma", providerID: "test", name: "Gamma", variants: [] },
  { id: "delta", providerID: "test", name: "Delta", variants: [] },
  { id: "solo", providerID: "other", name: "Solo", variants: [] },
  { id: "echo", providerID: "other", name: "Echo", variants: [] },
  { id: "nova", providerID: "other", name: "Nova", variants: [] },
  { id: "flash", providerID: "other", name: "Flash", variants: [] },
].map((model) => ({
  ...model,
  modelID: model.id,
  enabled: true,
  status: "active",
  capabilities: {},
  cost: [],
  limit: { context: 128_000, output: 8_192 },
  time: { released: 0 },
}))

const PROVIDERS = [
  { id: "test", name: "Test", activation: "auto", package: "" },
  { id: "other", name: "Other", activation: "auto", package: "" },
]

const AGENTS = [
  { id: "build", name: "build", mode: "primary", hidden: false },
  { id: "plan", name: "plan", mode: "primary", hidden: false },
  { id: "general", name: "general", mode: "subagent", hidden: false },
  { id: "explore", name: "explore", mode: "subagent", hidden: false },
  { id: "title", name: "title", mode: "primary", hidden: true },
]

const COMMANDS = [
  { name: "review", description: "review changes [commit|branch|pr], defaults to uncommitted" },
  { name: "component", description: "Create a new component" },
]

const COMMAND_TEMPLATES: Record<string, string> = {
  component: "Create a new React component named $ARGUMENTS with TypeScript support.",
  review: "Review the changes: $ARGUMENTS",
}

const DEFAULT_DIRECTORY = "/e2e/project"

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost")
  const path = url.pathname
  const segments = path.split("/").filter(Boolean)

  if (path === "/api/agent") catalogRequests.agent += 1
  if (path === "/api/model") catalogRequests.model += 1

  void (async () => {
    // E2E control routes: simulate opencode going away and coming back.
    if (req.method === "POST" && (path === "/e2e/offline" || path === "/e2e/online")) {
      offline = path === "/e2e/offline"
      if (offline) closeStreams()
      return empty(res, 204)
    }
    if (req.method === "POST" && path.startsWith("/e2e/stall")) {
      stallPrompts = path === "/e2e/stall-prompt"
      stallResponses = path === "/e2e/stall-response"
      if (path === "/e2e/stall-fork") stallForks = true
      if (path === "/e2e/stall-create") stallCreate = true
      if (path === "/e2e/stall-create-before") stallCreateBefore = true
      return empty(res, 204)
    }
    if (req.method === "POST" && path === "/e2e/release-prompt") {
      stallPrompts = false
      stallResponses = false
      stallForks = false
      for (const release of heldPrompts.splice(0)) release()
      return empty(res, 204)
    }
    if (req.method === "POST" && path === "/e2e/release-create") {
      stallCreate = false
      stallCreateBefore = false
      for (const release of heldCreates.splice(0)) release()
      return empty(res, 204)
    }
    if (req.method === "POST" && path === "/e2e/fail-prompts") {
      const body = await readBody(req)
      failPrompts = body.value !== false
      return empty(res, 204)
    }
    // Simulates another device (or the opencode TUI) sending a message to a
    // session: appends the user message and announces a turn, so the client
    // refetches the history. Used to prove delivery reconciliation never
    // matches a message that is not ours.
    if (req.method === "POST" && path === "/e2e/inject-user-message") {
      const body = await readBody(req)
      const sessionID = typeof body.sessionID === "string" ? body.sessionID : lastPromptSessionID
      if (!sessionID || !sessions.has(sessionID)) return json(res, 404, { error: "no_session" })
      const message = appendUserMessage(sessionID, typeof body.text === "string" ? body.text : "")
      const directory = directoryOf(sessionID)
      broadcast("session.execution.started", { sessionID }, directory)
      broadcast("session.idle", { sessionID }, directory)
      return json(res, 200, { data: message })
    }
    // Simulates another device (or the opencode TUI) deleting a session:
    // opencode announces it and the list no longer contains it, without going
    // through MasterHand's own delete route.
    if (req.method === "POST" && path === "/e2e/delete-session") {
      const body = await readBody(req)
      const sessionID = typeof body.sessionID === "string" ? body.sessionID : ""
      const session = sessions.get(sessionID)
      if (!session) return json(res, 404, { error: "no_session" })
      sessions.delete(sessionID)
      conversations.delete(sessionID)
      messageOrders.delete(sessionID)
      activeRuns.delete(sessionID)
      broadcast("session.deleted", { sessionID }, session.location.directory)
      return empty(res, 204)
    }
    if (req.method === "GET" && path === "/e2e/state") {
      return json(res, 200, {
        offline,
        stalled: heldPrompts.length,
        prompts: promptRequests,
        failPrompts,
        stalledForks: heldForks,
        forks: { created: forksCreated, removed: forksRemoved },
        ...catalogRequests,
      })
    }

    // E2E controls for missed-events scenarios.
    if (req.method === "GET" && path === "/e2e/pending") {
      return json(res, 200, { pending: [...pendingPermissions.keys()] })
    }
    // Resolves a pending request without broadcasting `permission.replied`,
    // simulating another device answering while this client is offline.
    if (req.method === "POST" && path === "/e2e/reply") {
      const body = await readBody(req)
      const requestID = typeof body.requestID === "string" ? body.requestID : ""
      const pending = pendingPermissions.get(requestID)
      if (pending) {
        pendingPermissions.delete(requestID)
        pending.resolve(typeof body.decision === "string" ? body.decision : "once")
      }
      return empty(res, 204)
    }

    if (offline && path.startsWith("/api/")) {
      return json(res, 503, { error: "offline" })
    }

    // Playwright's readiness probe for the mock itself.
    if (req.method === "GET" && path === "/global/health") return json(res, 200, { healthy: true, version: "2.0.6" })
    if (req.method === "GET" && path === "/api/info") {
      return json(res, 200, { version: "2.0.6", pid: 1, urls: [], paths: { tmp: "/tmp" } })
    }
    if (req.method === "GET" && path === "/api/event") return openStream(res)

    // Managed dev-server lifecycle (opencode PTY API).
    if (path === "/api/pty") {
      const directory = url.searchParams.get("location[directory]") ?? DEFAULT_DIRECTORY
      if (req.method === "GET") {
        return json(res, 200, {
          location: { directory },
          data: [...ptys.values()].filter((pty) => pty.status === "running"),
        })
      }
      if (req.method === "POST") {
        const body = await readBody(req)
        const pty = {
          id: nextId("pty"),
          pid: 5000 + ptys.size,
          status: "running",
          title: typeof body.title === "string" ? body.title : "",
          directory,
        }
        ptys.set(pty.id, pty)
        return json(res, 200, { location: { directory }, data: pty })
      }
    }
    if (req.method === "DELETE" && segments[0] === "api" && segments[1] === "pty" && segments[2]) {
      ptys.delete(decodeURIComponent(segments[2]))
      return empty(res, 204)
    }

    if (req.method === "GET" && path === "/api/session") {
      const directory = url.searchParams.get("directory")
      const list = [...sessions.values()].filter((session) => !directory || session.location.directory === directory)
      return json(res, 200, { data: list, cursor: { previous: null, next: null } })
    }
    if (req.method === "POST" && path === "/api/session") {
      const body = await readBody(req)
      if (stallCreateBefore) await new Promise<void>((resolve) => heldCreates.push(resolve))
      const location = (body.location ?? {}) as { directory?: unknown }
      const directory = typeof location.directory === "string" ? location.directory : DEFAULT_DIRECTORY
      const metadata =
        body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
          ? (body.metadata as Record<string, unknown>)
          : undefined
      const session = createSession({ directory, metadata })
      if (stallCreate) await new Promise<void>((resolve) => heldCreates.push(resolve))
      return json(res, 200, { data: session })
    }
    if (req.method === "GET" && path === "/api/session/active") {
      const active = Object.fromEntries([...activeRuns].map((sessionID) => [sessionID, { type: "running" }]))
      return json(res, 200, { data: active })
    }
    if (req.method === "GET" && path === "/api/permission/request") {
      const directory = url.searchParams.get("location[directory]")
      const list = [...pendingPermissions.values()]
        .filter((pending) => !directory || pending.directory === directory)
        .map((pending) => pending.request)
      return json(res, 200, { location: { directory: directory ?? "/e2e" }, data: list })
    }
    if (req.method === "GET" && path === "/api/form") {
      const directory = url.searchParams.get("location[directory]")
      const list = [...pendingForms.values()]
        .filter((pending) => !directory || pending.directory === directory)
        .map((pending) => pending.info)
      return json(res, 200, { location: { directory: directory ?? "/e2e" }, data: list })
    }
    if (req.method === "GET" && path === "/api/agent") {
      return json(res, 200, { location: { directory: "/e2e" }, data: AGENTS })
    }
    if (req.method === "GET" && path === "/api/model") {
      return json(res, 200, { location: { directory: "/e2e" }, data: MODELS })
    }
    if (req.method === "GET" && path === "/api/model/default") {
      return json(res, 200, { location: { directory: "/e2e" }, data: MODELS[0] })
    }
    if (req.method === "GET" && path === "/api/provider") {
      return json(res, 200, { location: { directory: "/e2e" }, data: PROVIDERS })
    }
    if (req.method === "GET" && path === "/api/command") {
      return json(res, 200, { location: { directory: "/e2e" }, data: COMMANDS })
    }
    if (req.method === "GET" && path === "/api/config") {
      return json(res, 200, [
        {
          type: "document",
          info: {
            commands: {
              component: { template: "Create a new React component named $ARGUMENTS with TypeScript support." },
              review: { template: "Review the changes: $ARGUMENTS" },
            },
          },
        },
      ])
    }

    // The BFF writes the preview-port instruction entry on session create/start.
    if (
      req.method === "PUT" &&
      segments[0] === "api" &&
      segments[1] === "experimental" &&
      segments[2] === "session" &&
      segments[4] === "instructions" &&
      segments[5] === "entries"
    ) {
      await readBody(req)
      return empty(res, 204)
    }

    if (segments[0] === "api" && segments[1] === "session" && segments[2]) {
      const sessionID = decodeURIComponent(segments[2])
      const session = sessions.get(sessionID)

      if (req.method === "GET" && segments[3] === "message") {
        // opencode keeps the first page's `order` across cursor pages (verified
        // against 2.0.21); remember it per session instead of defaulting to asc.
        const requestedOrder = url.searchParams.get("order")
        if (requestedOrder) messageOrders.set(sessionID, requestedOrder)
        const order = requestedOrder ?? messageOrders.get(sessionID) ?? "asc"
        const all = [...(conversations.get(sessionID) ?? [])].sort((a, b) => a.time.created - b.time.created)
        const ordered = order === "desc" ? [...all].reverse() : all
        const limit = Number(url.searchParams.get("limit") ?? "200")
        const offset = Number(url.searchParams.get("cursor") ?? "0")
        const page = ordered.slice(offset, offset + limit)
        const next = offset + limit < ordered.length ? String(offset + limit) : null
        return json(res, 200, { data: page, cursor: { previous: null, next } })
      }
      if (req.method === "POST" && segments[3] === "fork") {
        if (!session) return json(res, 404, { error: "not_found" })
        if (stallForks) {
          heldForks += 1
          await new Promise<void>((resolve) => heldPrompts.push(resolve))
          heldForks -= 1
        }
        const forked = createSession({ directory: session.location.directory })
        forked.fork = { sessionID, boundary: { type: "through", messageID: "msg_fork" } }
        forksCreated += 1
        return json(res, 200, { data: forked })
      }
      if (req.method === "POST" && segments[3] === "prompt") {
        if (!session) return json(res, 404, { error: "not_found" })
        promptRequests += 1
        lastPromptSessionID = sessionID
        if (failPrompts) return json(res, 500, { error: "prompt_failed" })
        const body = await readBody(req)
        // E2E control: hold this response until the release route runs, so the
        // client's fetch stays pending exactly like a stalled network request.
        if (stallPrompts) await new Promise<void>((resolve) => heldPrompts.push(resolve))
        const text = typeof body.text === "string" ? body.text : ""
        const metadata =
          body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
            ? (body.metadata as Record<string, unknown>)
            : undefined
        const message = appendUserMessage(sessionID, text, metadata)
        // E2E helper: `/seed N` fills the conversation with N more messages and
        // reports the session idle, so clients refetch the whole history.
        const seed = /^\/seed (\d+)$/.exec(text.trim())
        if (seed) {
          const count = Math.max(0, Math.min(Number(seed[1]), 1000))
          for (let index = 1; index <= count; index += 1) {
            appendUserMessage(sessionID, `Seed message ${index}`)
          }
          broadcast("session.idle", { sessionID }, session.location.directory)
        } else if (session.fork) {
          // `/btw` side questions answer immediately without a permission dance.
          const assistant = appendAssistantMessage(sessionID)
          assistant.content = [{ type: "text", text: `Side answer to: ${text}` }]
          broadcast("session.idle", { sessionID }, session.location.directory)
        } else {
          void runPrompt(sessionID, text)
        }
        // E2E control: hold after processing too — the agent's turn runs and
        // finishes, only the HTTP response is lost.
        if (stallResponses) await new Promise<void>((resolve) => heldPrompts.push(resolve))
        json(res, 200, {
          data: {
            id: message.id,
            sessionID,
            time: { created: message.time.created },
            type: "user",
            payload: { text },
            delivery: "steer",
          },
        })
        return
      }
      if (req.method === "POST" && segments[3] === "command") {
        if (!session) return json(res, 404, { error: "not_found" })
        const body = await readBody(req)
        const name = typeof body.name === "string" ? body.name : ""
        const command = COMMANDS.find((item) => item.name === name)
        if (!command) {
          return json(res, 404, {
            _tag: "CommandNotFoundError",
            command: name,
            message: `Command not found: ${name}`,
          })
        }
        const args = typeof body.text === "string" ? body.text : ""
        const template = COMMAND_TEMPLATES[name] ?? command.description
        appendUserMessage(sessionID, template.replace("$ARGUMENTS", args))
        broadcast("session.idle", { sessionID }, session.location.directory)
        return empty(res, 204)
      }
      if (req.method === "POST" && segments[3] === "agent") {
        const body = await readBody(req)
        if (session && typeof body.agent === "string") {
          session.agent = body.agent
          session.time.updated = now()
        }
        return empty(res, 204)
      }
      if (req.method === "POST" && segments[3] === "model") {
        const body = await readBody(req)
        const model = body.model as ModelRef | undefined
        if (session && model && typeof model.id === "string" && typeof model.providerID === "string") {
          session.model = model
          session.time.updated = now()
        }
        return empty(res, 204)
      }
      if (req.method === "POST" && segments[3] === "interrupt") {
        return json(res, 200, { interrupted: true })
      }
      if (req.method === "POST" && segments[3] === "permission" && segments[4] && segments[5] === "reply") {
        const body = await readBody(req)
        const pending = pendingPermissions.get(segments[4])
        if (pending) {
          pendingPermissions.delete(segments[4])
          const decision = typeof body.decision === "string" ? body.decision : "reject"
          broadcast(
            "permission.replied",
            { sessionID: pending.sessionID, requestID: segments[4], reply: decision },
            pending.directory,
          )
          pending.resolve(decision)
        }
        return empty(res, 204)
      }
      {
        const formID = segments[3] === "form" && segments[4] ? decodeURIComponent(segments[4]) : null
        if (req.method === "GET" && segments[3] === "form" && formID === null) {
          const list = [...pendingForms.values()]
            .filter((pending) => pending.sessionID === sessionID)
            .map((pending) => pending.info)
          return json(res, 200, { data: list })
        }
        if (req.method === "GET" && formID !== null) {
          const pending = pendingForms.get(formID)
          if (!pending) return json(res, 404, { error: "not_found" })
          return json(res, 200, { data: { ...pending.info, state: { status: "pending" } } })
        }
        if (req.method === "POST" && formID !== null && segments[5] === "reply") {
          const body = await readBody(req)
          const pending = pendingForms.get(formID)
          if (pending) {
            pendingForms.delete(formID)
            pending.resolve((body.answer ?? {}) as Record<string, unknown>)
          }
          return empty(res, 204)
        }
        if (req.method === "DELETE" && formID !== null) {
          const pending = pendingForms.get(formID)
          if (pending) {
            pendingForms.delete(formID)
            pending.resolve(null)
          }
          return empty(res, 204)
        }
      }
      if (req.method === "PATCH") {
        // MasterHand sets the session's external-write guard right after creation.
        await readBody(req)
        return empty(res, 204)
      }
      if (req.method === "DELETE" && segments.length === 3) {
        if (session?.fork) forksRemoved += 1
        sessions.delete(sessionID)
        conversations.delete(sessionID)
        messageOrders.delete(sessionID)
        activeRuns.delete(sessionID)
        for (const [id, pending] of pendingPermissions) {
          if (pending.sessionID === sessionID) pendingPermissions.delete(id)
        }
        for (const [id, pending] of pendingForms) {
          if (pending.sessionID === sessionID) pendingForms.delete(id)
        }
        broadcast("session.deleted", { sessionID }, session?.location.directory)
        return empty(res, 204)
      }
    }

    json(res, 404, { error: "not_found" })
  })()
})

server.listen(port, "127.0.0.1", () => {
  console.log(`[mock-opencode] listening on http://127.0.0.1:${port}`)
})

function shutdown(): void {
  server.close(() => process.exit(0))
  // Never hang the teardown if a connection stays open.
  setTimeout(() => process.exit(0), 1000).unref()
}

process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
