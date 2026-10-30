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

export function ChevronRightIcon({ size = 16, color }: IconProps) {
  return <Ionicons name="chevron-forward" size={size} color={color} />
}

export function BackIcon({ size = 16, color }: IconProps) {
  return <Ionicons name="arrow-back" size={size} color={color} />
}

/** Provider credentials / API keys (Settings > Providers). */
export function KeyIcon({ size = 16, color }: IconProps) {
  return <Ionicons name="key-outline" size={size} color={color} />
}

/** Web search sources (Settings > Web search). */
export function SearchIcon({ size = 16, color }: IconProps) {
  return <Ionicons name="search-outline" size={size} color={color} />
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

/** Sign out / leave the app (sessions panel options box). */
export function LogOutIcon({ size = 16, color }: IconProps) {
  return <Ionicons name="log-out-outline" size={size} color={color} />
}

/** Scheduler section (clock face), mirroring the web rail. */
export function ClockIcon({ size = 16, color }: IconProps) {
  return <Ionicons name="time-outline" size={size} color={color} />
}

/** Sessions section (chat bubble), mirroring the web rail. */
export function ChatBubbleIcon({ size = 16, color }: IconProps) {
  return <Ionicons name="chatbubble-outline" size={size} color={color} />
}

/** Board section (kanban columns), mirroring the web rail. */
export function KanbanIcon({ size = 16, color }: IconProps) {
  return <MaterialCommunityIcons name="view-column" size={size} color={color} />
}

/** Run & preview trigger (replaces the text label, issue #120). */
export function PlayIcon({ size = 16, color }: IconProps) {
  return <Ionicons name="play" size={size} color={color} />
}

/** Pause a Goal Mode run. */
export function PauseIcon({ size = 16, color }: IconProps) {
  return <Ionicons name="pause" size={size} color={color} />
}

/** Stop/cancel a Goal Mode run. */
export function StopIcon({ size = 16, color }: IconProps) {
  return <Ionicons name="stop" size={size} color={color} />
}

/** Effort (reasoning) variants; generic variants use `SlidersIcon` instead. */
export function BrainIcon({ size = 16, color }: IconProps) {
  return <MaterialCommunityIcons name="brain" size={size} color={color} />
}

/** Branch / worktree. */
export function BranchIcon({ size = 16, color }: IconProps) {
  return <MaterialCommunityIcons name="source-branch" size={size} color={color} />
}

/** Saved server profile (Servers screen, header chip, settings). */
export function ServerIcon({ size = 16, color }: IconProps) {
  return <Ionicons name="server-outline" size={size} color={color} />
}

/** Server URL field. */
export function GlobeIcon({ size = 16, color }: IconProps) {
  return <Ionicons name="globe-outline" size={size} color={color} />
}

/** Rename a saved server. */
export function PencilIcon({ size = 16, color }: IconProps) {
  return <Ionicons name="pencil-outline" size={size} color={color} />
}

/** Reveal a password field. */
export function EyeIcon({ size = 16, color }: IconProps) {
  return <Ionicons name="eye-outline" size={size} color={color} />
}

/** Hide a password field. */
export function EyeOffIcon({ size = 16, color }: IconProps) {
  return <Ionicons name="eye-off-outline" size={size} color={color} />
}

/** Local agent-activity notifications (Settings > Notifications). */
export function BellIcon({ size = 16, color }: IconProps) {
  return <Ionicons name="notifications-outline" size={size} color={color} />
}

/** Attach a file from the composer. */
export function PaperclipIcon({ size = 16, color }: IconProps) {
  return <Ionicons name="attach-outline" size={size} color={color} />
}

/** Generic file glyph for attachment chips. */
export function FileIcon({ size = 16, color }: IconProps) {
  return <Ionicons name="document-outline" size={size} color={color} />
}
