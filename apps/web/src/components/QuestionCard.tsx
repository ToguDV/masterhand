import { useState } from "react"
import {
  defaultAnswer,
  describeFormAnswer,
  fieldLabel,
  formIsQuestion,
  formToolCallID,
  formatAnswerValue,
  isFieldVisible,
  toFormAnswer,
  validateForm,
  type ChatToolPart,
  type FormAnswer,
  type FormField,
  type FormInfo,
  type FormValue,
} from "@masterhand/client-core"
import { StatusDot } from "./tools/StatusDot"
import { ExternalLinkIcon, XIcon } from "./icons"

/**
 * Inline card for the agent's `question` tool. While the form is pending it
 * shows one question at a time behind a top index (plus a final Submit step),
 * so multi-question forms never dump every field at once. Once answered (here
 * or on another device) it collapses into a read-only summary.
 *
 * `variant="modal"` is the choice-modal rendering: the same content, but the
 * dismiss action moves to the modal footer so it can keep the card pending.
 */
export function QuestionCard({
  part,
  forms,
  answeredForms,
  busyFormID,
  onRespond,
  onCancel,
}: {
  part: ChatToolPart
  forms: FormInfo[]
  answeredForms: Array<{ form: FormInfo; answer: FormAnswer }>
  busyFormID: string | null
  onRespond: (form: FormInfo, answer: FormAnswer) => void
  onCancel: (form: FormInfo) => void
}) {
  const byCall = forms.find((form) => formToolCallID(form) === part.callID)
  const sameSession = forms.filter((form) => form.sessionID === part.sessionID && formIsQuestion(form))
  const form = byCall ?? (sameSession.length === 1 ? sameSession[0]! : null) ?? null

  if (form) {
    return (
      <QuestionForm
        key={form.id}
        form={form}
        busy={busyFormID === form.id}
        onRespond={onRespond}
        onCancel={onCancel}
      />
    )
  }

  const answered = answeredForms.find((entry) => formToolCallID(entry.form) === part.callID)
  return <AnsweredCard part={part} answered={answered ?? null} />
}

export function QuestionForm({
  form,
  busy,
  variant = "inline",
  onRespond,
  onCancel,
}: {
  form: FormInfo
  busy: boolean
  variant?: "inline" | "modal"
  onRespond: (form: FormInfo, answer: FormAnswer) => void
  onCancel: (form: FormInfo) => void
}) {
  const [answer, setAnswer] = useState<FormAnswer>(() => defaultAnswer(form))
  const [submitted, setSubmitted] = useState(false)
  // `null` selects the final Submit step; a string selects that field's step.
  const [active, setActive] = useState<string | null>(() => firstFieldKey(form))

  const errors = validateForm(form, answer)
  const valid = Object.keys(errors).length === 0
  const fields = form.fields.filter((field) => isFieldVisible(field, answer))
  // Conditional fields appear/disappear as answers change; keep a valid step.
  // `null` is a valid step (the final Submit), so only fall back when a
  // selected *field* is no longer visible.
  const currentKey = active === null || fields.some((field) => field.key === active) ? active : fields[0]?.key ?? null
  const current = fields.find((field) => field.key === currentKey) ?? null
  const step = fields.findIndex((field) => field.key === currentKey)
  const multi = fields.length > 1

  function update(key: string, value: FormValue): void {
    setAnswer((previous) => ({ ...previous, [key]: value }))
  }

  function submit(): void {
    setSubmitted(true)
    if (valid) {
      onRespond(form, toFormAnswer(form, answer))
      return
    }
    const firstInvalid = fields.find((field) => errors[field.key])
    if (firstInvalid) setActive(firstInvalid.key)
  }

  return (
    <div className="mh-question" data-testid="question-card">
      <div className="mh-question__head">
        <span className="mh-msg__label mh-micro min-w-0 truncate">{form.title || "Question"}</span>
        {multi && (
          <span className="mh-caption mh-muted shrink-0">
            {step >= 0 ? step + 1 : fields.length + 1} of {fields.length + 1}
          </span>
        )}
      </div>

      {multi && (
        <QuestionIndex
          fields={fields}
          active={currentKey}
          errors={submitted ? errors : {}}
          onSelect={setActive}
        />
      )}

      <form
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
        className="flex flex-col gap-4"
      >
        {current ? (
          <Field
            field={current}
            value={answer[current.key]}
            error={submitted ? errors[current.key] : undefined}
            onChange={(value) => update(current.key, value)}
          />
        ) : (
          <ReviewStep form={form} answer={answer} errors={submitted ? errors : {}} />
        )}

        <div className="mh-question__actions items-center">
          {variant === "inline" ? (
            <>
              <span className="mh-caption mh-muted flex-1 basis-full sm:basis-auto">
                The agent is waiting for this answer.
              </span>
              <button type="button" disabled={busy} onClick={() => onCancel(form)} className="mh-btn mh-btn--ghost">
                Dismiss
              </button>
            </>
          ) : null}
          {multi && current ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => setActive(step >= 0 && step < fields.length - 1 ? fields[step + 1]!.key : null)}
              className={`mh-btn mh-btn--secondary ${variant === "modal" ? "flex-1" : ""}`}
            >
              Next
            </button>
          ) : (
            <button type="submit" disabled={busy} className="mh-btn mh-btn--primary">
              {busy ? "Sending…" : "Submit"}
            </button>
          )}
        </div>
      </form>
    </div>
  )
}

/** The first visible field's key, or `null` when the form has none. */
function firstFieldKey(form: FormInfo): string | null {
  const initial = defaultAnswer(form)
  const field = form.fields.find((candidate) => isFieldVisible(candidate, initial))
  return field ? field.key : null
}

/** Top index: one tab per question plus the final Submit step. */
function QuestionIndex({
  fields,
  active,
  errors,
  onSelect,
}: {
  fields: FormField[]
  active: string | null
  errors: Record<string, string>
  onSelect: (key: string | null) => void
}) {
  return (
    <div role="tablist" aria-label="Questions" className="mh-tabindex">
      {fields.map((field, index) => {
        const selected = active === field.key
        return (
          <button
            key={field.key}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onSelect(field.key)}
            className={`mh-tabindex__tab ${selected ? "is-active" : ""}`}
          >
            {errors[field.key] && <span className="mh-tabindex__dot" aria-hidden="true" />}
            {index + 1} · {fieldLabel(field)}
          </button>
        )
      })}
      <button
        type="button"
        role="tab"
        aria-selected={active === null}
        onClick={() => onSelect(null)}
        className={`mh-tabindex__tab ${active === null ? "is-active" : ""}`}
      >
        Submit
      </button>
    </div>
  )
}

/** Final step: a compact review of every visible answer. */
function ReviewStep({
  form,
  answer,
  errors,
}: {
  form: FormInfo
  answer: FormAnswer
  errors: Record<string, string>
}) {
  const rows = form.fields
    .filter((field) => isFieldVisible(field, answer))
    .map((field) => ({ key: field.key, label: fieldLabel(field), value: formatAnswerValue(answer[field.key]) }))
  return (
    <div className="space-y-2">
      <p className="mh-body-sm font-medium">Review your answers</p>
      <dl className="space-y-1">
        {rows.map((row) => (
          <div key={row.key} className="flex gap-2 text-xs">
            <dt className="w-28 shrink-0 truncate text-ink-muted" title={row.label}>
              {row.label}
            </dt>
            <dd className="min-w-0 flex-1 break-words text-ink-soft">{row.value}</dd>
          </div>
        ))}
      </dl>
      {Object.keys(errors).length > 0 && (
        <p className="text-xs text-danger">Some answers need attention. Use the index above to fix them.</p>
      )}
    </div>
  )
}

function AnsweredCard({
  part,
  answered,
}: {
  part: ChatToolPart
  answered: { form: FormInfo; answer: FormAnswer } | null
}) {
  const rows = answered ? describeFormAnswer(answered.form, answered.answer) : []
  const title = answered?.form.title || "Question"
  return (
    <div className="mh-tool" data-testid="question-answered">
      <div className="mh-tool__header">
        <StatusDot status={part.state.status} />
        <span className="mh-chip mh-chip--outline">Question</span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink-soft">{title}</span>
        <span className="shrink-0 text-xs text-ink-muted">
          {part.state.status === "error" ? "Cancelled" : "Answered"}
        </span>
      </div>
      {rows.length > 0 ? (
        <dl className="flex flex-col gap-1 border-t border-hairline px-3 py-2">
          {rows.map((row) => (
            <div key={row.key} className="flex gap-2 text-xs">
              <dt className="w-32 shrink-0 truncate text-ink-muted" title={row.key}>
                {row.key}
              </dt>
              <dd className="min-w-0 flex-1 break-words text-ink-soft">{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : part.state.output ? (
        <p className="border-t border-hairline px-3 py-2 text-xs whitespace-pre-wrap text-ink-muted">
          {part.state.output}
        </p>
      ) : null}
    </div>
  )
}

function Field({
  field,
  value,
  error,
  onChange,
}: {
  field: FormField
  value: FormValue | undefined
  error?: string
  onChange: (value: FormValue) => void
}) {
  if (field.type === "boolean") {
    return (
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="mh-body-sm font-medium">{fieldLabel(field)}</p>
          {field.description && <p className="mt-0.5 text-xs text-ink-muted">{field.description}</p>}
        </div>
        <BooleanToggle checked={Boolean(value)} onChange={onChange} />
      </div>
    )
  }

  if (field.type === "external") {
    return (
      <div className="space-y-1">
        <p className="mh-body-sm font-medium">{fieldLabel(field)}</p>
        {field.description && <p className="text-xs text-ink-muted">{field.description}</p>}
        <a
          href={field.url}
          target="_blank"
          rel="noreferrer noopener"
          className="block truncate rounded-md border border-hairline bg-code px-2.5 py-1.5 font-mono text-xs text-code-text hover:border-accent-line"
        >
          {field.url}
          <ExternalLinkIcon size={12} className="ml-1 inline-block align-text-bottom" />
        </a>
      </div>
    )
  }

  return (
    <div className="space-y-1.5">
      <label className="block text-sm font-medium">
        {fieldLabel(field)}
        {"required" in field && field.required && <span className="ml-0.5 text-danger">*</span>}
      </label>
      {field.description && <p className="text-xs text-ink-muted">{field.description}</p>}
      <FieldInput field={field} value={value} onChange={onChange} />
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  )
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: Exclude<FormField, { type: "boolean" } | { type: "external" }>
  value: FormValue | undefined
  onChange: (value: FormValue) => void
}) {
  if (field.type === "multiselect") return <MultiInput field={field} value={value} onChange={onChange} />
  if (field.type === "number" || field.type === "integer") {
    return <NumberInput field={field} value={value} onChange={onChange} />
  }
  return <StringInput field={field} value={value} onChange={onChange} />
}

function StringInput({
  field,
  value,
  onChange,
}: {
  field: Extract<FormField, { type: "string" }>
  value: FormValue | undefined
  onChange: (value: FormValue) => void
}) {
  const [other, setOther] = useState(false)
  const text = typeof value === "string" ? value : ""
  const options = field.options ?? []

  if (options.length > 0) {
    return (
      <div role="radiogroup" className="mh-options">
        {options.map((option) => {
          const active = !other && text === option.value
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => {
                setOther(false)
                onChange(option.value)
              }}
              className={`mh-option ${active ? "is-selected" : ""}`}
            >
              <span className="mh-option__mark" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block break-words text-sm">{option.label}</span>
                {option.description && <span className="mt-0.5 block text-xs text-ink-muted">{option.description}</span>}
              </span>
            </button>
          )
        })}
        {field.custom && (
          <button
            type="button"
            role="radio"
            aria-checked={other}
            onClick={() => {
              setOther(true)
              onChange("")
            }}
            className={`mh-option ${other ? "is-selected" : ""}`}
          >
            <span className="mh-option__mark" aria-hidden="true" />
            <span className="text-sm">Other…</span>
          </button>
        )}
        {other && (
          <input
            autoFocus
            value={text}
            onChange={(event) => onChange(event.target.value)}
            placeholder="Type your answer"
            aria-label={fieldLabel(field)}
            className="mh-input"
          />
        )}
      </div>
    )
  }

  return (
    <input
      type={inputType(field.format)}
      value={text}
      onChange={(event) => onChange(event.target.value)}
      placeholder={field.placeholder}
      maxLength={field.maxLength}
      aria-label={fieldLabel(field)}
      className="mh-input"
    />
  )
}

function inputType(format: string | undefined): string {
  if (format === "email") return "email"
  if (format === "uri") return "url"
  if (format === "date") return "date"
  if (format === "date-time") return "datetime-local"
  return "text"
}

function NumberInput({
  field,
  value,
  onChange,
}: {
  field: Extract<FormField, { type: "number" | "integer" }>
  value: FormValue | undefined
  onChange: (value: FormValue) => void
}) {
  const minimum = typeof field.minimum === "number" ? field.minimum : undefined
  const maximum = typeof field.maximum === "number" ? field.maximum : undefined
  return (
    <input
      type="number"
      value={typeof value === "number" ? String(value) : ""}
      min={minimum}
      max={maximum}
      step={field.type === "integer" ? 1 : "any"}
      onChange={(event) => onChange(event.target.value === "" ? "" : Number(event.target.value))}
      aria-label={fieldLabel(field)}
      className="mh-input"
    />
  )
}

function MultiInput({
  field,
  value,
  onChange,
}: {
  field: Extract<FormField, { type: "multiselect" }>
  value: FormValue | undefined
  onChange: (value: FormValue) => void
}) {
  const selected = Array.isArray(value) ? value : []
  const [draft, setDraft] = useState("")
  const custom = selected.filter((item) => !field.options.some((option) => option.value === item))

  function toggle(option: string): void {
    onChange(selected.includes(option) ? selected.filter((item) => item !== option) : [...selected, option])
  }

  return (
    <div className="space-y-1.5">
      <div className="mh-options">
        {field.options.map((option) => {
          const active = selected.includes(option.value)
          return (
            <button
              key={option.value}
              type="button"
              role="checkbox"
              aria-checked={active}
              onClick={() => toggle(option.value)}
              className={`mh-option ${active ? "is-selected" : ""}`}
            >
              <span
                className={`mh-option__mark rounded-xs text-[10px] leading-none ${active ? "text-accent" : "text-transparent"}`}
                aria-hidden="true"
              >
                ✓
              </span>
              <span className="min-w-0 flex-1">
                <span className="block break-words text-sm">{option.label}</span>
                {option.description && <span className="mt-0.5 block text-xs text-ink-muted">{option.description}</span>}
              </span>
            </button>
          )
        })}
      </div>
      {custom.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {custom.map((item) => (
            <span key={item} className="mh-chip mh-chip--accent">
              {item}
              <button type="button" onClick={() => toggle(item)} className="text-accent hover:text-accent-strong">
                <XIcon size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      {field.custom && (
        <div className="flex gap-1.5">
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return
              event.preventDefault()
              if (draft.trim()) {
                toggle(draft.trim())
                setDraft("")
              }
            }}
            placeholder="Add your own"
            aria-label={`Add ${fieldLabel(field)}`}
            className="mh-input"
          />
          <button
            type="button"
            disabled={!draft.trim()}
            onClick={() => {
              toggle(draft.trim())
              setDraft("")
            }}
            className="mh-btn mh-btn--secondary shrink-0 px-3"
          >
            Add
          </button>
        </div>
      )}
    </div>
  )
}

function BooleanToggle({ checked, onChange }: { checked: boolean; onChange: (value: FormValue) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${checked ? "bg-accent" : "bg-hairline-strong"}`}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full transition-transform ${
          checked ? "translate-x-4.5 bg-on-accent" : "translate-x-0.5 bg-surface"
        }`}
      />
    </button>
  )
}
