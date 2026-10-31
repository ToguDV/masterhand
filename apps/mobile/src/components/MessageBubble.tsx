import { memo, useMemo, useState } from "react"
import { Image, Pressable, StyleSheet, Text, View } from "react-native"
import Markdown, {
  createMarkdownIt,
  type MarkdownStyleMap,
} from "@ronradtke/react-native-markdown-display"
import {
  formatFileSize,
  isQuestionTool,
  isTaskTool,
  splitGoalMarkers,
  subagentInfo,
  subagentOutput,
  toolTitle,
  type ChatAttachment,
  type ChatMessage,
  type ChatPart,
  type ChatReasoningPart,
  type ChatTextPart,
  type ChatToolPart,
  type FormAnswer,
  type FormInfo,
} from "@masterhand/client-core"
import { useTheme, useThemedStyles, type Fonts, type Palette, type ThemeName } from "../theme"
import { StatusDot } from "./tools/StatusDot"
import { ToolCard } from "./tools/ToolCard"
import { QuestionCard } from "./QuestionCard"
import { MessageStats } from "./MessageStats"
import { CritiqueCard, GoalReportCard, VerdictCard } from "./GoalReview"
import { FileIcon } from "./icons"

// The renderer merges these overrides over its own light/dark base (selected
// by `markdownColorScheme`), so every themed run carries the app ink: nothing
// falls back to a preset white-on-paper or pale-on-pale combination.
export function markdownColorScheme(theme: ThemeName): "light" | "dark" {
  return theme === "dark" ? "dark" : "light"
}

// Module-level identities for the markdown renderer props. The library treats
// any new object as "configuration changed": inlining these recreated the
// MarkdownIt parser and the whole AstRenderer (≈90 styles) on every streaming
// delta, which also defeated the memoization of every fenced code block.
const MARKDOWN_PARSER = createMarkdownIt()
const ALLOWED_IMAGE_HANDLERS = [
  "data:image/png;base64",
  "data:image/gif;base64",
  "data:image/jpeg;base64",
  "https://",
  "http://",
]
const TOP_LEVEL_MAX_EXCEEDED = <Text>...</Text>

export function createMarkdownStyles(colors: Palette, fonts: Fonts): MarkdownStyleMap {
  const text = { color: colors.text, fontFamily: fonts.ui, fontSize: 15, lineHeight: 22 }
  const heading = { color: colors.text, fontFamily: fonts.ui, fontWeight: "700" as const }
  const mutedHeading = { color: colors.textMuted, fontFamily: fonts.ui, fontWeight: "700" as const }
  return {
    body: text,
    text,
    textgroup: { color: colors.text },
    span: { color: colors.text },
    inline: { color: colors.text },
    paragraph: { marginTop: 4, marginBottom: 4 },
    strong: { color: colors.text, fontFamily: fonts.ui, fontWeight: "700" },
    em: { color: colors.text, fontFamily: fonts.ui, fontStyle: "italic" },
    s: { color: colors.textMuted, textDecorationLine: "line-through" },
    ins: { color: colors.text, textDecorationLine: "underline" },
    heading1: { ...heading, fontSize: 24, marginTop: 8, marginBottom: 4 },
    heading2: { ...heading, fontSize: 20, marginTop: 8, marginBottom: 4 },
    heading3: { ...heading, fontSize: 17, marginTop: 6, marginBottom: 2 },
    heading4: { ...heading, fontSize: 15, marginTop: 6, marginBottom: 2 },
    heading5: { ...mutedHeading, fontSize: 14, marginTop: 6, marginBottom: 2 },
    heading6: { ...mutedHeading, fontSize: 13, marginTop: 6, marginBottom: 2 },
    hr: { backgroundColor: colors.hairline, height: StyleSheet.hairlineWidth },
    blockquote: {
      backgroundColor: "transparent",
      borderColor: colors.hairline,
      borderLeftWidth: 2,
      marginLeft: 0,
      paddingHorizontal: 8,
    },
    link: { color: colors.accent },
    blocklink: { borderColor: colors.hairline },
    code_inline: {
      borderWidth: 0,
      backgroundColor: colors.surfaceMuted,
      color: colors.text,
      fontFamily: fonts.mono,
      fontSize: 13,
      padding: 0,
      paddingHorizontal: 4,
      borderRadius: 4,
    },
    code_block: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      backgroundColor: colors.codeSurface,
      color: colors.codeText,
      fontFamily: fonts.mono,
      fontSize: 13,
      lineHeight: 19,
      padding: 10,
      borderRadius: 12,
    },
    fence: { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline, borderRadius: 12 },
    fence_header: {
      backgroundColor: colors.codeSurface,
      borderBottomColor: colors.codeSurfaceSoft,
      borderBottomWidth: StyleSheet.hairlineWidth,
    },
    fence_language_label: { color: colors.codeMuted, fontFamily: fonts.mono, fontSize: 11 },
    fence_code: { backgroundColor: colors.codeSurface, padding: 10 },
    fence_token: { color: colors.codeText, fontFamily: fonts.mono, fontSize: 13, lineHeight: 19 },
    table: { borderColor: colors.hairline, borderRadius: 6 },
    tr: { borderColor: colors.hairline },
    th: { color: colors.text, fontWeight: "700", backgroundColor: colors.surface },
    td: { color: colors.text },
  }
}

const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
  const { colors, fonts, theme } = useTheme()
  const markdownStyles = useMemo(() => createMarkdownStyles(colors, fonts), [colors, fonts])
  if (!text.trim()) return null
  return (
    <Markdown
      colorScheme={markdownColorScheme(theme)}
      style={markdownStyles}
      markdownit={MARKDOWN_PARSER}
      allowedImageHandlers={ALLOWED_IMAGE_HANDLERS}
      topLevelMaxExceededItem={TOP_LEVEL_MAX_EXCEEDED}
    >
      {text}
    </Markdown>
  )
})

/**
 * Assistant text carrying the agents' custom marker protocol: prose renders as
 * markdown and every `<masterhand:goal|critique|verdict>` block becomes a card
 * (the raw JSON is never shown).
 */
function TextWithMarkers({ text }: { text: string }) {
  const segments = useMemo(() => splitGoalMarkers(text), [text])
  return (
    <>
      {segments.map((segment, index) => {
        if (segment.kind === "text") return <MarkdownText key={index} text={segment.text} />
        if (segment.kind === "report") return <GoalReportCard key={index} report={segment.report} />
        if (segment.kind === "critique") return <CritiqueCard key={index} critique={segment.critique} />
        return <VerdictCard key={index} verdict={segment.verdict} />
      })}
    </>
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
  const state = part.state
  const info = useMemo(() => subagentInfo(part), [part])
  // The regex scrub over the whole subagent output only matters when expanded.
  const output = useMemo(() => (open ? subagentOutput(part) : null), [open, part])

  return (
    <View style={styles.subagentCard}>
      <Pressable style={styles.toolHeader} onPress={() => setOpen((value) => !value)}>
        <StatusDot status={state.status} />
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

const PartView = memo(function PartView({
  part,
  onOpenSession,
  forms,
  answeredForms,
  busyFormID,
  onRespondForm,
  onCancelForm,
}: PartViewProps) {
  switch (part.type) {
    case "text":
      return <TextWithMarkers text={part.text} />
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
}, isSamePartViewProps)

/**
 * Part-level equality: the streaming reducers keep the identity of every part
 * they did not touch, so a delta only re-renders the part that grew instead of
 * re-running markdown/tool summaries for the whole message. Callback identities
 * are ignored for the same reason as the row comparator.
 */
function isSamePartViewProps(prev: PartViewProps, next: PartViewProps): boolean {
  return (
    prev.part === next.part &&
    prev.forms === next.forms &&
    prev.answeredForms === next.answeredForms &&
    prev.busyFormID === next.busyFormID &&
    // Presence (not identity) changes the rendered branch: the question card
    // only renders with both form callbacks, and the subagent link only with
    // an `onOpenSession`.
    Boolean(prev.onOpenSession) === Boolean(next.onOpenSession) &&
    Boolean(prev.onRespondForm) === Boolean(next.onRespondForm) &&
    Boolean(prev.onCancelForm) === Boolean(next.onCancelForm)
  )
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
  return (
    <MessageBubbleView
      entry={entry}
      onOpenSession={onOpenSession}
      forms={forms}
      answeredForms={answeredForms}
      busyFormID={busyFormID}
      onRespondForm={onRespondForm}
      onCancelForm={onCancelForm}
    />
  )
}

/**
 * Memoized row for the chat `FlatList`. A history refetch/SSE event rebuilds
 * every `ChatMessage` object, so a default shallow `memo` would never bail
 * out and each render would re-decode every inline image (`previewDataUrl`
 * can be megabytes of base64). The custom comparator only re-renders when
 * visible content actually changed.
 */
interface MessageBubbleProps {
  entry: ChatMessage
  onOpenSession?: (id: string) => void
  forms?: FormInfo[]
  answeredForms?: Array<{ form: FormInfo; answer: FormAnswer }>
  busyFormID?: string | null
  onRespondForm?: (form: FormInfo, answer: FormAnswer) => void
  onCancelForm?: (form: FormInfo) => void
}

const MessageBubbleView = memo(
  function MessageBubbleView({
    entry,
    onOpenSession,
    forms = [],
    answeredForms = [],
    busyFormID = null,
    onRespondForm,
    onCancelForm,
  }: MessageBubbleProps) {
  const styles = useThemedStyles(createStyles)
  const info = entry.info

  if (info.role === "user") {
    const text = entry.parts
      .filter((part): part is ChatTextPart => part.type === "text")
      .map((part) => part.text)
      .join("\n")
    const attachments = info.attachments ?? []
    if (!text.trim() && attachments.length === 0) return null
    return (
      <View style={styles.userRow}>
        <View style={styles.userBubble} testID="user-bubble">
          {text.trim() ? <Text style={styles.bodyText}>{text}</Text> : null}
          {attachments.length > 0 ? <UserAttachments attachments={attachments} /> : null}
        </View>
      </View>
    )
  }

  const visible = entry.parts
  const streaming = info.time.completed === undefined
  const errorMessage = info.error ? info.error.message || "Agent error" : null

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
      {info.time.completed !== undefined ? <MessageStats info={info} /> : null}
    </View>
  )
  },
  isSameMessageBubbleProps,
)

/**
 * Row equality for the memoized chat row. Callback identities are
 * deliberately ignored: every parent render recreates them, and a behavior
 * change in any of them always coincides with a data change that IS compared
 * (a new session brings new entries, answering a form replaces `forms` /
 * `answeredForms` / `busyFormID`). Comparing them by identity would re-render
 * every row on every SSE event and defeat the memo entirely.
 */
export function isSameMessageBubbleProps(prev: MessageBubbleProps, next: MessageBubbleProps): boolean {
  return (
    isSameChatEntry(prev.entry, next.entry) &&
    prev.forms === next.forms &&
    prev.answeredForms === next.answeredForms &&
    prev.busyFormID === next.busyFormID
  )
}

/**
 * Structural equality for a chat row. New object identities from a refetch or
 * SSE merge must not remount the row (each remount re-decodes every inline
 * image). Returns false on any visible change — a stale false is a bug,
 * while a stale true is only a wasted render.
 */
export function isSameChatEntry(a: ChatMessage, b: ChatMessage): boolean {
  if (a === b) return true
  const infoA = a.info
  const infoB = b.info
  if (infoA.id !== infoB.id) return false
  if (infoA.role !== infoB.role) return false
  if (infoA.time.created !== infoB.time.created) return false
  if (infoA.time.completed !== infoB.time.completed) return false
  if ((infoA.time.streamed ?? null) !== (infoB.time.streamed ?? null)) return false
  if ((infoA.agent ?? null) !== (infoB.agent ?? null)) return false
  if ((infoA.providerID ?? null) !== (infoB.providerID ?? null)) return false
  if ((infoA.modelID ?? null) !== (infoB.modelID ?? null)) return false
  if ((infoA.cost ?? null) !== (infoB.cost ?? null)) return false
  if ((infoA.error?.message ?? null) !== (infoB.error?.message ?? null)) return false
  if (!isSameTokens(infoA.tokens, infoB.tokens)) return false
  if (!isSameAttachments(infoA.attachments, infoB.attachments)) return false
  if (a.parts.length !== b.parts.length) return false
  for (let index = 0; index < a.parts.length; index += 1) {
    if (!isSameChatPart(a.parts[index]!, b.parts[index]!)) return false
  }
  return true
}

function isSameTokens(
  a: ChatMessage["info"]["tokens"],
  b: ChatMessage["info"]["tokens"],
): boolean {
  if (a === b) return true
  if (!a || !b) return a === b
  if (a.input !== b.input || a.output !== b.output) return false
  if ((a.cache?.read ?? null) !== (b.cache?.read ?? null)) return false
  if ((a.cache?.write ?? null) !== (b.cache?.write ?? null)) return false
  return true
}

function isSameAttachments(
  a: readonly ChatAttachment[] | undefined,
  b: readonly ChatAttachment[] | undefined,
): boolean {
  if (a === b) return true
  if (!a || !b) return a === b
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index]!
    const right = b[index]!
    if (left.id !== right.id) return false
    if (left.name !== right.name) return false
    if (left.mime !== right.mime) return false
    if (left.size !== right.size) return false
    if (left.url !== right.url) return false
    if (left.inline !== right.inline) return false
    // The preview bytes are immutable per attachment id; compare the length
    // instead of the megabytes of base64 so the comparator itself stays cheap.
    if ((left.previewDataUrl?.length ?? -1) !== (right.previewDataUrl?.length ?? -1)) return false
  }
  return true
}

function isSameChatPart(a: ChatPart, b: ChatPart): boolean {
  if (a === b) return true
  if (a.id !== b.id || a.type !== b.type) return false
  if (a.type === "text" || a.type === "reasoning") {
    return b.type === a.type && a.text === (b as { text: string }).text
  }
  if (a.type === "tool" && b.type === "tool") {
    const stateA = (a as ChatToolPart).state
    const stateB = (b as ChatToolPart).state
    return (
      (a as ChatToolPart).tool === (b as ChatToolPart).tool &&
      (a as ChatToolPart).callID === (b as ChatToolPart).callID &&
      stateA.status === stateB.status &&
      (stateA.title ?? null) === (stateB.title ?? null) &&
      (stateA.output ?? null) === (stateB.output ?? null) &&
      (stateA.error ?? null) === (stateB.error ?? null) &&
      (stateA.raw ?? null) === (stateB.raw ?? null) &&
      JSON.stringify(stateA.input) === JSON.stringify(stateB.input) &&
      JSON.stringify(stateA.metadata ?? null) === JSON.stringify(stateB.metadata ?? null) &&
      (stateA.timing?.completed ?? null) === (stateB.timing?.completed ?? null)
    )
  }
  // Unknown part kinds render nothing; same id + kind means same (empty) output.
  return a.type === b.type
}

/** Attachment chips inside the user's bubble (images keep their inline preview). */
const UserAttachments = memo(function UserAttachments({
  attachments,
}: {
  attachments: readonly ChatAttachment[]
}) {
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()
  return (
    <View style={styles.userAttachments} testID="user-attachments">
      {attachments.map((attachment) => (
        <View key={attachment.id} style={styles.userAttachment}>
          {attachment.previewDataUrl ? (
            <Image
              source={{ uri: attachment.previewDataUrl }}
              style={styles.userAttachmentThumb}
              resizeMode="cover"
              resizeMethod="resize"
              fadeDuration={0}
            />
          ) : (
            <View style={styles.userAttachmentGlyph}>
              <FileIcon size={16} color={colors.bubbleUserText} />
            </View>
          )}
          <View style={styles.userAttachmentText}>
            <Text style={styles.userAttachmentName} numberOfLines={1}>
              {attachment.name}
            </Text>
            <Text style={styles.userAttachmentMeta} numberOfLines={1}>
              {attachment.size > 0 ? formatFileSize(attachment.size) : attachment.mime}
            </Text>
          </View>
        </View>
      ))}
    </View>
  )
})

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
    userAttachments: {
      gap: 6,
      marginTop: 6,
    },
    userAttachment: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      borderRadius: 8,
      padding: 4,
      backgroundColor: "rgba(255, 255, 255, 0.12)",
    },
    userAttachmentThumb: {
      width: 48,
      height: 48,
      borderRadius: 6,
    },
    userAttachmentGlyph: {
      width: 36,
      height: 36,
      borderRadius: 6,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: "rgba(255, 255, 255, 0.12)",
    },
    userAttachmentText: {
      flexShrink: 1,
      minWidth: 0,
      maxWidth: 200,
    },
    userAttachmentName: {
      color: colors.bubbleUserText,
      fontFamily: fonts.ui,
      fontSize: 12,
      fontWeight: "500",
    },
    userAttachmentMeta: {
      color: colors.bubbleUserText,
      opacity: 0.75,
      fontFamily: fonts.ui,
      fontSize: 11,
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
