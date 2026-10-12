import { Ionicons } from "@expo/vector-icons"
import type { ToolIcon as ToolIconName } from "@masterhand/client-core"

/**
 * Vector glyph per semantic tool icon, mirroring the web `ToolIcon` set: the
 * header chip never falls back to a font-dependent unicode approximation
 * (the old `▤`/`✎` text glyphs rendered as tofu on devices without them).
 */
const names: Record<ToolIconName, keyof typeof Ionicons.glyphMap> = {
  terminal: "terminal-outline",
  file: "document-text-outline",
  pencil: "pencil-outline",
  diff: "git-compare-outline",
  search: "search-outline",
  globe: "globe-outline",
  checklist: "checkbox-outline",
  question: "help-circle-outline",
  tool: "construct-outline",
}

export function ToolIcon({ icon, size = 14, color }: { icon: ToolIconName; size?: number; color?: string }) {
  return <Ionicons name={names[icon]} size={size} color={color} />
}
