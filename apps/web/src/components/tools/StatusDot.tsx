import type { ChatToolStatus } from "@masterhand/client-core"
import { CheckIcon, GearIcon, XIcon } from "../icons"

/**
 * Phase-mapped status indicator shared by tool headers, subagents and forms.
 * A running tool spins the shared gear glyph; completed is a static check;
 * errors are a red X in the same icon format; anything else is a hollow idle ring.
 */
export function StatusDot({ status, className = "" }: { status: ChatToolStatus; className?: string }) {
  if (status === "running") {
    return <GearIcon size={14} className={`mh-rot shrink-0 text-ink-soft ${className}`} />
  }
  if (status === "completed") {
    return <CheckIcon size={14} className={`shrink-0 text-success ${className}`} />
  }
  if (status === "error") {
    return <XIcon size={14} className={`shrink-0 text-danger ${className}`} />
  }
  return <span className={`mh-idle-ring ${className}`} />
}
