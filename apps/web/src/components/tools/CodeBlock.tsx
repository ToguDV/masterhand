import { useState } from "react"
import { looksLineNumbered, truncateLines } from "@masterhand/client-core"
import { useToast } from "../Toast"

/** Clipboard button with a transient toast; hidden when unavailable. */
function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const toast = useToast()
  const available = typeof navigator !== "undefined" && Boolean(navigator.clipboard)
  if (!available) return null
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        void navigator.clipboard
          .writeText(text)
          .then(() => toast("✓ Copied to clipboard"))
          .catch(() => {})
      }}
      className="shrink-0 rounded-xs px-1.5 py-0.5 text-[10px] font-medium text-code-muted hover:bg-code-soft hover:text-code-text"
      title={label}
    >
      {label}
    </button>
  )
}

/**
 * Monospace block with optional line numbers, a copy action and a per-block
 * "show all" toggle. Text that already carries opencode line numbers
 * (`00001| …`) is not numbered twice. Code surfaces stay dark in both themes.
 */
export function CodeBlock({
  text,
  title,
  maxLines = 24,
  numbered = true,
  startLine = 1,
  className = "",
}: {
  text: string
  /** Small label on the top-left (file name, language…). */
  title?: string
  maxLines?: number
  numbered?: boolean
  /** 1-based number of the first line (read pages start at their offset). */
  startLine?: number
  className?: string
}) {
  const [expanded, setExpanded] = useState(false)
  const alreadyNumbered = looksLineNumbered(text)
  const truncated = truncateLines(text, expanded ? Number.POSITIVE_INFINITY : maxLines)
  const lines = truncated.text.split("\n")
  const showNumbers = numbered && !alreadyNumbered

  return (
    <div className={`mh-code ${className}`}>
      {(title || truncated.hiddenLines > 0) && (
        <div className="mh-code__header">
          <span className="min-w-0 flex-1 truncate">{title}</span>
          <CopyButton text={text} />
          {truncated.hiddenLines > 0 && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="shrink-0 rounded-xs px-1.5 py-0.5 text-[10px] font-medium text-code-muted hover:bg-code-soft hover:text-code-text"
            >
              Show all ({truncated.totalLines} lines)
            </button>
          )}
        </div>
      )}
      <div className="scroll-thin max-h-80 overflow-auto">
        <pre>
          <code>
            {lines.map((line, index) => (
              <span key={index} className="block whitespace-pre-wrap break-words">
                {showNumbers && (
                  <span className="mr-3 inline-block w-6 select-none text-right text-code-muted">
                    {startLine + index}
                  </span>
                )}
                {line || " "}
              </span>
            ))}
            {truncated.hiddenLines > 0 && (
              <span className="block pt-1 text-[10px] text-code-muted">… {truncated.hiddenLines} more lines</span>
            )}
          </code>
        </pre>
      </div>
    </div>
  )
}

/** Copy action exported for the terminal block (command line). */
export { CopyButton }
