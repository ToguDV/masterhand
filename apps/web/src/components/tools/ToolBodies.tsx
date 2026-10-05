import { Fragment, useState, type ReactNode } from "react"
import { truncateLines, type TodoItem } from "@masterhand/client-core"
import { CheckIcon, ChevronRightIcon, CircleIcon, XIcon } from "../icons"

/** Fallback body for unknown tools: readable key/value rows instead of raw JSON. */
export function KeyValueList({ entries }: { entries: Array<{ key: string; value: string }> }) {
  if (entries.length === 0) return null
  return (
    <dl className="scroll-thin mh-code max-h-72 space-y-1.5 overflow-auto px-2.5 py-2">
      {entries.map((entry) => (
        <div key={entry.key} className="flex gap-2 text-xs">
          <dt className="w-28 shrink-0 truncate font-mono text-code-muted" title={entry.key}>
            {entry.key}
          </dt>
          <dd className="min-w-0 flex-1 whitespace-pre-wrap break-words text-code-text">{entry.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Terminal-style block: the command line, its working directory and the output. */
export function TerminalBody({
  command,
  cwd,
  output,
  running,
  copySlot,
}: {
  command: string
  cwd?: string
  output?: string
  running: boolean
  copySlot?: ReactNode
}) {
  const cleaned = output ?? ""
  return (
    <div className="space-y-2">
      <div className="mh-code">
        <div className="flex items-start gap-2 px-3 py-2">
          <span className="select-none font-mono text-xs leading-5 text-[#7fd8ba]">$</span>
          <code className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-xs leading-5 text-code-text">
            {command}
          </code>
          {copySlot}
        </div>
      </div>
      {cwd && <p className="px-0.5 font-mono text-[10px] text-ink-faint">{cwd}</p>}
      {cleaned ? (
        <TerminalOutput text={cleaned} />
      ) : running ? (
        <p className="px-0.5 text-xs text-ink-muted">Running…</p>
      ) : null}
    </div>
  )
}

function TerminalOutput({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  const truncated = truncateLines(text, expanded ? Number.POSITIVE_INFINITY : 30)
  return (
    <div className="mh-code">
      <pre className="scroll-thin max-h-80 overflow-auto">
        <code className="whitespace-pre-wrap break-words">{truncated.text}</code>
      </pre>
      {truncated.hiddenLines > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="block w-full border-t border-code-soft px-2.5 py-1 text-left text-[10px] text-code-muted hover:text-code-text"
        >
          … {truncated.hiddenLines} more lines (show all)
        </button>
      )}
    </div>
  )
}

/** Highlights every occurrence of `pattern` inside a search result line. */
function Highlight({ text, pattern }: { text: string; pattern: string }) {
  if (!pattern) return <>{text}</>
  let regex: RegExp
  try {
    regex = new RegExp(pattern, "gi")
  } catch {
    return <>{text}</>
  }
  const parts = text.split(regex)
  const matches = text.match(regex) ?? []
  if (matches.length === 0) return <>{text}</>
  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {part}
          {index < matches.length && <span className="rounded-xs bg-accent-soft px-0.5 text-accent">{matches[index]}</span>}
        </Fragment>
      ))}
    </>
  )
}

/** Search results: one monospace line per match, pattern highlighted. */
export function SearchBody({ pattern, matches }: { pattern: string; matches: string[] }) {
  const [expanded, setExpanded] = useState(false)
  if (matches.length === 0) return <p className="px-0.5 text-xs text-ink-muted">No matches</p>
  const shown = expanded ? matches : matches.slice(0, 40)
  return (
    <div className="mh-code">
      <div className="scroll-thin max-h-72 overflow-auto py-1">
        {shown.map((line, index) => (
          <p
            key={index}
            title={line}
            className="truncate whitespace-pre px-2.5 py-0.5 font-mono text-xs text-code-text hover:bg-code-soft/60"
          >
            <Highlight text={line} pattern={pattern} />
          </p>
        ))}
      </div>
      {matches.length > shown.length && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="block w-full border-t border-code-soft px-2.5 py-1 text-left text-[10px] text-code-muted hover:text-code-text"
        >
          … {matches.length - shown.length} more matches (show all)
        </button>
      )}
    </div>
  )
}

const TODO_STYLES: Record<string, { icon: ReactNode; className: string }> = {
  completed: { icon: <CheckIcon size={12} />, className: "text-accent" },
  in_progress: { icon: <ChevronRightIcon size={12} />, className: "text-warning" },
  cancelled: { icon: <XIcon size={12} />, className: "text-ink-faint" },
  pending: { icon: <CircleIcon size={12} />, className: "text-ink-muted" },
}

/** Checklist for the todo tool. */
export function TodoBody({ todos }: { todos: TodoItem[] }) {
  if (todos.length === 0) return null
  return (
    <ul className="space-y-1.5 rounded-md border border-hairline bg-surface px-2.5 py-2">
      {todos.map((todo, index) => {
        const style = TODO_STYLES[todo.status] ?? TODO_STYLES.pending!
        return (
          <li key={index} className="flex items-start gap-2 text-xs">
            <span className={`shrink-0 ${style.className}`}>{style.icon}</span>
            <span className={todo.status === "completed" ? "text-ink-muted line-through" : "text-ink-soft"}>
              {todo.content}
            </span>
          </li>
        )
      })}
    </ul>
  )
}
