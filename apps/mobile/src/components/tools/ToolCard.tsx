import { useEffect, useState } from "react"
import { Pressable, StyleSheet, Text, View } from "react-native"
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
import { useTheme, useThemedStyles, type Fonts, type Palette } from "../../theme"
import { statusColor, toolAccent, toolGlyphs } from "./theme"
import { CodeBlock, DiffView, KeyValueList, SearchBody, TerminalBody, TodoBody } from "./ToolBodies"

/** Live duration for running tools; freezes with the final mark. */
function useLiveDuration(status: ChatToolStatus, timing?: ChatToolTiming): number | null {
  const running = status === "running" && timing?.created !== undefined && timing.completed === undefined
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setTick((value) => value + 1), 1000)
    return () => clearInterval(timer)
  }, [running])
  if (timing?.created === undefined) return null
  const end = timing.completed ?? (running ? Date.now() : undefined)
  return end === undefined ? null : Math.max(0, end - timing.created)
}

function HeaderStats({ summary, duration }: { summary: ToolSummary; duration: number | null }) {
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()
  return (
    <View style={styles.stats}>
      {summary.kind === "shell" && summary.exitCode !== null ? (
        <Text style={[styles.statText, { color: summary.exitCode === 0 ? colors.success : colors.danger }]}>
          exit {summary.exitCode}
        </Text>
      ) : null}
      {summary.kind === "edit" && (summary.additions > 0 || summary.deletions > 0) ? (
        <Text style={styles.statText}>
          <Text style={{ color: colors.success }}>+{summary.additions}</Text>
          <Text style={{ color: colors.danger }}> −{summary.deletions}</Text>
        </Text>
      ) : null}
      {summary.kind === "search" && summary.matches.length > 0 ? (
        <Text style={[styles.statText, { color: colors.accent }]}>{summary.matches.length} matches</Text>
      ) : null}
      {summary.kind === "todo" && summary.todos.length > 0 ? (
        <Text style={[styles.statText, { color: colors.textSoft }]}>
          {summary.todos.filter((todo) => todo.status === "completed").length}/{summary.todos.length}
        </Text>
      ) : null}
      {duration !== null && duration >= 400 ? <Text style={styles.statText}>{formatDuration(duration)}</Text> : null}
    </View>
  )
}

function ToolBody({ summary }: { summary: ToolSummary }) {
  const styles = useThemedStyles(createStyles)
  switch (summary.kind) {
    case "shell":
      return (
        <TerminalBody
          command={summary.command}
          cwd={summary.cwd}
          output={summary.output ? stripAnsi(summary.output) : undefined}
          running={summary.status === "running"}
        />
      )
    case "read":
      if (summary.content === undefined) return <Text style={styles.mutedText}>Reading…</Text>
      if (summary.content === "") return <Text style={styles.mutedText}>Empty file</Text>
      return (
        <View style={styles.stack}>
          <CodeBlock
            text={summary.content}
            numbered={!looksLineNumbered(summary.content)}
            startLine={summary.startLine ?? 1}
            maxLines={28}
          />
          {summary.truncatedNext !== undefined ? (
            <Text style={styles.mutedText}>Output truncated · continue from line {summary.truncatedNext}</Text>
          ) : null}
        </View>
      )
    case "write":
      return summary.content ? (
        <CodeBlock text={summary.content} maxLines={28} />
      ) : (
        <Text style={styles.mutedText}>Writing…</Text>
      )
    case "edit":
      if (summary.diff.length > 0) return <DiffView diff={summary.diff} />
      return summary.output ? (
        <CodeBlock text={summary.output} numbered={false} maxLines={12} />
      ) : (
        <Text style={styles.mutedText}>Applying edit…</Text>
      )
    case "search":
      return <SearchBody pattern={summary.pattern} matches={summary.matches} />
    case "web":
      return (
        <View style={styles.stack}>
          {summary.url ? (
            <Text selectable style={styles.urlText}>
              {summary.url}
            </Text>
          ) : null}
          {summary.output ? <CodeBlock text={summary.output} numbered={false} maxLines={20} /> : null}
        </View>
      )
    case "todo":
      return <TodoBody todos={summary.todos} />
    case "question":
      return (
        <View style={styles.stack}>
          {summary.questions.map((question, index) => (
            <View key={index} style={styles.questionRow}>
              {question.header ? <Text style={styles.questionHeader}>{question.header}</Text> : null}
              <Text style={styles.questionText}>{question.question}</Text>
              {question.options.map((option) => (
                <Text key={option.label} style={styles.questionOption}>
                  • <Text style={styles.questionOptionLabel}>{option.label}</Text>
                  {option.description ? ` — ${option.description}` : ""}
                </Text>
              ))}
            </View>
          ))}
        </View>
      )
    default:
      return (
        <View style={styles.stack}>
          <KeyValueList entries={summary.entries} />
          {summary.output ? <CodeBlock text={stripAnsi(summary.output)} numbered={false} maxLines={24} /> : null}
        </View>
      )
  }
}

/**
 * Collapsible card for every agent tool (React Native mirror of the web
 * `ToolCard`): semantic header summary plus a tool-specific body.
 */
export function ToolCard({ part }: { part: ChatToolPart }) {
  const [open, setOpen] = useState(false)
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()
  const summary = describeTool(part)
  const accent = toolAccent(summary.accent, colors)
  const duration = useLiveDuration(summary.status, summary.timing)
  const pending = summary.status === "pending"

  return (
    <View style={[styles.card, summary.status === "error" && styles.cardError]}>
      <Pressable style={styles.header} onPress={() => setOpen((value) => !value)}>
        <View style={[styles.dot, { backgroundColor: statusColor(summary.status, colors) }]} />
        <View style={[styles.iconChip, { backgroundColor: accent.bg }]}>
          <Text style={[styles.iconGlyph, { color: accent.text }]}>{toolGlyphs[summary.icon]}</Text>
        </View>
        <View style={styles.titleWrap}>
          <Text style={[styles.title, pending && styles.pendingTitle]} numberOfLines={1}>
            {summary.title}
          </Text>
          {summary.subtitle && summary.kind !== "edit" ? (
            <Text style={styles.subtitle} numberOfLines={1}>
              {summary.tool} · {summary.subtitle}
            </Text>
          ) : (
            <Text style={styles.subtitle} numberOfLines={1}>
              {summary.tool}
            </Text>
          )}
        </View>
        <HeaderStats summary={summary} duration={duration} />
        <Text style={styles.chevron}>{open ? "⌄" : "›"}</Text>
      </Pressable>

      {open ? (
        <View style={styles.body}>
          {pending ? (
            <View style={styles.pendingBody}>
              <View style={styles.pendingBar} />
              <View style={[styles.pendingBar, styles.pendingBarShort]} />
            </View>
          ) : (
            <ToolBody summary={summary} />
          )}
          {summary.error ? <Text style={styles.error}>{summary.error}</Text> : null}
        </View>
      ) : null}
    </View>
  )
}

function createStyles(colors: Palette, fonts: Fonts) {
  return StyleSheet.create({
    card: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      borderRadius: 16,
      backgroundColor: colors.surface,
      overflow: "hidden",
    },
    cardError: {
      borderColor: colors.dangerLine,
    },
    header: {
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
    iconChip: {
      width: 22,
      height: 22,
      borderRadius: 6,
      alignItems: "center",
      justifyContent: "center",
    },
    iconGlyph: {
      fontFamily: fonts.mono,
      fontSize: 10,
      fontWeight: "700",
    },
    titleWrap: {
      flex: 1,
      minWidth: 0,
    },
    title: {
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 13,
    },
    pendingTitle: {
      color: colors.textMuted,
    },
    subtitle: {
      color: colors.textMuted,
      fontFamily: fonts.mono,
      fontSize: 10,
      marginTop: 1,
    },
    stats: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    statText: {
      color: colors.textMuted,
      fontFamily: fonts.mono,
      fontSize: 10,
    },
    chevron: {
      color: colors.textFaint,
      fontSize: 12,
    },
    body: {
      gap: 8,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.hairline,
      padding: 10,
    },
    stack: {
      gap: 8,
    },
    mutedText: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 12,
    },
    error: {
      color: colors.danger,
      fontFamily: fonts.ui,
      fontSize: 12,
    },
    urlText: {
      color: colors.accent,
      fontFamily: fonts.mono,
      fontSize: 11,
    },
    questionRow: {
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      backgroundColor: colors.surfaceMuted,
      padding: 10,
      gap: 3,
    },
    questionHeader: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 10,
      fontWeight: "700",
      textTransform: "uppercase",
      letterSpacing: 0.5,
    },
    questionText: {
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 13,
    },
    questionOption: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 11,
    },
    questionOptionLabel: {
      color: colors.textSoft,
    },
    pendingBody: {
      gap: 6,
    },
    pendingBar: {
      height: 8,
      width: "66%",
      borderRadius: 4,
      backgroundColor: colors.surfaceMuted,
      opacity: 0.7,
    },
    pendingBarShort: {
      width: "33%",
    },
  })
}
