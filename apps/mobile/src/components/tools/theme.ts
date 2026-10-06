import type { ChatToolStatus, ToolAccent, ToolIcon } from "@masterhand/client-core"
import type { Palette } from "../../theme"

/**
 * Ink-on-paper tool accents: the design allows exactly one hue (emerald) plus
 * the warning semantic; every other family stays neutral. Returns the text
 * color and a soft tint background for the tool's glyph chip.
 */
export function toolAccent(accent: ToolAccent, colors: Palette): { text: string; bg: string } {
  switch (accent) {
    case "emerald":
      return { text: colors.accent, bg: colors.accentSoft }
    case "amber":
      return { text: colors.warning, bg: colors.warningSoft }
    default:
      return { text: colors.textSoft, bg: colors.surfaceMuted }
  }
}

export function statusColor(status: ChatToolStatus, colors: Palette): string {
  return status === "completed"
    ? colors.success
    : status === "error"
      ? colors.danger
      : status === "running"
        ? colors.warning
        : colors.textMuted
}

/** Monochrome glyphs, one per semantic icon (mirrors the web SVG set). */
export const toolGlyphs: Record<ToolIcon, string> = {
  terminal: ">_",
  file: "▤",
  pencil: "✎",
  diff: "±",
  search: "⌕",
  globe: "⊕",
  checklist: "☑",
  question: "?",
  tool: "⚙",
}
