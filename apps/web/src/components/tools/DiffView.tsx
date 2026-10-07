import { useMemo, useState } from "react"
import {
  detectLanguage,
  highlightLine,
  type DiffLine,
  type HighlightLanguage,
} from "@masterhand/client-core"

const MAX_ROWS = 160

function rowClass(line: DiffLine): string {
  if (line.kind === "add") return "is-add"
  if (line.kind === "remove") return "is-remove"
  if (line.text.startsWith("@@")) return "bg-code-soft/60 text-code-muted"
  return ""
}

const TOKEN_CLASS: Record<string, string | null> = {
  keyword: "mh-tok-keyword",
  string: "mh-tok-string",
  number: "mh-tok-number",
  comment: "mh-tok-comment",
  function: "mh-tok-function",
  type: "mh-tok-type",
  punct: null,
  plain: null,
}

function sign(line: DiffLine): string {
  if (line.kind === "add") return "+"
  if (line.kind === "remove") return "−"
  return " "
}

/** Unified line diff with +/− coloring, syntax highlighting (#123) and a row cap. */
export function DiffView({
  diff,
  language,
  className = "",
}: {
  diff: DiffLine[]
  /** File path for highlighting the changed lines (plain when unknown). */
  language?: string
  className?: string
}) {
  const [expanded, setExpanded] = useState(false)
  const rows = expanded ? diff : diff.slice(0, MAX_ROWS)
  const hidden = diff.length - rows.length
  const resolved: HighlightLanguage | null = useMemo(
    () => (language ? detectLanguage(language) : null),
    [language],
  )
  // Streaming-safe: tokenize once per diff content + language. Added and
  // removed rows keep their semantic row colors; only context is highlighted.
  const highlighted = useMemo(
    () => (resolved ? rows.map((line) => (line.kind === "context" ? highlightLine(line.text, resolved) : null)) : null),
    [rows, resolved],
  )

  return (
    <div className={`mh-diff ${className}`}>
      <div className="scroll-thin max-h-80 overflow-auto">
        <pre>
          <code>
            {rows.map((line, index) => (
              <span key={index} className={`mh-diff__line ${rowClass(line)}`}>
                <span className="w-3 shrink-0 select-none opacity-70">{sign(line)}</span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
                  {highlighted && highlighted[index] ? (
                    <>
                      {highlighted[index]!.map((token, tokenIndex) => {
                        const className = TOKEN_CLASS[token.kind] ?? null
                        return className ? (
                          <span key={tokenIndex} className={className}>
                            {token.text}
                          </span>
                        ) : (
                          <span key={tokenIndex}>{token.text}</span>
                        )
                      })}
                    </>
                  ) : (
                    line.text || " "
                  )}
                </span>
              </span>
            ))}
            {hidden > 0 && (
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="mt-1 block w-full px-2 py-0.5 text-left text-[10px] text-code-muted hover:text-code-text"
              >
                … {hidden} more lines (show all)
              </button>
            )}
          </code>
        </pre>
      </div>
    </div>
  )
}
