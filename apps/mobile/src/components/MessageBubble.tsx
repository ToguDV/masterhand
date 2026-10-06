import { useMemo, useState } from "react"
import { Pressable, StyleSheet, Text, View } from "react-native"
import Markdown, { darkStyles, type MarkdownStyleMap } from "@ronradtke/react-native-markdown-display"
import {
  formatSpeed,
  formatTokens,
  isQuestionTool,
  isTaskTool,
  subagentInfo,
  subagentOutput,
  tokenCounts,
  tokenSpeed,
  toolTitle,
  type ChatMessage,
  type ChatPart,
  type ChatReasoningPart,
  type ChatTextPart,
  type ChatToolPart,
  type FormAnswer,
  type FormInfo,
} from "@masterhand/client-core"
import { useTheme, useThemedStyles, type Fonts, type Palette } from "../theme"
import { statusColor } from "./tools/theme"
import { ToolCard } from "./tools/ToolCard"
import { QuestionCard } from "./QuestionCard"

// Assistant output is markdown: render it as such. The library ships a complete
// dark preset; only the palette is overridden to match the app theme.
function createMarkdownStyles(colors: Palette, fonts: Fonts): MarkdownStyleMap {
  return {
    ...darkStyles,
    body: { color: colors.text, fontFamily: fonts.ui, fontSize: 15, lineHeight: 22 },
    paragraph: { ...darkStyles.paragraph, marginTop: 4, marginBottom: 4 },
    heading1: { ...darkStyles.heading1, color: colors.text, fontWeight: "700", marginTop: 8, marginBottom: 4 },
    heading2: { ...darkStyles.heading2, color: colors.text, fontWeight: "700", marginTop: 8, marginBottom: 4 },
    heading3: { ...darkStyles.heading3, color: colors.text, fontWeight: "700", marginTop: 6, marginBottom: 2 },
    heading4: { ...darkStyles.heading4, color: colors.text, fontWeight: "700", marginTop: 6, marginBottom: 2 },
    heading5: { ...darkStyles.heading5, color: colors.textMuted, fontWeight: "700", marginTop: 6, marginBottom: 2 },
    heading6: { ...darkStyles.heading6, color: colors.textMuted, fontWeight: "700", marginTop: 6, marginBottom: 2 },
    hr: { backgroundColor: colors.hairline, height: StyleSheet.hairlineWidth },
    blockquote: {
      ...darkStyles.blockquote,
      backgroundColor: "transparent",
      borderColor: colors.hairline,
      borderLeftWidth: 2,
      marginLeft: 0,
      paddingHorizontal: 8,
    },
    link: { ...darkStyles.link, color: colors.accent },
    blocklink: { ...darkStyles.blocklink, borderColor: colors.hairline },
    code_inline: {
      ...darkStyles.code_inline,
      borderWidth: 0,
      backgroundColor: colors.surfaceMuted,
      color: colors.codeText,
      fontFamily: fonts.mono,
      padding: 0,
      paddingHorizontal: 4,
      borderRadius: 4,
    },
    code_block: {
      ...darkStyles.code_block,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      backgroundColor: colors.codeSurface,
      color: colors.codeText,
      fontFamily: fonts.mono,
      padding: 10,
      borderRadius: 12,
    },
    fence: { ...darkStyles.fence, borderColor: colors.hairline, borderRadius: 12 },
    fence_header: { ...darkStyles.fence_header, backgroundColor: colors.codeSurface, borderBottomColor: colors.codeSurfaceSoft },
    fence_language_label: { ...darkStyles.fence_language_label, color: colors.codeMuted },
    fence_code: { ...darkStyles.fence_code, backgroundColor: colors.codeSurface },
    table: { ...darkStyles.table, borderColor: colors.hairline, borderRadius: 6 },
    tr: { ...darkStyles.tr, borderColor: colors.hairline },
    th: { ...darkStyles.th, color: colors.text, fontWeight: "700", backgroundColor: colors.surface },
    td: { ...darkStyles.td, color: colors.text },
  }
}

function MarkdownText({ text }: { text: string }) {
  const { colors, fonts } = useTheme()
  const markdownStyles = useMemo(() => createMarkdownStyles(colors, fonts), [colors, fonts])
  if (!text.trim()) return null
  return (
    <Markdown colorScheme="dark" style={markdownStyles}>
      {text}
    </Markdown>
  )
}

function Reasoning({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const styles = useThemedStyles(createStyles)
  return (
    <View>
      <Pressable onPress={() => setOpen((value) => !value)}>
        <Text style={styles.caption}>{open ? "▾ Reasoning" : "▸ Reasoning"}</Text>
      </Pressable>
      {open && <Text style={styles.reasoningText}>{text}</Text>}
    </View>
  )
}

function Subagent({ part, onOpenSession }: { part: ChatToolPart; onOpenSession?: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()
  const state = part.state
  const info = subagentInfo(part)
  const output = subagentOutput(part)

  return (
    <View style={styles.subagentCard}>
      <Pressable style={styles.toolHeader} onPress={() => setOpen((value) => !value)}>
        <View style={[styles.dot, { backgroundColor: statusColor(state.status, colors) }]} />
        <Text style={styles.subagentBadge}>SUBAGENT</Text>
        <Text style={styles.subagentName} numberOfLines={1}>
          {info.name}
        </Text>
        <Text style={styles.toolTitle} numberOfLines={1}>
          {info.description}
        </Text>
        <Text style={styles.caption}>{state.status}</Text>
      </Pressable>
      {open && (
        <View style={styles.toolBody}>
          {info.prompt ? <Text style={styles.codeText}>{info.prompt}</Text> : null}
          {output ? (
            <Text style={[styles.codeText, styles.toolOutput]} numberOfLines={40}>
              {output}
            </Text>
          ) : null}
          {state.status === "error" ? <Text style={styles.errorText}>{state.error}</Text> : null}
        </View>
      )}
      {info.sessionID && onOpenSession ? (
        <Pressable style={styles.subagentOpen} onPress={() => onOpenSession(info.sessionID!)}>
          <Text style={styles.subagentOpenText}>Open session →</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

interface PartViewProps {
  part: ChatPart
  onOpenSession?: (id: string) => void
  forms: FormInfo[]
  answeredForms: Array<{ form: FormInfo; answer: FormAnswer }>
  busyFormID: string | null
  onRespondForm?: (form: FormInfo, answer: FormAnswer) => void
  onCancelForm?: (form: FormInfo) => void
}

function PartView({ part, onOpenSession, forms, answeredForms, busyFormID, onRespondForm, onCancelForm }: PartViewProps) {
  switch (part.type) {
    case "text":
      return <MarkdownText text={part.text} />
    case "reasoning":
      return <Reasoning text={part.text} />
    case "tool":
      if (isTaskTool(part)) return <Subagent part={part} onOpenSession={onOpenSession} />
      if (isQuestionTool(part) && onRespondForm && onCancelForm) {
        return (
          <QuestionCard
            part={part}
            forms={forms}
            answeredForms={answeredForms}
            busyFormID={busyFormID}
            onRespond={onRespondForm}
            onCancel={onCancelForm}
          />
        )
      }
      return <ToolCard part={part} />
    default:
      return null
  }
}

export function MessageBubble({
  entry,
  onOpenSession,
  forms = [],
  answeredForms = [],
  busyFormID = null,
  onRespondForm,
  onCancelForm,
}: {
  entry: ChatMessage
  onOpenSession?: (id: string) => void
  forms?: FormInfo[]
  answeredForms?: Array<{ form: FormInfo; answer: FormAnswer }>
  busyFormID?: string | null
  onRespondForm?: (form: FormInfo, answer: FormAnswer) => void
  onCancelForm?: (form: FormInfo) => void
}) {
  const styles = useThemedStyles(createStyles)
  const info = entry.info

  if (info.role === "user") {
    const text = entry.parts
      .filter((part): part is ChatTextPart => part.type === "text")
      .map((part) => part.text)
      .join("\n")
    if (!text.trim()) return null
    return (
      <View style={styles.userRow}>
        <View style={styles.userBubble} testID="user-bubble">
          <Text style={styles.bodyText}>{text}</Text>
        </View>
      </View>
    )
  }

  const visible = entry.parts
  const streaming = info.time.completed === undefined
  const errorMessage = info.error ? info.error.message || "Agent error" : null
  const counts = tokenCounts(info.tokens)
  const breakdown = formatTokens(counts)
  const speed = formatSpeed(tokenSpeed(counts, (info.time.completed ?? 0) - info.time.created))

  return (
    <View style={styles.assistantBlock}>
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
        />
      ))}
      {streaming && visible.length === 0 ? <Text style={styles.caption}>Thinking…</Text> : null}
      {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}
      {info.time.completed !== undefined ? (
        <Text style={styles.caption}>
          {info.modelID}
          {(info.cost ?? 0) > 0 ? ` · $${(info.cost ?? 0).toFixed(4)}` : ""}
          {breakdown ? ` · ${breakdown}` : ""}
          {speed ? ` · ${speed}` : ""}
        </Text>
      ) : null}
    </View>
  )
}

function createStyles(colors: Palette, fonts: Fonts) {
  return StyleSheet.create({
    bodyText: {
      color: colors.bubbleUserText,
      fontFamily: fonts.ui,
      fontSize: 15,
      lineHeight: 22,
    },
    userRow: {
      alignItems: "flex-end",
    },
    userBubble: {
      maxWidth: "85%",
      backgroundColor: colors.bubbleUser,
      borderRadius: 16,
      borderBottomRightRadius: 4,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    assistantBlock: {
      gap: 8,
    },
    caption: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 12,
    },
    reasoningText: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 13,
      lineHeight: 19,
      marginTop: 4,
    },
    codeText: {
      color: colors.codeText,
      fontFamily: fonts.mono,
      fontSize: 12,
      lineHeight: 18,
    },
    toolHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 10,
      paddingVertical: 8,
    },
    dot: {
      width: 6,
      height: 6,
      borderRadius: 3,
    },
    toolTitle: {
      flex: 1,
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 13,
    },
    toolBody: {
      gap: 8,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.hairline,
      padding: 10,
    },
    toolOutput: {
      maxHeight: 240,
    },
    subagentCard: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      borderRadius: 16,
      backgroundColor: colors.surface,
      overflow: "hidden",
    },
    subagentBadge: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 10,
      fontWeight: "700",
      letterSpacing: 0.5,
    },
    subagentName: {
      color: colors.accent,
      fontFamily: fonts.mono,
      fontSize: 12,
    },
    subagentOpen: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.hairline,
      paddingHorizontal: 10,
      paddingVertical: 8,
    },
    subagentOpenText: {
      color: colors.accent,
      fontFamily: fonts.ui,
      fontSize: 12,
      fontWeight: "600",
    },
    errorText: {
      color: colors.danger,
      fontFamily: fonts.ui,
      fontSize: 13,
    },
  })
}
