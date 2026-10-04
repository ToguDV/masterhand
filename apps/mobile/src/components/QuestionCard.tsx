import { useState } from "react"
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native"
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
import { colors } from "../theme"
import { statusColor } from "./tools/theme"

/**
 * Inline card for the agent's `question` tool (React Native mirror of the web
 * `QuestionCard`). Pending forms show one question at a time behind a top
 * index (plus a final Submit step); settled forms collapse into a read-only
 * summary.
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
    return <QuestionForm key={form.id} form={form} busy={busyFormID === form.id} onRespond={onRespond} onCancel={onCancel} />
  }

  const answered = answeredForms.find((entry) => formToolCallID(entry.form) === part.callID)
  return <AnsweredCard part={part} answered={answered ?? null} />
}

function QuestionForm({
  form,
  busy,
  onRespond,
  onCancel,
}: {
  form: FormInfo
  busy: boolean
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
    <View style={styles.card} testID="question-card">
      <View style={styles.header}>
        <View style={styles.pulseDot} />
        <Text style={styles.badge}>QUESTION</Text>
        <Text style={styles.cardTitle} numberOfLines={1}>
          {form.title || "The agent needs input"}
        </Text>
      </View>

      {multi ? (
        <QuestionIndex
          fields={fields}
          active={currentKey}
          errors={submitted ? errors : {}}
          onSelect={setActive}
        />
      ) : null}

      <View style={styles.formBody}>
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

        <Text style={styles.waitingHint}>The agent is waiting for this answer.</Text>
        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            onPress={() => onCancel(form)}
            disabled={busy}
            style={styles.dismiss}
          >
            <Text style={styles.dismissText}>Dismiss</Text>
          </Pressable>
          {multi && current ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => setActive(step >= 0 && step < fields.length - 1 ? fields[step + 1]!.key : null)}
              disabled={busy}
              style={[styles.nextButton, busy && styles.disabled]}
            >
              <Text style={styles.nextText}>Next</Text>
            </Pressable>
          ) : (
            <Pressable
              accessibilityRole="button"
              onPress={submit}
              disabled={busy}
              style={[styles.answerButton, busy && styles.disabled]}
            >
              <Text style={styles.answerText}>{busy ? "Sending…" : "Submit"}</Text>
            </Pressable>
          )}
        </View>
      </View>
    </View>
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
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      accessibilityRole="tablist"
      contentContainerStyle={styles.index}
    >
      {fields.map((field) => {
        const selected = active === field.key
        return (
          <Pressable
            key={field.key}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => onSelect(field.key)}
            style={styles.tab}
          >
            <Text style={[styles.tabText, selected && styles.tabTextActive]}>
              {errors[field.key] ? "● " : ""}
              {fieldLabel(field)}
            </Text>
            <View style={[styles.tabUnderline, selected && styles.tabUnderlineActive]} />
          </Pressable>
        )
      })}
      <Pressable
        accessibilityRole="tab"
        accessibilityState={{ selected: active === null }}
        onPress={() => onSelect(null)}
        style={styles.tab}
      >
        <Text style={[styles.tabText, active === null && styles.tabTextActive]}>Submit</Text>
        <View style={[styles.tabUnderline, active === null && styles.tabUnderlineActive]} />
      </Pressable>
    </ScrollView>
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
    <View style={styles.review}>
      <Text style={styles.reviewTitle}>Review your answers</Text>
      {rows.map((row) => (
        <View key={row.key} style={styles.answerRow}>
          <Text style={styles.answerKey} numberOfLines={1}>
            {row.label}
          </Text>
          <Text style={styles.answerValue}>{row.value}</Text>
        </View>
      ))}
      {Object.keys(errors).length > 0 ? (
        <Text style={styles.error}>Some answers need attention. Use the index above to fix them.</Text>
      ) : null}
    </View>
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
    <View style={styles.answeredCard} testID="question-answered">
      <View style={styles.header}>
        <View style={[styles.dot, { backgroundColor: statusColor(part.state.status) }]} />
        <Text style={styles.badgeMuted}>QUESTION</Text>
        <Text style={styles.cardTitle} numberOfLines={1}>
          {title}
        </Text>
        <Text style={styles.answeredStatus}>{part.state.status === "error" ? "Cancelled" : "Answered"}</Text>
      </View>
      {rows.length > 0 ? (
        <View style={styles.answerRows}>
          {rows.map((row) => (
            <View key={row.key} style={styles.answerRow}>
              <Text style={styles.answerKey} numberOfLines={1}>
                {row.key}
              </Text>
              <Text style={styles.answerValue}>{row.value}</Text>
            </View>
          ))}
        </View>
      ) : part.state.output ? (
        <Text style={styles.answerOutput}>{part.state.output}</Text>
      ) : null}
    </View>
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
      <View style={styles.fieldRow}>
        <View style={styles.fieldRowText}>
          <Text style={styles.label}>{fieldLabel(field)}</Text>
          {field.description ? <Text style={styles.description}>{field.description}</Text> : null}
        </View>
        <Switch
          value={Boolean(value)}
          onValueChange={(next) => onChange(next)}
          trackColor={{ true: colors.accent, false: colors.surfaceMuted }}
          thumbColor="#fafafa"
        />
      </View>
    )
  }

  if (field.type === "external") {
    return (
      <View style={styles.field}>
        <Text style={styles.label}>{fieldLabel(field)}</Text>
        {field.description ? <Text style={styles.description}>{field.description}</Text> : null}
        <Text selectable style={styles.externalUrl}>
          {field.url}
        </Text>
      </View>
    )
  }

  return (
    <View style={styles.field}>
      <Text style={styles.label}>
        {fieldLabel(field)}
        {"required" in field && field.required ? <Text style={styles.required}> *</Text> : null}
      </Text>
      {field.description ? <Text style={styles.description}>{field.description}</Text> : null}
      <FieldInput field={field} value={value} onChange={onChange} />
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
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
    return (
      <TextInput
        value={typeof value === "number" ? String(value) : ""}
        onChangeText={(text) => onChange(text === "" ? "" : Number(text))}
        keyboardType="numeric"
        placeholderTextColor="#52525b"
        accessibilityLabel={fieldLabel(field)}
        style={styles.input}
      />
    )
  }

  return <StringInput field={field} value={value} onChange={onChange} />
}

function optionStyle(active: boolean): StyleProp<ViewStyle> {
  return [styles.option, active ? styles.optionActive : null]
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
      <View style={styles.options}>
        {options.map((option) => {
          const active = !other && text === option.value
          return (
            <Pressable
              key={option.value}
              accessibilityRole="radio"
              accessibilityState={{ checked: active }}
              onPress={() => {
                setOther(false)
                onChange(option.value)
              }}
              style={optionStyle(active)}
            >
              <View style={[styles.radio, active && styles.radioActive]}>
                {active ? <View style={styles.radioDot} /> : null}
              </View>
              <View style={styles.optionText}>
                <Text style={styles.optionLabel}>{option.label}</Text>
                {option.description ? <Text style={styles.optionDescription}>{option.description}</Text> : null}
              </View>
            </Pressable>
          )
        })}
        {field.custom ? (
          <Pressable
            accessibilityRole="radio"
            accessibilityState={{ checked: other }}
            onPress={() => {
              setOther(true)
              onChange("")
            }}
            style={optionStyle(other)}
          >
            <View style={[styles.radio, other && styles.radioActive]}>
              {other ? <View style={styles.radioDot} /> : null}
            </View>
            <Text style={styles.optionLabel}>Other…</Text>
          </Pressable>
        ) : null}
        {other ? (
          <TextInput
            value={text}
            onChangeText={(next) => onChange(next)}
            placeholder="Type your answer"
            placeholderTextColor="#52525b"
            accessibilityLabel={fieldLabel(field)}
            autoFocus
            style={styles.input}
          />
        ) : null}
      </View>
    )
  }

  return (
    <TextInput
      value={text}
      onChangeText={(next) => onChange(next)}
      placeholder={field.placeholder}
      placeholderTextColor="#52525b"
      keyboardType={field.format === "email" ? "email-address" : "default"}
      autoCapitalize={field.format === "email" || field.format === "uri" ? "none" : "sentences"}
      accessibilityLabel={fieldLabel(field)}
      style={styles.input}
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
    <View style={styles.options}>
      {field.options.map((option) => {
        const active = selected.includes(option.value)
        return (
          <Pressable
            key={option.value}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: active }}
            onPress={() => toggle(option.value)}
            style={optionStyle(active)}
          >
            <View style={[styles.checkbox, active && styles.checkboxActive]}>
              {active ? <Text style={styles.checkboxMark}>✓</Text> : null}
            </View>
            <View style={styles.optionText}>
              <Text style={styles.optionLabel}>{option.label}</Text>
              {option.description ? <Text style={styles.optionDescription}>{option.description}</Text> : null}
            </View>
          </Pressable>
        )
      })}
      {custom.length > 0 ? (
        <View style={styles.chips}>
          {custom.map((item) => (
            <Pressable key={item} onPress={() => toggle(item)} style={styles.chip}>
              <Text style={styles.chipText}>{item} ×</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {field.custom ? (
        <View style={styles.customRow}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder="Add your own"
            placeholderTextColor="#52525b"
            accessibilityLabel={`Add ${fieldLabel(field)}`}
            style={[styles.input, styles.customInput]}
            onSubmitEditing={() => {
              if (!draft.trim()) return
              toggle(draft.trim())
              setDraft("")
            }}
          />
          <Pressable
            disabled={!draft.trim()}
            onPress={() => {
              toggle(draft.trim())
              setDraft("")
            }}
            style={styles.addButton}
          >
            <Text style={styles.addButtonText}>Add</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(99, 102, 241, 0.5)",
    borderRadius: 10,
    backgroundColor: "rgba(99, 102, 241, 0.08)",
    overflow: "hidden",
  },
  answeredCard: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 10,
    backgroundColor: "rgba(24, 24, 27, 0.6)",
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(99, 102, 241, 0.2)",
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  pulseDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.accent,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  badge: {
    color: "#a5b4fc",
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  badgeMuted: {
    color: "rgba(165, 180, 252, 0.75)",
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  cardTitle: {
    flex: 1,
    color: "#fafafa",
    fontSize: 13,
    fontWeight: "600",
  },
  answeredStatus: {
    color: colors.muted,
    fontSize: 11,
  },
  formBody: {
    gap: 14,
    padding: 10,
  },
  index: {
    alignItems: "stretch",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(99, 102, 241, 0.2)",
    paddingHorizontal: 8,
  },
  tab: {
    paddingHorizontal: 8,
    paddingTop: 8,
  },
  tabText: {
    color: colors.muted,
    fontSize: 12,
  },
  tabTextActive: {
    color: "#fafafa",
    fontWeight: "600",
  },
  tabUnderline: {
    height: 2,
    marginTop: 6,
    borderRadius: 1,
    backgroundColor: "transparent",
  },
  tabUnderlineActive: {
    backgroundColor: "#818cf8",
  },
  nextButton: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#3f3f46",
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  nextText: {
    color: "#e4e4e7",
    fontSize: 12,
    fontWeight: "700",
  },
  review: {
    gap: 8,
  },
  reviewTitle: {
    color: "#e4e4e7",
    fontSize: 13,
    fontWeight: "600",
  },
  waitingHint: {
    color: "rgba(165, 180, 252, 0.6)",
    fontSize: 10,
  },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: 8,
  },
  dismiss: {
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  dismissText: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: "500",
  },
  answerButton: {
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  answerText: {
    color: "#ffffff",
    fontSize: 12,
    fontWeight: "700",
  },
  disabled: {
    opacity: 0.5,
  },
  answerRows: {
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  answerRow: {
    flexDirection: "row",
    gap: 8,
  },
  answerKey: {
    width: 110,
    color: colors.muted,
    fontSize: 11,
  },
  answerValue: {
    flex: 1,
    color: "#d4d4d8",
    fontSize: 11,
  },
  answerOutput: {
    color: "#a1a1aa",
    fontSize: 11,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  field: {
    gap: 6,
  },
  fieldRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  fieldRowText: {
    flex: 1,
    minWidth: 0,
  },
  label: {
    color: "#e4e4e7",
    fontSize: 13,
    fontWeight: "600",
  },
  required: {
    color: colors.danger,
  },
  description: {
    color: colors.muted,
    fontSize: 11,
    marginTop: 1,
  },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#3f3f46",
    borderRadius: 8,
    backgroundColor: "rgba(9, 9, 11, 0.7)",
    color: "#f4f4f5",
    fontSize: 13,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  options: {
    gap: 6,
  },
  option: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 8,
    backgroundColor: "rgba(24, 24, 27, 0.4)",
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  optionActive: {
    borderColor: "rgba(99, 102, 241, 0.55)",
    backgroundColor: "rgba(99, 102, 241, 0.12)",
  },
  optionText: {
    flex: 1,
    minWidth: 0,
  },
  optionLabel: {
    color: "#e4e4e7",
    fontSize: 13,
  },
  optionDescription: {
    color: colors.muted,
    fontSize: 11,
    marginTop: 1,
  },
  radio: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#52525b",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 1,
  },
  radioActive: {
    borderColor: "#818cf8",
  },
  radioDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#818cf8",
  },
  checkbox: {
    width: 16,
    height: 16,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: "#52525b",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 1,
  },
  checkboxActive: {
    borderColor: "#818cf8",
    backgroundColor: "rgba(99, 102, 241, 0.25)",
  },
  checkboxMark: {
    color: "#c7d2fe",
    fontSize: 10,
    lineHeight: 13,
  },
  chips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  chip: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(99, 102, 241, 0.4)",
    backgroundColor: "rgba(99, 102, 241, 0.12)",
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  chipText: {
    color: "#c7d2fe",
    fontSize: 11,
  },
  customRow: {
    flexDirection: "row",
    gap: 6,
  },
  customInput: {
    flex: 1,
  },
  addButton: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#3f3f46",
    borderRadius: 8,
    paddingHorizontal: 10,
    justifyContent: "center",
  },
  addButtonText: {
    color: "#d4d4d8",
    fontSize: 12,
  },
  externalUrl: {
    color: "#67e8f9",
    fontFamily: "monospace",
    fontSize: 11,
  },
  error: {
    color: colors.danger,
    fontSize: 11,
  },
})
