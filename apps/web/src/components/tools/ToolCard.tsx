import { Fragment, useEffect, useState, type ReactNode } from "react"
import {
  describeTool,
  formatDuration,
  looksLineNumbered,
  stripAnsi,
  type ChatToolPart,
  type ChatToolStatus,
  type ChatToolTiming,
  type ToolSummary,
} from "@masterhand/client-core"
import { StatusDot } from "./StatusDot"
import { ToolIcon } from "./ToolIcon"
import { CodeBlock, CopyButton } from "./CodeBlock"
import { DiffView } from "./DiffView"
import { KeyValueList, SearchBody, TerminalBody, TodoBody } from "./ToolBodies"
import { ExternalLinkIcon } from "../icons"

/**
 * Live duration for running tools: recomputes once per second while the tool
 * runs, then freezes with the final mark. Returns `null` when timing is absent.
 */
function useLiveDuration(status: ChatToolStatus, timing?: ChatToolTiming): number | null {
  const running = status === "running" && timing?.created !== undefined && timing.completed === undefined
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000)
    return () => window.clearInterval(timer)
  }, [running])
  if (timing?.created === undefined) return null
  const end = timing.completed ?? (running ? Date.now() : undefined)
  return end === undefined ? null : Math.max(0, end - timing.created)
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`mh-tool__chevron h-3 w-3 shrink-0 ${open ? "rotate-90" : ""}`}
      aria-hidden="true"
    >
      <path d="M3.5 2l3 3-3 3" />
    </svg>
  )
}

function HeaderStats({ summary, duration }: { summary: ToolSummary; duration: number | null }) {
  const badges: ReactNode[] = []
  if (summary.kind === "shell" && summary.exitCode !== null) {
    badges.push(
      <span
        key="exit"
        className={`mh-chip mh-chip--mono ${summary.exitCode === 0 ? "text-accent" : "text-danger"}`}
      >
        exit {summary.exitCode}
      </span>,
    )
  }
  if (summary.kind === "edit" && (summary.additions > 0 || summary.deletions > 0)) {
    badges.push(
      <span key="diff" className="mh-chip mh-chip--accent mh-chip--mono">
        +{summary.additions} −{summary.deletions}
      </span>,
    )
  }
  if (summary.kind === "search" && summary.matches.length > 0) {
    badges.push(
      <span key="matches" className="mh-chip">
        {summary.matches.length} matches
      </span>,
    )
  }
  if (summary.kind === "todo" && summary.todos.length > 0) {
    const done = summary.todos.filter((todo) => todo.status === "completed").length
    badges.push(
      <span key="todos" className="mh-chip">
        {done}/{summary.todos.length}
      </span>,
    )
  }
  if (duration !== null && duration >= 400) {
    badges.push(
      <span key="time" className="font-mono text-[10px] text-ink-faint">
        {formatDuration(duration)}
      </span>,
    )
  }
  if (badges.length === 0) return null
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {badges.map((badge, index) => (
        <Fragment key={index}>{badge}</Fragment>
      ))}
    </span>
  )
}

function PendingBody() {
  return (
    <div className="space-y-1.5" data-testid="tool-pending">
      <span className="block h-2 w-2/3 animate-pulse rounded bg-surface-muted" />
      <span className="block h-2 w-1/3 animate-pulse rounded bg-surface-muted" />
    </div>
  )
}

function ToolBody({ summary }: { summary: ToolSummary }) {
  switch (summary.kind) {
    case "shell":
      return (
        <TerminalBody
          command={summary.command}
          cwd={summary.cwd}
          output={summary.output ? stripAnsi(summary.output) : undefined}
          running={summary.status === "running"}
          copySlot={<CopyButton text={summary.command} />}
        />
      )
    case "read":
      if (summary.content === undefined) return <p className="px-0.5 text-xs text-ink-muted">Reading…</p>
      if (summary.content === "") return <p className="px-0.5 text-xs text-ink-muted">Empty file</p>
      return (
        <div className="space-y-1.5">
          <CodeBlock
            text={summary.content}
            language={summary.path}
            numbered={!looksLineNumbered(summary.content)}
            startLine={summary.startLine ?? 1}
            maxLines={28}
          />
          {summary.truncatedNext !== undefined && (
            <p className="px-0.5 text-[10px] text-ink-faint">
              Output truncated · continue from line {summary.truncatedNext}
            </p>
          )}
        </div>
      )
    case "write":
      return summary.content ? (
        <CodeBlock text={summary.content} language={summary.path} maxLines={28} />
      ) : (
        <p className="px-0.5 text-xs text-ink-muted">Writing…</p>
      )
    case "edit":
      if (summary.diff.length > 0) return <DiffView diff={summary.diff} language={summary.path} />
      return summary.output ? (
        <CodeBlock text={summary.output} language={summary.path} numbered={false} maxLines={12} />
      ) : (
        <p className="px-0.5 text-xs text-ink-muted">Applying edit…</p>
      )
    case "search":
      return <SearchBody pattern={summary.pattern} matches={summary.matches} />
    case "web":
      return (
        <div className="space-y-2">
          {summary.url && (
            <a
              href={summary.url}
              target="_blank"
              rel="noreferrer noopener"
              className="block truncate rounded-md border border-hairline bg-code px-2.5 py-1.5 font-mono text-xs text-code-text hover:border-accent-line"
            >
              {summary.url}
              <ExternalLinkIcon size={12} className="ml-1 inline-block align-text-bottom" />
            </a>
          )}
          {summary.output && <CodeBlock text={summary.output} numbered={false} maxLines={20} />}
        </div>
      )
    case "todo":
      return <TodoBody todos={summary.todos} />
    case "question":
      // Fallback when no form state is available (e.g. a side-question panel):
      // a readable list of what the agent asked instead of raw JSON.
      return (
        <ul className="space-y-2">
          {summary.questions.map((question, index) => (
            <li key={index} className="rounded-md border border-hairline bg-surface px-2.5 py-2">
              {question.header && <p className="mh-micro text-ink-muted">{question.header}</p>}
              <p className="text-sm text-ink">{question.question}</p>
              {question.options.length > 0 && (
                <ul className="mt-1.5 space-y-1">
                  {question.options.map((option) => (
                    <li key={option.label} className="text-xs text-ink-muted">
                      <span className="text-ink-soft">{option.label}</span>
                      {option.description ? ` — ${option.description}` : ""}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )
    default:
      return (
        <div className="space-y-2">
          <KeyValueList entries={summary.entries} />
          {summary.output && <CodeBlock text={stripAnsi(summary.output)} numbered={false} maxLines={24} />}
        </div>
      )
  }
}

/**
 * Collapsible card for every agent tool. The header carries a semantic summary
 * (command, path, diff stats, matches…) and the body renders the tool-specific
 * view; unknown tools fall back to a readable key/value list, never raw JSON.
 */
export function ToolCard({ part }: { part: ChatToolPart }) {
  const [open, setOpen] = useState(false)
  const summary = describeTool(part)
  const duration = useLiveDuration(summary.status, summary.timing)
  const pending = summary.status === "pending"
  const showSubtitle = summary.subtitle && summary.kind !== "edit"

  return (
    <div
      className={`mh-tool ${open ? "is-open" : ""} ${summary.status === "error" ? "is-error" : ""}`}
      data-testid="tool-card"
      data-tool={summary.tool}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="mh-tool__header hover:bg-surface-muted"
      >
        <StatusDot status={summary.status} />
        <span className="mh-tool__glyph">
          <ToolIcon icon={summary.icon} className="h-3.5 w-3.5" />
        </span>
        <span className="mh-tool__title">
          <strong>{summary.tool}</strong>
          {summary.title ? ` · ${summary.title}` : ""}
        </span>
        {showSubtitle && (
          <span className="hidden max-w-[26%] truncate text-xs text-ink-faint sm:block">{summary.subtitle}</span>
        )}
        <HeaderStats summary={summary} duration={duration} />
        <Chevron open={open} />
      </button>

      {open && (
        <div className="mh-reveal mh-tool__body">
          {pending ? <PendingBody /> : <ToolBody summary={summary} />}
          {summary.error && (
            <p className="rounded-md border border-danger-line bg-danger-soft px-2.5 py-1.5 text-xs text-danger">
              {summary.error}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
