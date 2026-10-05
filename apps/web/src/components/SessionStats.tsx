import { formatCount, formatSpeed, tokenSpeed, type SessionUsage } from "@masterhand/client-core"
import { ArrowDownIcon, ArrowUpIcon, BoltIcon, SparkleIcon } from "./icons"

/**
 * Per-session usage as icons + numbers only (labels live in the tooltips).
 * Cache read/write are deliberately not shown: they add noise and providers
 * report them as zero most of the time.
 */
export function SessionStats({ usage }: { usage: SessionUsage }) {
  const speed = tokenSpeed(usage, usage.durationMs)
  const tokens = usage.input > 0 || usage.output > 0 || usage.reasoning > 0
  if (usage.cost <= 0 && !tokens && speed === null) return null

  return (
    <div
      aria-label="Session usage"
      className="flex min-w-0 flex-wrap items-center justify-end gap-2.5 text-[11px] text-ink-muted"
    >
      {usage.cost > 0 && <span title="Cost">${usage.cost.toFixed(4)}</span>}
      {usage.input > 0 && (
        <span className="flex items-center gap-1" title="Input tokens">
          <ArrowUpIcon size={12} />
          {formatCount(usage.input)}
        </span>
      )}
      {usage.output > 0 && (
        <span className="flex items-center gap-1" title="Output tokens">
          <ArrowDownIcon size={12} />
          {formatCount(usage.output)}
        </span>
      )}
      {usage.reasoning > 0 && (
        <span className="flex items-center gap-1" title="Reasoning tokens">
          <SparkleIcon size={12} />
          {formatCount(usage.reasoning)}
        </span>
      )}
      {speed !== null && (
        <span className="flex items-center gap-1" title="Generation speed">
          <BoltIcon size={12} />
          {formatSpeed(speed)}
        </span>
      )}
    </div>
  )
}
