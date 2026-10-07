/**
 * Minimal syntax highlighting shared by both clients (issue #123).
 *
 * Deliberately dependency-free (ADR-30): a line-based regex scanner with no
 * grammar downloads, so web and mobile stay in sync behind one interface and
 * bundles do not grow. Unknown languages render plain — never broken — and
 * the callers cap lines and memoize per content + language, so streaming
 * deltas never re-tokenize unbounded text.
 */

export type SyntaxTokenKind =
  | "keyword"
  | "string"
  | "number"
  | "comment"
  | "function"
  | "type"
  | "punct"
  | "plain"

export interface SyntaxToken {
  text: string
  kind: SyntaxTokenKind
}

/** Canonical language ids the scanner knows; everything else renders plain. */
export type HighlightLanguage = "ts" | "tsx" | "js" | "jsx" | "json" | "py" | "sh"

type ScannerFamily = "c" | "python" | "shell"

const FAMILY: Record<HighlightLanguage, ScannerFamily> = {
  ts: "c",
  tsx: "c",
  js: "c",
  jsx: "c",
  json: "c",
  py: "python",
  sh: "shell",
}

const EXTENSIONS: Record<string, HighlightLanguage> = {
  ts: "ts",
  mts: "ts",
  cts: "ts",
  tsx: "tsx",
  js: "js",
  mjs: "js",
  cjs: "js",
  jsx: "jsx",
  json: "json",
  py: "py",
  sh: "sh",
  bash: "sh",
  zsh: "sh",
}

const ALIASES: Record<string, HighlightLanguage> = {
  typescript: "ts",
  javascript: "js",
  python: "py",
  bash: "sh",
  shell: "sh",
  json: "json",
}

/**
 * Resolves a file path, extension or markdown fence info string to a canonical
 * language id, or `null` when the scanner has no grammar for it (renders plain).
 */
export function detectLanguage(source?: string | null): HighlightLanguage | null {
  if (!source) return null
  const base = source.split("/").pop()?.split("\\").pop() ?? ""
  const info = base.trim().toLowerCase().split(/\s+/)[0] ?? ""
  if (!info) return null
  if (Object.hasOwn(ALIASES, info)) return ALIASES[info]!
  if (Object.hasOwn(FAMILY, info)) return info as HighlightLanguage
  const dot = info.lastIndexOf(".")
  if (dot !== -1) {
    const ext = info.slice(dot + 1)
    if (Object.hasOwn(EXTENSIONS, ext)) return EXTENSIONS[ext]!
  }
  return null
}

const KEYWORDS: Record<ScannerFamily, Set<string>> = {
  c: new Set(
    "const let var function return if else for while do switch case default break continue new typeof instanceof in of try catch finally throw class extends super this import from export default async await null undefined true false interface type enum implements readonly static get set delete void yield".split(
      " ",
    ),
  ),
  python: new Set(
    "def return if elif else for while in not and or is None True False import from as class with lambda pass raise try except finally yield async await global nonlocal assert del".split(
      " ",
    ),
  ),
  shell: new Set(
    "if then else elif fi for while do done case esac function return export local echo exit in".split(" "),
  ),
}

const IDENT_START = /[A-Za-z_$]/
const IDENT_PART = /[\w$]/
const DIGIT = /[0-9]/

/** Tokenizes one line; unknown languages come back as a single plain token. */
export function highlightLine(line: string, language: HighlightLanguage | null): SyntaxToken[] {
  if (!language || !Object.hasOwn(FAMILY, language) || line.length > 2000) {
    return [{ text: line, kind: "plain" }]
  }
  const family = FAMILY[language]
  const keywords = KEYWORDS[family]
  const tokens: SyntaxToken[] = []
  const push = (text: string, kind: SyntaxTokenKind): void => {
    if (!text) return
    const prev = tokens[tokens.length - 1]
    if (prev && prev.kind === kind) prev.text += text
    else tokens.push({ text, kind })
  }

  let i = 0
  const n = line.length
  while (i < n) {
    const rest = line.slice(i)
    // Line comments: `//` in c-like grammars, `#` in python/shell.
    if ((family === "c" && rest.startsWith("//")) || (family !== "c" && rest.startsWith("#"))) {
      push(rest, "comment")
      break
    }
    // Same-line block comment (c-like only); an unclosed opener comments the rest.
    if (family === "c" && rest.startsWith("/*")) {
      const close = rest.indexOf("*/", 2)
      if (close === -1) {
        push(rest, "comment")
        break
      }
      push(rest.slice(0, close + 2), "comment")
      i += close + 2
      continue
    }
    const char = line[i]!
    // Strings with backslash escapes.
    if (char === '"' || char === "'" || char === "`") {
      let j = i + 1
      while (j < n) {
        if (line[j] === "\\") j += 2
        else if (line[j] === char) {
          j++
          break
        } else j++
      }
      push(line.slice(i, j), "string")
      i = j
      continue
    }
    // Numbers.
    if (DIGIT.test(char) || (char === "." && i + 1 < n && DIGIT.test(line[i + 1]!))) {
      let j = i
      while (j < n && /[0-9a-fA-FxXoOb._]/.test(line[j]!)) j++
      push(line.slice(i, j), "number")
      i = j
      continue
    }
    // Identifiers: keyword, call (`name(`), type (`Capitalized`) or plain.
    if (IDENT_START.test(char)) {
      let j = i + 1
      while (j < n && IDENT_PART.test(line[j]!)) j++
      const word = line.slice(i, j)
      if (keywords.has(word)) push(word, "keyword")
      else if (line[j] === "(") push(word, "function")
      else if (/^[A-Z]/.test(word)) push(word, "type")
      else push(word, "plain")
      i = j
      continue
    }
    push(char, "punct")
    i++
  }
  return tokens.length > 0 ? tokens : [{ text: line, kind: "plain" }]
}

/**
 * Tokenizes `text` line by line, capped at `maxLines` (callers show their own
 * "show all" toggle for the rest). The join of every token always reproduces
 * the input exactly.
 */
export function highlightCode(
  text: string,
  language: HighlightLanguage | null,
  maxLines = 200,
): SyntaxToken[][] {
  return text.split("\n").slice(0, maxLines).map((line) => highlightLine(line, language))
}
