import { describe, expect, it } from "vitest"
import { makeToolPart } from "../src/chat"
import {
  countDiffLines,
  describeTool,
  diffLines,
  firstLine,
  formatDuration,
  isQuestionTool,
  lineCountLabel,
  looksLikeDiff,
  looksLineNumbered,
  parsePatch,
  parseReadOutput,
  pathParts,
  sameLabel,
  stripAnsi,
  truncateLines,
} from "../src/tools"
import type { ChatToolPart, ChatToolState } from "../src/types"

function toolPart(tool: string, state: Partial<ChatToolState> = {}): ChatToolPart {
  return makeToolPart("ses_1", "msg_1", "call_1", tool, {
    status: "completed",
    input: {},
    output: undefined,
    ...state,
  })
}

describe("describeTool", () => {
  it("normalizes a shell command with its exit code", () => {
    const part = toolPart("bash", {
      input: { command: "npm test", description: "Run tests" },
      output: "ok",
      metadata: { exitCode: 0 },
    })
    expect(describeTool(part)).toMatchObject({
      kind: "shell",
      icon: "terminal",
      accent: "emerald",
      title: "npm test",
      subtitle: "Run tests",
      exitCode: 0,
      output: "ok",
    })
  })

  it("falls back to the cwd when the shell has no description", () => {
    const part = toolPart("shell", { input: { command: "ls", cwd: "/w/app" } })
    expect(describeTool(part)).toMatchObject({ kind: "shell", subtitle: "/w/app" })
  })

  it("reads an alias command field and metadata exit", () => {
    const part = toolPart("bash", { input: { cmd: "pwd" }, metadata: { exit: 2 } })
    expect(describeTool(part)).toMatchObject({ kind: "shell", command: "pwd", exitCode: 2 })
  })

  it("describes a read with its path and line count", () => {
    const part = toolPart("read", { input: { filePath: "/w/app/src/a.ts" }, output: "00001| a\n00002| b" })
    const summary = describeTool(part)
    expect(summary).toMatchObject({ kind: "read", path: "/w/app/src/a.ts", subtitle: "2 lines", accent: "sky" })
  })

  it("describes a write with its content size", () => {
    const part = toolPart("write", { input: { filePath: "a.ts", content: "one\ntwo" } })
    expect(describeTool(part)).toMatchObject({ kind: "write", lines: 2, subtitle: "2 lines", accent: "violet" })
  })

  it("computes a diff for an edit from old and new strings", () => {
    const part = toolPart("edit", {
      input: { filePath: "a.ts", oldString: "const a = 1", newString: "const a = 2\nconst b = 3" },
    })
    const summary = describeTool(part)
    expect(summary.kind).toBe("edit")
    if (summary.kind !== "edit") return
    expect(summary.additions).toBe(2)
    expect(summary.deletions).toBe(1)
    expect(summary.subtitle).toBe("+2 −1")
    expect(summary.diff.map((line) => line.kind)).toEqual(["remove", "add", "add"])
  })

  it("parses a patch input for edit", () => {
    const part = toolPart("patch", {
      input: { patch: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new" },
    })
    const summary = describeTool(part)
    expect(summary.kind).toBe("edit")
    if (summary.kind !== "edit") return
    expect(summary.diff.map((line) => line.kind)).toEqual(["context", "remove", "add"])
  })

  it("describes a search with its pattern and matches", () => {
    const part = toolPart("grep", { input: { pattern: "TODO", path: "src" }, output: "a.ts:1\nb.ts:2" })
    expect(describeTool(part)).toMatchObject({
      kind: "search",
      title: "TODO",
      subtitle: "src",
      matches: ["a.ts:1", "b.ts:2"],
    })
  })

  it("uses the path for a glob without pattern", () => {
    const part = toolPart("glob", { input: { path: "**/*.ts" } })
    const summary = describeTool(part)
    expect(summary.kind).toBe("search")
    if (summary.kind !== "search") return
    expect(summary.title).toBe("**/*.ts")
  })

  it("describes web tools by url or query", () => {
    expect(describeTool(toolPart("webfetch", { input: { url: "https://x.dev" } }))).toMatchObject({
      kind: "web",
      title: "https://x.dev",
      url: "https://x.dev",
    })
    expect(describeTool(toolPart("websearch", { input: { query: "vitest" } }))).toMatchObject({
      kind: "web",
      title: "vitest",
      query: "vitest",
    })
  })

  it("leaves web tools without a repeated subtitle", () => {
    expect(describeTool(toolPart("websearch", { input: { query: "vitest" } }))).toMatchObject({
      kind: "web",
      subtitle: undefined,
    })
  })

  it("drops a shell description that repeats the command", () => {
    const part = toolPart("execute", { input: { command: "npm test", description: "npm test" } })
    expect(describeTool(part)).toMatchObject({ kind: "shell", title: "npm test", subtitle: undefined })
  })

  it("drops a search path that repeats the pattern", () => {
    const part = toolPart("grep", { input: { pattern: "TODO", path: "TODO" }, output: "TODO" })
    expect(describeTool(part)).toMatchObject({ kind: "search", title: "TODO", subtitle: undefined })
  })

  it("matches labels ignoring case, spacing and plurals", () => {
    expect(sameLabel("websearch", "Web search")).toBe(true)
    expect(sameLabel("question", "2 questions")).toBe(true)
    expect(sameLabel("execute", "Execute")).toBe(true)
    expect(sameLabel("npm test", "Run tests")).toBe(false)
    expect(sameLabel(undefined, "x")).toBe(false)
  })

  it("counts completed todos", () => {
    const part = toolPart("todowrite", {
      input: {
        todos: [
          { content: "a", status: "completed" },
          { content: "b", status: "pending" },
        ],
      },
    })
    expect(describeTool(part)).toMatchObject({ kind: "todo", title: "Todo list", subtitle: "1/2 done" })
  })

  it("maps the question tool input into question items", () => {
    const part = toolPart("question", {
      input: {
        questions: [
          { header: "DB", question: "Which database?", options: [{ label: "PG", description: "Postgres" }], multiple: true },
        ],
      },
    })
    expect(describeTool(part)).toMatchObject({
      kind: "question",
      title: "DB",
      subtitle: undefined,
      questions: [
        {
          header: "DB",
          question: "Which database?",
          options: [{ label: "PG", description: "Postgres" }],
          multiple: true,
        },
      ],
    })
  })

  it("keeps question headers free of a repeated subtitle", () => {
    const part = toolPart("question", { input: { questions: [{ question: "a" }, { question: "b" }] } })
    const summary = describeTool(part)
    expect(summary).toMatchObject({ kind: "question", subtitle: undefined })
  })

  it("detects the question tool (including the ask alias) only for tool parts", () => {
    expect(isQuestionTool(toolPart("question"))).toBe(true)
    expect(isQuestionTool(toolPart("ask"))).toBe(true)
    expect(isQuestionTool(toolPart("read"))).toBe(false)
    expect(isQuestionTool({ id: "t", sessionID: "s", messageID: "m", type: "text", text: "hi" })).toBe(false)
  })

  it("falls back to a key/value list for unknown tools", () => {
    const part = toolPart("mcp__server__thing", { input: { key: "value", count: 3, nested: { a: 1 } } })
    expect(describeTool(part)).toMatchObject({
      kind: "generic",
      icon: "tool",
      accent: "zinc",
      entries: [
        { key: "key", value: "value" },
        { key: "count", value: "3" },
        { key: "nested", value: '{"a":1}' },
      ],
    })
  })

  it("shows a pending placeholder while the input streams", () => {
    const part = toolPart("bash", { status: "pending", raw: '{"comm' })
    expect(describeTool(part)).toMatchObject({ kind: "generic", title: "Preparing…", status: "pending" })
  })

  it("keeps known tools with missing payloads generic instead of throwing", () => {
    expect(describeTool(toolPart("read", { input: {} })).kind).toBe("generic")
    expect(describeTool(toolPart("write", { input: {} })).kind).toBe("generic")
    expect(describeTool(toolPart("webfetch", { input: {} })).kind).toBe("generic")
    expect(describeTool(toolPart("grep", { input: {} })).kind).toBe("generic")
    expect(describeTool(toolPart("bash", { input: {} })).kind).toBe("generic")
  })

  it("computes the wall-clock duration when both ends exist", () => {    const part = toolPart("bash", {
      input: { command: "x" },
      timing: { created: 1_000, completed: 3_500 },
    })
    expect(describeTool(part).durationMs).toBe(2_500)
  })

  it("ignores a negative or incomplete duration", () => {
    expect(describeTool(toolPart("bash", { input: { command: "x" }, timing: { created: 10 } })).durationMs).toBeNull()
    expect(
      describeTool(toolPart("bash", { input: { command: "x" }, timing: { created: 10, completed: 5 } })).durationMs,
    ).toBeNull()
  })
})

describe("diffLines", () => {
  it("returns one change block with the shared context", () => {
    const diff = diffLines("a\nb\nc", "a\nB\nc")
    expect(diff).toEqual([
      { kind: "context", text: "a" },
      { kind: "remove", text: "b" },
      { kind: "add", text: "B" },
      { kind: "context", text: "c" },
    ])
  })

  it("handles pure additions", () => {
    const diff = diffLines("a", "a\nb")
    expect(diff).toEqual([
      { kind: "context", text: "a" },
      { kind: "add", text: "b" },
    ])
  })

  it("falls back to remove-all/add-all for very large inputs", () => {
    const before = Array.from({ length: 500 }, (_, i) => `before ${i}`).join("\n")
    const after = Array.from({ length: 500 }, (_, i) => `after ${i}`).join("\n")
    const diff = diffLines(before, after)
    expect(diff.filter((line) => line.kind === "remove")).toHaveLength(500)
    expect(diff.filter((line) => line.kind === "add")).toHaveLength(500)
  })
})

describe("parsePatch", () => {
  it("skips file headers and keeps hunk markers", () => {
    const rows = parsePatch("diff --git a/x b/x\nindex 1..2\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n\\ No newline")
    expect(rows).toEqual([
      { kind: "context", text: "@@ -1 +1 @@" },
      { kind: "remove", text: "a" },
      { kind: "add", text: "b" },
    ])
  })
})

describe("parseReadOutput", () => {
  it("strips the v2 header and the per-line prefixes", () => {
    const parsed = parseReadOutput("Read file /w/a.ts, lines 1-3\n1: const a = 1\n2: const b = 2\n3: const c = 3")
    expect(parsed).toEqual({
      path: "/w/a.ts",
      startLine: 1,
      endLine: 3,
      content: "const a = 1\nconst b = 2\nconst c = 3",
      truncatedNext: null,
    })
  })

  it("keeps the real first line number for offset pages", () => {
    const parsed = parseReadOutput("Read file /w/a.ts, lines 21-22\n21: x\n22: y")
    expect(parsed.startLine).toBe(21)
    expect(parsed.content).toBe("x\ny")
  })

  it("handles an empty file", () => {
    const parsed = parseReadOutput("Read file /w/empty.ts, 0 lines")
    expect(parsed).toMatchObject({ path: "/w/empty.ts", startLine: null, content: "" })
  })

  it("handles directory listings without numbering", () => {
    const parsed = parseReadOutput("Read directory /w/src, 2 entries\na.ts\nb.ts")
    expect(parsed).toMatchObject({ path: "/w/src", startLine: null, content: "a.ts\nb.ts" })
  })

  it("separates the truncation footer", () => {
    const parsed = parseReadOutput(
      "Read file /w/big.ts, lines 1-2\n1: a\n2: b\n[Output truncated. Continue reading with offset: 2000]",
    )
    expect(parsed.content).toBe("a\nb")
    expect(parsed.truncatedNext).toBe(2000)
  })

  it("unwraps the legacy v1 XML output", () => {
    const parsed = parseReadOutput("<path>/w/a.json</path>\n<type>file</type>\n<content>\n1: {}\n2: []\n</content>")
    expect(parsed).toMatchObject({ path: "/w/a.json", startLine: 1, content: "{}\n[]" })
  })

  it("passes through output without a header", () => {
    const parsed = parseReadOutput("00001| a\n00002| b")
    expect(parsed).toMatchObject({ path: null, startLine: null, content: "00001| a\n00002| b" })
  })

  it("feeds the read summary with the parsed path, range and clean content", () => {
    const part = toolPart("read", {
      input: { filePath: "src/a.ts" },
      output: "Read file src/a.ts, lines 1-2\n1: const a = 1\n2: const b = 2",
    })
    const summary = describeTool(part)
    expect(summary).toMatchObject({
      kind: "read",
      title: "src/a.ts",
      subtitle: "lines 1-2",
      startLine: 1,
      content: "const a = 1\nconst b = 2",
    })
  })

  it("falls back to the header path when the input has none", () => {
    const part = toolPart("read", { input: {}, output: "Read file /w/only.ts, lines 5-5\n5: hello" })
    const summary = describeTool(part)
    expect(summary).toMatchObject({ kind: "read", title: "/w/only.ts", startLine: 5, content: "hello" })
  })
})

describe("text helpers", () => {
  it("strips ansi colors and osc sequences", () => {
    expect(stripAnsi("\u001b[31mred\u001b[0m plain")).toBe("red plain")
    expect(stripAnsi("\u001b]0;title\u0007text")).toBe("text")
  })

  it("detects numbered and diff text", () => {
    expect(looksLineNumbered("00001| a")).toBe(true)
    expect(looksLineNumbered("plain")).toBe(false)
    expect(looksLikeDiff("@@ -1 +1 @@")).toBe(true)
    expect(looksLikeDiff("diff --git a/x b/x")).toBe(true)
    expect(looksLikeDiff("changed a file")).toBe(false)
  })

  it("truncates long text and reports the hidden lines", () => {
    expect(truncateLines("a\nb\nc", 2)).toEqual({ text: "a\nb", totalLines: 3, hiddenLines: 1 })
    expect(truncateLines("a", 2)).toEqual({ text: "a", totalLines: 1, hiddenLines: 0 })
  })

  it("formats durations", () => {
    expect(formatDuration(840)).toBe("840ms")
    expect(formatDuration(2_340)).toBe("2.3s")
    expect(formatDuration(64_000)).toBe("1m 04s")
  })

  it("pluralizes the line count", () => {
    expect(lineCountLabel(1)).toBe("1 line")
    expect(lineCountLabel(2)).toBe("2 lines")
  })

  it("takes the first non-empty line and splits paths", () => {
    expect(firstLine("\n  hello world  \nrest")).toBe("hello world")
    expect(firstLine("x".repeat(120)).endsWith("…")).toBe(true)
    expect(pathParts("/w/app/a.ts")).toEqual({ dir: "/w/app/", base: "a.ts" })
    expect(pathParts("a.ts")).toEqual({ dir: "", base: "a.ts" })
  })

  it("counts diff additions and deletions", () => {
    expect(
      countDiffLines([
        { kind: "add", text: "a" },
        { kind: "remove", text: "b" },
        { kind: "context", text: "c" },
      ]),
    ).toEqual({ additions: 1, deletions: 1 })
  })
})
