import { memo, useState, type ReactNode } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkBreaks from "remark-breaks"
import remarkGfm from "remark-gfm"
import {
  isQuestionTool,
  isTaskTool,
  subagentInfo,
  subagentOutput,
  type ChatMessage,
  type ChatPart,
  type ChatReasoningPart,
  type ChatTextPart,
  type ChatToolPart,
  type FormAnswer,
  type FormInfo,
  type Permission,
} from "@masterhand/client-core"
import { ToolCard } from "./tools/ToolCard"
import { StatusDot } from "./tools/StatusDot"
import { QuestionCard } from "./QuestionCard"
import { PermissionCard, PermissionResolved, type AnsweredPermission } from "./PermissionCard"
import { MessageStats } from "./MessageStats"

// Assistant output is markdown; render it as such (GFM + single newlines as
// breaks, matching what the model expects to see). Every element maps to the
// design tokens: hairlines, ink text and the single emerald accent.
const markdownComponents: Components = {
  p: ({ node, ...props }) => <p className="my-2 break-words first:mt-0 last:mb-0" {...props} />,
  h1: ({ node, ...props }) => <h1 className="mt-4 mb-2 text-xl font-semibold first:mt-0" {...props} />,
  h2: ({ node, ...props }) => <h2 className="mt-4 mb-2 text-lg font-semibold first:mt-0" {...props} />,
  h3: ({ node, ...props }) => <h3 className="mt-3 mb-1.5 text-base font-semibold first:mt-0" {...props} />,
  h4: ({ node, ...props }) => <h4 className="mt-3 mb-1.5 text-base font-semibold first:mt-0" {...props} />,
  h5: ({ node, ...props }) => <h5 className="mt-3 mb-1.5 text-base font-semibold first:mt-0" {...props} />,
  h6: ({ node, ...props }) => <h6 className="mt-3 mb-1.5 text-base font-semibold text-ink-muted first:mt-0" {...props} />,
  ul: ({ node, ...props }) => (
    <ul className="my-2 list-disc space-y-1 pl-5 first:mt-0 last:mb-0 [&>li:has(>input)]:list-none" {...props} />
  ),
  ol: ({ node, ...props }) => <ol className="my-2 list-decimal space-y-1 pl-5 first:mt-0 last:mb-0" {...props} />,
  li: ({ node, ...props }) => <li className="break-words [&>p]:my-0 [&>ol]:my-1 [&>ul]:my-1" {...props} />,
  blockquote: ({ node, ...props }) => (
    <blockquote className="my-2 border-l-2 border-hairline-strong pl-3 text-ink-muted first:mt-0 last:mb-0" {...props} />
  ),
  a: ({ node, ...props }) => (
    <a
      className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
      target="_blank"
      rel="noreferrer"
      {...props}
    />
  ),
  code: ({ node, ...props }) => (
    <code className="rounded-xs bg-surface-muted px-1 py-0.5 font-mono text-[13px] text-ink" {...props} />
  ),
  pre: ({ node, ...props }) => (
    <pre
      className="scroll-thin my-2 overflow-x-auto rounded-md bg-code p-3 font-mono text-[13px] leading-[1.6] text-code-text first:mt-0 last:mb-0 [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-inherit"
      {...props}
    />
  ),
  table: ({ node, ...props }) => (
    <div className="scroll-thin my-3 overflow-x-auto first:mt-0 last:mb-0">
      <table className="w-full border-collapse text-sm" {...props} />
    </div>
  ),
  th: ({ node, ...props }) => (
    <th className="border border-hairline bg-surface-muted px-2 py-1 text-left font-semibold" {...props} />
  ),
  td: ({ node, ...props }) => <td className="border border-hairline px-2 py-1 align-top" {...props} />,
  hr: ({ node, ...props }) => <hr className="my-4 border-hairline" {...props} />,
  img: ({ node, ...props }) => <img className="my-2 max-w-full rounded-md" {...props} />,
  input: ({ node, ...props }) => <input className="mr-1.5 accent-[var(--mh-accent)]" {...props} />,
}

// Memoized: streaming updates rebuild the message list on every delta, but the
// text of every other part keeps the same string value, so parsing is skipped.
const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
  if (!text.trim()) return null
  return (
    <div data-testid="markdown" className="mh-msg__body">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={markdownComponents}>
        {text}
      </ReactMarkdown>
    </div>
  )
})

function ReasoningBlock({ part }: { part: ChatReasoningPart }) {
  return (
    <details className="text-sm text-ink-muted">
      <summary className="mh-micro cursor-pointer select-none">Reasoning</summary>
      <p className="mt-1 break-words whitespace-pre-wrap">{part.text}</p>
    </details>
  )
}

function SubagentCall({
  part,
  onOpenSession,
}: {
  part: ChatToolPart
  onOpenSession?: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const state = part.state
  const info = subagentInfo(part)
  const output = subagentOutput(part)

  return (
    <div className={`mh-tool ${open ? "is-open" : ""}`}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="mh-tool__header hover:bg-surface-muted"
      >
        <StatusDot status={state.status} />
        <span className="mh-chip mh-chip--outline">Subagent</span>
        <span className="shrink-0 font-mono text-xs text-ink-soft">{info.name}</span>
        <span className="min-w-0 flex-1 truncate text-ink-muted">{info.description}</span>
        {info.background && <span className="mh-chip">background</span>}
        <span className="shrink-0 text-xs text-ink-faint">{state.status}</span>
      </button>

      {open && (
        <div className="mh-reveal mh-tool__body border-t border-hairline pt-2">
          {info.prompt && (
            <div>
              <p className="mh-micro text-ink-muted">Prompt</p>
              <pre className="scroll-thin max-h-60 overflow-auto whitespace-pre-wrap text-xs text-ink-muted">
                {info.prompt}
              </pre>
            </div>
          )}
          {output && (
            <div className="border-t border-hairline pt-2">
              <p className="mh-micro text-ink-muted">Result</p>
              <pre className="scroll-thin max-h-60 overflow-auto whitespace-pre-wrap text-xs text-ink-soft">
                {output}
              </pre>
            </div>
          )}
          {state.status === "error" && <p className="text-xs text-danger">{state.error}</p>}
        </div>
      )}

      {info.sessionID && onOpenSession && (
        <div className="border-t border-hairline px-3 py-1.5">
          <button
            type="button"
            onClick={() => onOpenSession(info.sessionID!)}
            className="text-xs font-medium text-accent hover:text-accent-strong"
          >
            Open session →
          </button>
        </div>
      )}
    </div>
  )
}

/** The permission raised by this tool call, when opencode reported its source. */
function permissionForPart(permission: Permission, part: ChatToolPart): boolean {
  return permission.source?.id === part.callID
}

interface PartViewProps {
  part: ChatPart
  onOpenSession?: (id: string) => void
  forms: FormInfo[]
  answeredForms: Array<{ form: FormInfo; answer: FormAnswer }>
  busyFormID: string | null
  onRespondForm?: (form: FormInfo, answer: FormAnswer) => void
  onCancelForm?: (form: FormInfo) => void
  permissions: Permission[]
  answeredPermissions: AnsweredPermission[]
  respondingPermissionID: string | null
  onRespondPermission?: (permission: Permission, response: "once" | "always" | "reject") => void
}

function PartView({
  part,
  onOpenSession,
  forms,
  answeredForms,
  busyFormID,
  onRespondForm,
  onCancelForm,
  permissions,
  answeredPermissions,
  respondingPermissionID,
  onRespondPermission,
}: PartViewProps) {
  switch (part.type) {
    case "text":
      return <MarkdownText text={part.text} />
    case "reasoning":
      return <ReasoningBlock part={part} />
    case "tool": {
      const pending = permissions.find((permission) => permissionForPart(permission, part))
      const answered = answeredPermissions.find((entry) => permissionForPart(entry.permission, part))
      let content: ReactNode
      if (isTaskTool(part)) content = <SubagentCall part={part} onOpenSession={onOpenSession} />
      else if (isQuestionTool(part) && onRespondForm && onCancelForm) {
        content = (
          <QuestionCard
            part={part}
            forms={forms}
            answeredForms={answeredForms}
            busyFormID={busyFormID}
            onRespond={onRespondForm}
            onCancel={onCancelForm}
          />
        )
      } else content = <ToolCard part={part} />
      return (
        <>
          {content}
          {pending && (
            <PermissionCard
              permission={pending}
              busy={respondingPermissionID === pending.id}
              onRespond={(response) => onRespondPermission?.(pending, response)}
            />
          )}
          {answered && <PermissionResolved entry={answered} />}
        </>
      )
    }
    default:
      return null
  }
}

export function UserBubble({ entry }: { entry: ChatMessage }) {
  const text = entry.parts
    .filter((part): part is ChatTextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n")
  if (!text.trim()) return null
  return <div className="mh-msg--user">{text}</div>
}

export function AssistantBlock({
  entry,
  onOpenSession,
  forms = [],
  answeredForms = [],
  busyFormID = null,
  onRespondForm,
  onCancelForm,
  permissions = [],
  answeredPermissions = [],
  respondingPermissionID = null,
  onRespondPermission,
}: {
  entry: ChatMessage
  onOpenSession?: (id: string) => void
  forms?: FormInfo[]
  answeredForms?: Array<{ form: FormInfo; answer: FormAnswer }>
  busyFormID?: string | null
  onRespondForm?: (form: FormInfo, answer: FormAnswer) => void
  onCancelForm?: (form: FormInfo) => void
  permissions?: Permission[]
  answeredPermissions?: AnsweredPermission[]
  respondingPermissionID?: string | null
  onRespondPermission?: (permission: Permission, response: "once" | "always" | "reject") => void
}) {
  const visible = entry.parts
  const info = entry.info
  const streaming = info.time.completed === undefined
  const errorMessage = info.error ? info.error.message || "Agent error" : null

  return (
    <div className="mh-msg--agent">
      {info.agent && <div className="mh-msg__label mh-micro">{info.agent} · agent</div>}

      {visible.map((part) => (
        <PartView
          key={part.id}
          part={part}
          onOpenSession={onOpenSession}
          forms={forms}
          answeredForms={answeredForms}
          busyFormID={busyFormID}
          onRespondForm={onRespondForm}
          onCancelForm={onCancelForm}
          permissions={permissions}
          answeredPermissions={answeredPermissions}
          respondingPermissionID={respondingPermissionID}
          onRespondPermission={onRespondPermission}
        />
      ))}

      {streaming && visible.length === 0 && (
        <p className="flex items-center gap-2 text-sm text-ink-muted">
          <span className="mh-dot mh-dot--busy" /> Thinking…
        </p>
      )}

      {errorMessage && <p className="text-sm text-danger">{errorMessage}</p>}

      {info.time.completed !== undefined && <MessageStats info={info} />}
    </div>
  )
}
