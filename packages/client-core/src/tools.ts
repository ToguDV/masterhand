import type { ChatPart, ChatToolPart, ChatToolState, ChatToolStatus, ChatToolTiming } from "./types"

/**
 * Tool semantics shared by every client. `describeTool` turns a raw
 * `ChatToolPart` into a small view model the UI can render: a header summary
 * plus, per tool family, the payload worth showing (command, diff, file,
 * matches…). None of it touches the DOM or React Native, so web and mobile
 * stay in sync without sharing components.
 */

export type ToolKind =
  | "shell"
  | "read"
  | "write"
  | "edit"
  | "search"
  | "web"
  | "todo"
  | "question"
  | "generic"

/** Semantic accent the clients map to their own palette. */
export type ToolAccent = "emerald" | "amber" | "sky" | "violet" | "cyan" | "teal" | "indigo" | "zinc"

/** Semantic glyph name the clients map to their own icon set. */
export type ToolIcon =
  | "terminal"
  | "file"
  | "pencil"
  | "diff"
  | "search"
  | "globe"
  | "checklist"
  | "question"
  | "tool"

export interface DiffLine {
  kind: "add" | "remove" | "context"
  text: string
}

export interface TodoItem {
  content: string
  status: string
}

export interface QuestionOption {
  label: string
  description?: string
}

export interface QuestionItem {
  header?: string
  question: string
  options: QuestionOption[]
  multiple: boolean
}

export interface KeyValueEntry {
  key: string
  value: string
}

interface ToolSummaryBase {
  tool: string
  status: ChatToolStatus
  title: string
  subtitle?: string
  icon: ToolIcon
  accent: ToolAccent
  error?: string
  timing?: ChatToolTiming
  /** Wall-clock duration, when both ends are known. */
  durationMs: number | null
}

export type ToolSummary =
  | (ToolSummaryBase & {
      kind: "shell"
      command: string
      cwd?: string
      exitCode: number | null
      output?: string
    })
  | (ToolSummaryBase & {
      kind: "read"
      path: string
      offset?: number
      limit?: number
      content?: string
      /** 1-based first line of the page, for correct line numbering. */
      startLine?: number
      /** Offset to continue from when opencode truncated the page. */
      truncatedNext?: number
    })
  | (ToolSummaryBase & { kind: "write"; path: string; content: string; lines: number })
  | (ToolSummaryBase & {
      kind: "edit"
      path: string
      diff: DiffLine[]
      additions: number
      deletions: number
      output?: string
    })
  | (ToolSummaryBase & { kind: "search"; pattern: string; path?: string; matches: string[] })
  | (ToolSummaryBase & { kind: "web"; url?: string; query?: string; output?: string })
  | (ToolSummaryBase & { kind: "todo"; todos: TodoItem[] })
  | (ToolSummaryBase & { kind: "question"; questions: QuestionItem[] })
  | (ToolSummaryBase & { kind: "generic"; entries: KeyValueEntry[]; output?: string })

// --- primitives -------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function readString(source: unknown, ...keys: string[]): string | null {
  const record = asRecord(source)
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value.length > 0) return value
  }
  return null
}

function readNumber(source: unknown, ...keys: string[]): number | null {
  const record = asRecord(source)
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return null
}

function readBoolean(source: unknown, ...keys: string[]): boolean | null {
  const record = asRecord(source)
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "boolean") return value
  }
  return null
}

function readArray(source: unknown, ...keys: string[]): unknown[] {
  const record = asRecord(source)
  for (const key of keys) {
    const value = record[key]
    if (Array.isArray(value)) return value
  }
  return []
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (value === null) return "null"
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** `1 line` / `N lines`, for tool summaries. */
export function lineCountLabel(count: number): string {
  return `${count} ${count === 1 ? "line" : "lines"}`
}

/**
 * True when two header labels say the same thing (`websearch` vs `Web search`,
 * `question` vs `2 questions`, a command vs its repeated description). Used to
 * keep tool headers from rendering the same text twice (title vs tool name, or
 * subtitle vs either of them).
 */
export function sameLabel(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  const normalize = (value: string): string => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "")
  const left = normalize(a)
  const right = normalize(b)
  if (!left || !right) return false
  if (left === right) return true
  if (left.length >= 4 && right.includes(left)) return true
  if (right.length >= 4 && left.includes(right)) return true
  return false
}

/** First non-empty line, trimmed and cut to `max` characters. */
export function firstLine(text: string, max = 100): string {
  const line = text
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0)
  if (!line) return ""
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** Splits a path into its parent directory (with trailing separator) and base name. */
export function pathParts(path: string): { dir: string; base: string } {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
  if (index === -1) return { dir: "", base: path }
  return { dir: path.slice(0, index + 1), base: path.slice(index + 1) }
}

const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g

/** Removes ANSI escape sequences (colors, cursor moves) from terminal output. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "")
}

/** True when the text already carries line numbers (`00001| foo`). */
export function looksLineNumbered(text: string): boolean {
  return /^\s*\d+\|/m.test(text)
}

/** One-page read output: header, `<line>: <content>` body and truncation footer. */
export interface ParsedReadOutput {
  /** Path reported by the header (fallback when the tool input has none). */
  path: string | null
  /** 1-based first line of the page (null for directories/empty reads). */
  startLine: number | null
  endLine: number | null
  /** Body without the header, the per-line prefixes or the truncation footer. */
  content: string
  /** Offset opencode suggests to continue when the page was truncated. */
  truncatedNext: number | null
}

// opencode v2: `Read file <path>, lines <start>-<end>` (or `, 0 lines`), a
// `<line>: <content>` body and an optional truncation footer. Directories use
// `Read directory <path>, N entries` with plain entry lines.
const READ_HEADER = /^Read (?:file|directory) (.+?)(?:, lines (\d+)-(\d+)|, (\d+) (?:lines|entries))\s*\n?/
const READ_TRUNCATED = /\[Output truncated\. Continue reading with offset: (\d+)\]\s*$/
// Legacy v1 wrapper still present in old session histories.
const READ_LEGACY = /^<path>([\s\S]*?)<\/path>\s*<type>[\s\S]*?<\/type>\s*<content>\s*\n?/

/** Removes the `N: ` prefixes opencode adds, when they are sequential from `start`. */
function stripLinePrefixes(text: string, start: number): string {
  const lines = text.split("\n")
  const first = lines[0]?.match(/^(\d+): ?/)
  if (!first || Number(first[1]) !== start) return text
  let expected = start
  return lines
    .map((line) => {
      const match = /^(\d+): ?(.*)$/.exec(line)
      if (match && Number(match[1]) === expected) {
        expected++
        return match[2] ?? ""
      }
      return line
    })
    .join("\n")
}

/** Parses the read tool output into a clean path, line range and content body. */
export function parseReadOutput(output: string): ParsedReadOutput {
  const header = READ_HEADER.exec(output)
  if (header) {
    const start = header[2] ? Number(header[2]) : null
    const end = header[3] ? Number(header[3]) : null
    let body = output.slice(header[0].length)
    const truncated = READ_TRUNCATED.exec(body)
    const truncatedNext = truncated ? Number(truncated[1]) : null
    if (truncated?.index !== undefined) body = body.slice(0, truncated.index)
    return {
      path: header[1] ?? null,
      startLine: start,
      endLine: end,
      content: (start !== null ? stripLinePrefixes(body, start) : body).replace(/\n+$/, ""),
      truncatedNext,
    }
  }

  const legacy = READ_LEGACY.exec(output)
  if (legacy) {
    const body = output.slice(legacy[0].length).replace(/\s*<\/content>\s*$/, "")
    const first = body.match(/^(\d+): /)
    const start = first ? Number(first[1]) : null
    return {
      path: legacy[1] ?? null,
      startLine: start,
      endLine: null,
      content: (start !== null ? stripLinePrefixes(body, start) : body).replace(/\n+$/, ""),
      truncatedNext: null,
    }
  }

  return { path: null, startLine: null, endLine: null, content: output, truncatedNext: null }
}

/** True when the text looks like a unified diff (`@@` hunks or a `+++` header). */
export function looksLikeDiff(text: string): boolean {
  return /^@@ /m.test(text) || /\ndiff --git /.test(`\n${text}`)
}

export interface TruncatedText {
  text: string
  totalLines: number
  hiddenLines: number
}

/** Keeps the first `maxLines` lines of `text` and reports what was hidden. */
export function truncateLines(text: string, maxLines: number): TruncatedText {
  const lines = text.split("\n")
  if (lines.length <= maxLines) return { text, totalLines: lines.length, hiddenLines: 0 }
  return {
    text: lines.slice(0, maxLines).join("\n"),
    totalLines: lines.length,
    hiddenLines: lines.length - maxLines,
  }
}

/** Human duration: `840ms`, `2.3s`, `1m 04s`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${Math.round(seconds * 10) / 10}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds - minutes * 60)
  return `${minutes}m ${String(rest).padStart(2, "0")}s`
}

// --- diff -------------------------------------------------------------------

const MAX_DIFF_LINES = 400

function diffLine(kind: DiffLine["kind"], text: string): DiffLine {
  return { kind, text }
}

/**
 * Line diff between two texts: trims the common prefix/suffix, then runs an LCS
 * over what is left. Falls back to "all removed + all added" for very large
 * inputs (the DP table is capped by `MAX_DIFF_LINES`).
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n")
  const b = after.split("\n")

  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }

  const head = a.slice(0, start).map((text) => diffLine("context", text))
  const tail = a.slice(endA).map((text) => diffLine("context", text))
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)

  if (midA.length > MAX_DIFF_LINES || midB.length > MAX_DIFF_LINES) {
    return [...head, ...midA.map((text) => diffLine("remove", text)), ...midB.map((text) => diffLine("add", text)), ...tail]
  }

  const n = midA.length
  const m = midB.length
  const table: Uint32Array[] = []
  for (let i = 0; i <= n; i++) table.push(new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    const row = table[i]!
    const next = table[i + 1]!
    for (let j = m - 1; j >= 0; j--) {
      row[j] = midA[i] === midB[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!)
    }
  }

  const middle: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (midA[i] === midB[j]) {
      middle.push(diffLine("context", midA[i]!))
      i++
      j++
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      middle.push(diffLine("remove", midA[i]!))
      i++
    } else {
      middle.push(diffLine("add", midB[j]!))
      j++
    }
  }
  while (i < n) middle.push(diffLine("remove", midA[i++]!))
  while (j < m) middle.push(diffLine("add", midB[j++]!))

  const diff = [...head, ...middle, ...tail]
  if (diff.length <= MAX_DIFF_LINES * 2) return diff
  const kept = diff.slice(0, MAX_DIFF_LINES * 2)
  kept.push(diffLine("context", `… ${diff.length - kept.length} more lines`))
  return kept
}

/** Parses a unified patch (`+`/`-`/` ` lines) into diff rows. */
export function parsePatch(patch: string): DiffLine[] {
  const rows: DiffLine[] = []
  for (const line of patch.split("\n")) {
    if (
      line.startsWith("+++ ") ||
      line.startsWith("--- ") ||
      line.startsWith("diff ") ||
      line.startsWith("index ") ||
      line.startsWith("new file") ||
      line.startsWith("deleted file") ||
      line.startsWith("similarity index") ||
      line.startsWith("rename ")
    ) {
      continue
    }
    if (line.startsWith("\\")) continue
    if (line.startsWith("@@")) {
      rows.push(diffLine("context", line))
      continue
    }
    if (line.startsWith("+")) rows.push(diffLine("add", line.slice(1)))
    else if (line.startsWith("-")) rows.push(diffLine("remove", line.slice(1)))
    else rows.push(diffLine("context", line.startsWith(" ") ? line.slice(1) : line))
  }
  return rows
}

export function countDiffLines(diff: readonly DiffLine[]): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of diff) {
    if (line.kind === "add") additions++
    else if (line.kind === "remove") deletions++
  }
  return { additions, deletions }
}

// --- tool description -------------------------------------------------------

function durationOf(timing?: ChatToolTiming): number | null {
  if (timing?.created === undefined || timing.completed === undefined) return null
  const ms = timing.completed - timing.created
  return ms >= 0 ? ms : null
}

function baseOf(part: ChatToolPart): Omit<ToolSummaryBase, "title" | "subtitle" | "icon" | "accent"> {
  const state = part.state
  return {
    tool: part.tool,
    status: state.status,
    error: state.error,
    timing: state.timing,
    durationMs: durationOf(state.timing),
  }
}

function normalizeTool(tool: string): ToolKind {
  const name = tool.toLowerCase()
  if (["bash", "shell", "sh", "execute", "run"].includes(name)) return "shell"
  if (["read", "view", "cat"].includes(name)) return "read"
  if (["write", "create"].includes(name)) return "write"
  if (["edit", "patch", "apply_patch", "multiedit"].includes(name)) return "edit"
  if (["grep", "glob", "list", "ls", "find", "search"].includes(name)) return "search"
  if (["webfetch", "websearch", "fetch", "web_fetch", "web_search"].includes(name)) return "web"
  if (["todowrite", "todoread", "todo", "todos"].includes(name)) return "todo"
  if (["question", "ask"].includes(name)) return "question"
  return "generic"
}

/** True when the tool part is the agent's `question` tool (backed by a form). */
export function isQuestionTool(part: ChatPart): part is ChatToolPart {
  return part.type === "tool" && normalizeTool(part.tool) === "question"
}

function genericSummary(part: ChatToolPart, state: ChatToolState, status: ChatToolStatus): ToolSummary {
  const entries = Object.entries(state.input)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ({ key, value: formatValue(value) }))
  return {
    ...baseOf(part),
    kind: "generic",
    status,
    icon: "tool",
    accent: "zinc",
    title: status === "pending" ? "Preparing…" : state.title ?? part.tool,
    entries,
    output: state.output,
  }
}

function questionItems(input: Record<string, unknown>): QuestionItem[] {
  return readArray(input, "questions").map((raw) => ({
    header: readString(raw, "header") ?? undefined,
    question: readString(raw, "question") ?? "",
    options: readArray(raw, "options").map((option) => ({
      label: readString(option, "label") ?? "",
      description: readString(option, "description") ?? undefined,
    })),
    multiple: readBoolean(raw, "multiple") ?? false,
  }))
}

/**
 * Normalizes a tool part into its renderable summary. Never throws: unknown
 * tools, missing fields and MCP tools all fall back to a readable key/value
 * list instead of raw JSON.
 */
export function describeTool(part: ChatToolPart): ToolSummary {
  const state = part.state
  const input = state.input
  const status = state.status
  if (status === "pending") return genericSummary(part, state, status)

  switch (normalizeTool(part.tool)) {
    case "shell": {
      const command = readString(input, "command", "cmd", "script")
      if (!command) return genericSummary(part, state, status)
      const cwd = readString(input, "cwd", "workdir", "directory") ?? undefined
      const description = readString(input, "description") ?? state.title ?? undefined
      const title = firstLine(command)
      const rawSubtitle = description ?? cwd
      const subtitle =
        rawSubtitle && !sameLabel(rawSubtitle, title) && !sameLabel(rawSubtitle, part.tool)
          ? rawSubtitle
          : undefined
      return {
        ...baseOf(part),
        kind: "shell",
        icon: "terminal",
        accent: "emerald",
        title,
        subtitle,
        command,
        cwd,
        exitCode: readNumber(state.metadata, "exitCode", "exit_code", "exit", "code"),
        output: state.output,
      }
    }

    case "read": {
      const parsed = parseReadOutput(state.output ?? "")
      const path = readString(input, "filePath", "path", "file") ?? parsed.path
      if (!path) return genericSummary(part, state, status)
      const offset = readNumber(input, "offset") ?? undefined
      const limit = readNumber(input, "limit") ?? undefined
      const content = state.output !== undefined ? parsed.content : undefined
      const lines = content ? content.split("\n").length : 0
      const subtitle =
        parsed.startLine !== null && parsed.endLine !== null
          ? `lines ${parsed.startLine}-${parsed.endLine}`
          : content
            ? lineCountLabel(lines)
            : undefined
      return {
        ...baseOf(part),
        kind: "read",
        icon: "file",
        accent: "sky",
        title: path,
        subtitle,
        path,
        offset,
        limit,
        content,
        startLine: parsed.startLine ?? offset,
        truncatedNext: parsed.truncatedNext ?? undefined,
      }
    }

    case "write": {
      const path = readString(input, "filePath", "path", "file")
      if (!path) return genericSummary(part, state, status)
      const content = readString(input, "content") ?? ""
      const lines = content.split("\n").length
      return {
        ...baseOf(part),
        kind: "write",
        icon: "pencil",
        accent: "violet",
        title: path,
        subtitle: lineCountLabel(lines),
        path,
        content,
        lines,
      }
    }

    case "edit": {
      const path = readString(input, "filePath", "path", "file") ?? ""
      const before = readString(input, "oldString", "old_string")
      const after = readString(input, "newString", "new_string")
      const patch = readString(input, "patch", "diff")
      const output = state.output
      let diff: DiffLine[] = []
      if (before !== null && after !== null) diff = diffLines(before, after)
      else if (patch) diff = parsePatch(patch)
      else if (output && looksLikeDiff(output)) diff = parsePatch(output)
      const { additions, deletions } = countDiffLines(diff)
      return {
        ...baseOf(part),
        kind: "edit",
        icon: "diff",
        accent: "amber",
        title: path || state.title || part.tool,
        subtitle: diff.length > 0 ? `+${additions} −${deletions}` : undefined,
        path,
        diff,
        additions,
        deletions,
        output: state.output,
      }
    }

    case "search": {
      const pattern = readString(input, "pattern", "query") ?? ""
      const path = readString(input, "path", "directory") ?? undefined
      const matches = (state.output ?? "").split("\n").filter((line) => line.length > 0)
      if (!pattern && !path) return genericSummary(part, state, status)
      const title = firstLine(pattern) || (path ?? part.tool)
      const rawSubtitle = pattern ? path : undefined
      const subtitle =
        rawSubtitle && !sameLabel(rawSubtitle, title) && !sameLabel(rawSubtitle, part.tool)
          ? rawSubtitle
          : undefined
      return {
        ...baseOf(part),
        kind: "search",
        icon: "search",
        accent: "teal",
        title,
        subtitle,
        pattern,
        path,
        matches,
      }
    }

    case "web": {
      const url = readString(input, "url", "uri") ?? undefined
      const query = readString(input, "query", "q") ?? undefined
      if (!url && !query) return genericSummary(part, state, status)
      return {
        ...baseOf(part),
        kind: "web",
        icon: "globe",
        accent: "cyan",
        // No subtitle: the globe glyph plus the URL/query title already says
        // what it is — the old "Web search" label only repeated the tool name.
        title: firstLine(url ?? query ?? part.tool),
        subtitle: undefined,
        url,
        query,
        output: state.output,
      }
    }

    case "todo": {
      const todos = readArray(input, "todos").map((raw) => ({
        content: readString(raw, "content") ?? "",
        status: readString(raw, "status") ?? "pending",
      }))
      const done = todos.filter((todo) => todo.status === "completed").length
      return {
        ...baseOf(part),
        kind: "todo",
        icon: "checklist",
        accent: "indigo",
        title: "Todo list",
        subtitle: todos.length > 0 ? `${done}/${todos.length} done` : undefined,
        todos,
      }
    }

    case "question": {
      const questions = questionItems(input)
      return {
        ...baseOf(part),
        kind: "question",
        icon: "question",
        accent: "indigo",
        title: questions[0]?.header || firstLine(questions[0]?.question ?? "") || "Questions",
        // No subtitle: the header already carries the tool name plus the first
        // question, and the body lists every question — the old "N questions"
        // / "Waiting for your answer" labels only repeated that on the right.
        subtitle: undefined,
        questions,
      }
    }

    default:
      return genericSummary(part, state, status)
  }
}
