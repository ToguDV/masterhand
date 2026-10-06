import { Fragment, useState } from "react"
import { Pressable, StyleSheet, Text, View } from "react-native"
import {
  looksLineNumbered,
  truncateLines,
  type DiffLine,
  type KeyValueEntry,
  type TodoItem,
} from "@masterhand/client-core"
import { useTheme, useThemedStyles, type Fonts, type Palette } from "../../theme"

/** Monospace block with optional line numbers and a "show all" toggle. */
export function CodeBlock({
  text,
  title,
  maxLines = 24,
  numbered = true,
  startLine = 1,
}: {
  text: string
  title?: string
  maxLines?: number
  numbered?: boolean
  /** 1-based number of the first line (read pages start at their offset). */
  startLine?: number
}) {
  const [expanded, setExpanded] = useState(false)
  const styles = useThemedStyles(createStyles)
  const showNumbers = numbered && !looksLineNumbered(text)
  const truncated = truncateLines(text, expanded ? Number.POSITIVE_INFINITY : maxLines)
  const lines = truncated.text.split("\n")

  return (
    <View style={styles.block}>
      {title || truncated.hiddenLines > 0 ? (
        <View style={styles.blockHeader}>
          <Text style={styles.blockTitle} numberOfLines={1}>
            {title}
          </Text>
          {truncated.hiddenLines > 0 ? (
            <Pressable onPress={() => setExpanded(true)}>
              <Text style={styles.showAll}>Show all ({truncated.totalLines} lines)</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      <View style={styles.blockBody}>
        {lines.map((line, index) => (
          <View key={index} style={styles.codeRow}>
            {showNumbers ? <Text style={styles.lineNumber}>{startLine + index}</Text> : null}
            <Text selectable style={styles.codeText}>
              {line || " "}
            </Text>
          </View>
        ))}
        {truncated.hiddenLines > 0 ? (
          <Text style={styles.moreLines}>… {truncated.hiddenLines} more lines</Text>
        ) : null}
      </View>
    </View>
  )
}

/** Terminal-style block: command line, working directory and output. */
export function TerminalBody({
  command,
  cwd,
  output,
  running,
}: {
  command: string
  cwd?: string
  output?: string
  running: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const styles = useThemedStyles(createStyles)
  const truncated = truncateLines(output ?? "", expanded ? Number.POSITIVE_INFINITY : 30)

  return (
    <View style={styles.terminal}>
      <View style={styles.commandRow}>
        <Text style={styles.commandPrompt}>$</Text>
        <Text selectable style={styles.commandText}>
          {command}
        </Text>
      </View>
      {cwd ? <Text style={styles.cwd}>{cwd}</Text> : null}
      {output ? (
        <>
          <Text selectable style={styles.terminalOutput}>
            {truncated.text}
          </Text>
          {truncated.hiddenLines > 0 ? (
            <Pressable onPress={() => setExpanded(true)} style={styles.showAllRow}>
              <Text style={styles.showAll}>… {truncated.hiddenLines} more lines (show all)</Text>
            </Pressable>
          ) : null}
        </>
      ) : running ? (
        <Text style={styles.mutedText}>Running…</Text>
      ) : null}
    </View>
  )
}

function diffRowColor(kind: DiffLine["kind"], text: string, colors: Palette): string {
  if (kind === "add") return colors.accentSoft
  if (kind === "remove") return colors.dangerSoft
  if (text.startsWith("@@")) return colors.surfaceMuted
  return "transparent"
}

function diffTextColor(kind: DiffLine["kind"], text: string, colors: Palette): string {
  if (kind === "add") return colors.success
  if (kind === "remove") return colors.danger
  if (text.startsWith("@@")) return colors.textMuted
  return colors.codeText
}

/** Unified line diff with +/− coloring and a row cap. */
export function DiffView({ diff }: { diff: DiffLine[] }) {
  const [expanded, setExpanded] = useState(false)
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()
  const rows = expanded ? diff : diff.slice(0, 160)
  const hidden = diff.length - rows.length
  return (
    <View style={styles.block}>
      <View style={styles.blockBody}>
        {rows.map((line, index) => (
          <View key={index} style={[styles.diffRow, { backgroundColor: diffRowColor(line.kind, line.text, colors) }]}>
            <Text style={[styles.diffSign, { color: diffTextColor(line.kind, line.text, colors) }]}>
              {line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}
            </Text>
            <Text selectable style={[styles.codeText, { color: diffTextColor(line.kind, line.text, colors) }]}>
              {line.text || " "}
            </Text>
          </View>
        ))}
        {hidden > 0 ? (
          <Pressable onPress={() => setExpanded(true)} style={styles.showAllRow}>
            <Text style={styles.showAll}>… {hidden} more lines (show all)</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  )
}

/** Fallback body for unknown tools: readable key/value rows instead of raw JSON. */
export function KeyValueList({ entries }: { entries: KeyValueEntry[] }) {
  const styles = useThemedStyles(createStyles)
  if (entries.length === 0) return null
  return (
    <View style={[styles.block, styles.kvBody]}>
      {entries.map((entry) => (
        <View key={entry.key} style={styles.kvRow}>
          <Text style={styles.kvKey} numberOfLines={1}>
            {entry.key}
          </Text>
          <Text selectable style={styles.kvValue}>
            {entry.value}
          </Text>
        </View>
      ))}
    </View>
  )
}

/** Search results: one monospace row per match, pattern highlighted. */
export function SearchBody({ pattern, matches }: { pattern: string; matches: string[] }) {
  const [expanded, setExpanded] = useState(false)
  const styles = useThemedStyles(createStyles)
  if (matches.length === 0) return <Text style={styles.mutedText}>No matches</Text>
  const shown = expanded ? matches : matches.slice(0, 40)
  return (
    <View style={styles.block}>
      {shown.map((line, index) => (
        <View key={index} style={styles.searchRow}>
          <Text numberOfLines={1} style={styles.searchText}>
            <Highlight text={line} pattern={pattern} />
          </Text>
        </View>
      ))}
      {matches.length > shown.length ? (
        <Pressable onPress={() => setExpanded(true)} style={styles.showAllRow}>
          <Text style={styles.showAll}>… {matches.length - shown.length} more matches (show all)</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

function Highlight({ text, pattern }: { text: string; pattern: string }) {
  const styles = useThemedStyles(createStyles)
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
          {index < matches.length ? <Text style={styles.highlight}>{matches[index]}</Text> : null}
        </Fragment>
      ))}
    </>
  )
}

function todoGlyph(status: string, colors: Palette): { icon: string; color: string } {
  switch (status) {
    case "completed":
      return { icon: "✓", color: colors.success }
    case "in_progress":
      return { icon: "▸", color: colors.warning }
    case "cancelled":
      return { icon: "✕", color: colors.textMuted }
    default:
      return { icon: "○", color: colors.textMuted }
  }
}

/** Checklist for the todo tool. */
export function TodoBody({ todos }: { todos: TodoItem[] }) {
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()
  if (todos.length === 0) return null
  return (
    <View style={[styles.block, styles.kvBody]}>
      {todos.map((todo, index) => {
        const glyph = todoGlyph(todo.status, colors)
        return (
          <View key={index} style={styles.todoRow}>
            <Text style={[styles.todoIcon, { color: glyph.color }]}>{glyph.icon}</Text>
            <Text style={[styles.todoText, todo.status === "completed" && styles.todoDone]}>{todo.content}</Text>
          </View>
        )
      })}
    </View>
  )
}

function createStyles(colors: Palette, fonts: Fonts) {
  return StyleSheet.create({
    block: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      borderRadius: 12,
      backgroundColor: colors.codeSurface,
      overflow: "hidden",
    },
    blockHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.codeSurfaceSoft,
      paddingHorizontal: 10,
      paddingVertical: 5,
    },
    blockTitle: {
      flex: 1,
      color: colors.codeMuted,
      fontFamily: fonts.mono,
      fontSize: 11,
    },
    showAll: {
      color: colors.codeMuted,
      fontFamily: fonts.ui,
      fontSize: 10,
    },
    showAllRow: {
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.codeSurfaceSoft,
    },
    blockBody: {
      padding: 8,
    },
    codeRow: {
      flexDirection: "row",
      gap: 8,
    },
    lineNumber: {
      width: 22,
      textAlign: "right",
      color: colors.codeMuted,
      fontFamily: fonts.mono,
      fontSize: 11,
      lineHeight: 18,
    },
    codeText: {
      flex: 1,
      color: colors.codeText,
      fontFamily: fonts.mono,
      fontSize: 11,
      lineHeight: 18,
    },
    moreLines: {
      color: colors.codeMuted,
      fontFamily: fonts.ui,
      fontSize: 10,
      marginTop: 2,
    },
    terminal: {
      gap: 6,
    },
    commandRow: {
      flexDirection: "row",
      gap: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.accentLine,
      borderRadius: 12,
      backgroundColor: colors.codeSurface,
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    commandPrompt: {
      color: colors.accent,
      fontFamily: fonts.mono,
      fontSize: 12,
      lineHeight: 18,
    },
    commandText: {
      flex: 1,
      color: colors.codeText,
      fontFamily: fonts.mono,
      fontSize: 12,
      lineHeight: 18,
    },
    cwd: {
      color: colors.codeMuted,
      fontFamily: fonts.mono,
      fontSize: 10,
    },
    terminalOutput: {
      color: colors.codeText,
      fontFamily: fonts.mono,
      fontSize: 11,
      lineHeight: 17,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.codeSurfaceSoft,
      borderRadius: 12,
      backgroundColor: colors.codeSurface,
      padding: 10,
    },
    diffRow: {
      flexDirection: "row",
      gap: 6,
      borderRadius: 3,
      paddingHorizontal: 4,
    },
    diffSign: {
      width: 10,
      fontFamily: fonts.mono,
      fontSize: 11,
      lineHeight: 18,
    },
    kvBody: {
      padding: 10,
      gap: 6,
    },
    kvRow: {
      flexDirection: "row",
      gap: 8,
    },
    kvKey: {
      width: 96,
      color: colors.codeMuted,
      fontFamily: fonts.mono,
      fontSize: 11,
    },
    kvValue: {
      flex: 1,
      color: colors.codeText,
      fontFamily: fonts.ui,
      fontSize: 11,
      lineHeight: 16,
    },
    searchRow: {
      paddingHorizontal: 10,
      paddingVertical: 2,
    },
    searchText: {
      color: colors.codeText,
      fontFamily: fonts.mono,
      fontSize: 11,
    },
    highlight: {
      backgroundColor: colors.accentSoft,
      color: colors.accent,
    },
    mutedText: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 12,
    },
    todoRow: {
      flexDirection: "row",
      gap: 8,
    },
    todoIcon: {
      width: 14,
      fontFamily: fonts.mono,
      fontSize: 12,
    },
    todoText: {
      flex: 1,
      color: colors.codeText,
      fontFamily: fonts.ui,
      fontSize: 12,
      lineHeight: 17,
    },
    todoDone: {
      color: colors.codeMuted,
      textDecorationLine: "line-through",
    },
  })
}
