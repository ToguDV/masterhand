import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons"

/**
 * Single source of truth for mobile UI glyphs, mirroring the web
 * `apps/web/src/components/icons.tsx` set (issue #92). Names and meanings
 * match the web so both platforms stay aligned; colors are always passed from
 * the active theme by the caller.
 */
export interface IconProps {
  size?: number
  color?: string
}

export function FolderIcon({ size = 16, color }: IconProps) {
  return <Ionicons name="folder-outline" size={size} color={color} />
}

export function ChevronDownIcon({ size = 16, color }: IconProps) {
  return <Ionicons name="chevron-down" size={size} color={color} />
}

export function PlusIcon({ size = 16, color }: IconProps) {
  return <Ionicons name="add" size={size} color={color} />
}

export function CloseIcon({ size = 16, color }: IconProps) {
  return <Ionicons name="close" size={size} color={color} />
}

export function TrashIcon({ size = 16, color }: IconProps) {
  return <Ionicons name="trash-outline" size={size} color={color} />
}

export function CheckIcon({ size = 16, color }: IconProps) {
  return <Ionicons name="checkmark" size={size} color={color} />
}

export function ArrowUpIcon({ size = 16, color }: IconProps) {
  return <Ionicons name="arrow-up" size={size} color={color} />
}

export function ArrowDownIcon({ size = 16, color }: IconProps) {
  return <Ionicons name="arrow-down" size={size} color={color} />
}

export function SparkleIcon({ size = 16, color }: IconProps) {
  return <Ionicons name="sparkles-outline" size={size} color={color} />
}

export function BoltIcon({ size = 16, color }: IconProps) {
  return <Ionicons name="flash-outline" size={size} color={color} />
}

export function SunIcon({ size = 16, color }: IconProps) {
  return <Ionicons name="sunny-outline" size={size} color={color} />
}

export function MoonIcon({ size = 16, color }: IconProps) {
  return <Ionicons name="moon-outline" size={size} color={color} />
}

export function MenuIcon({ size = 16, color }: IconProps) {
  return <Ionicons name="menu" size={size} color={color} />
}

export function ExternalLinkIcon({ size = 16, color }: IconProps) {
  return <Ionicons name="open-outline" size={size} color={color} />
}

export function ShieldCheckIcon({ size = 16, color }: IconProps) {
  return <Ionicons name="shield-checkmark-outline" size={size} color={color} />
}

export function SlidersIcon({ size = 16, color }: IconProps) {
  return <Ionicons name="options-outline" size={size} color={color} />
}

/** App-level settings (issue #119). */
export function GearIcon({ size = 16, color }: IconProps) {
  return <Ionicons name="settings-outline" size={size} color={color} />
}

/** Run & preview trigger (replaces the text label, issue #120). */
export function PlayIcon({ size = 16, color }: IconProps) {
  return <Ionicons name="play-outline" size={size} color={color} />
}

/** Effort (reasoning) variants; generic variants use `SlidersIcon` instead. */
export function BrainIcon({ size = 16, color }: IconProps) {
  return <MaterialCommunityIcons name="brain" size={size} color={color} />
}

/** Branch / worktree. */
export function BranchIcon({ size = 16, color }: IconProps) {
  return <MaterialCommunityIcons name="source-branch" size={size} color={color} />
}
