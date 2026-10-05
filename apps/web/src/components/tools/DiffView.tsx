import { useState } from "react"
import type { DiffLine } from "@masterhand/client-core"

const MAX_ROWS = 160

function rowClass(line: DiffLine): string {
  if (line.kind === "add") return "is-add"
  if (line.kind === "remove") return "is-remove"
  if (line.text.startsWith("@@")) return "bg-code-soft/60 text-code-muted"
  return ""
}

function sign(line: DiffLine): string {
  if (line.kind === "add") return "+"
  if (line.kind === "remove") return "−"
  return " "
}

/** Unified line diff with +/− coloring and a row cap. */
export function DiffView({ diff, className = "" }: { diff: DiffLine[]; className?: string }) {
  const [expanded, setExpanded] = useState(false)
  const rows = expanded ? diff : diff.slice(0, MAX_ROWS)
  const hidden = diff.length - rows.length

  return (
    <div className={`mh-diff ${className}`}>
      <div className="scroll-thin max-h-80 overflow-auto">
        <pre>
          <code>
            {rows.map((line, index) => (
              <span key={index} className={`mh-diff__line ${rowClass(line)}`}>
                <span className="w-3 shrink-0 select-none opacity-70">{sign(line)}</span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{line.text || " "}</span>
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
