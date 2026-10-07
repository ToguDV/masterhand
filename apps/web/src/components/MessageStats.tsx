import { formatCount, formatSpeed, messageStats, type ChatMessageInfo } from "@masterhand/client-core"
import { ArrowDownIcon, ArrowUpIcon, BoltIcon, SparkleIcon } from "./icons"

/**
 * Per-message usage as icons + numbers only (labels live in the tooltips),
 * mirroring SessionStats (issue #126). Cache read/write are deliberately not
 * shown. The caller renders it only once the message completed.
 */
export function MessageStats({ info }: { info: ChatMessageInfo }) {
  const stats = messageStats(info)
  const tokens = stats.input > 0 || stats.output > 0 || stats.reasoning > 0
  if (stats.modelID === null && stats.cost === null && !tokens && stats.speed === null) return null

  return (
    <p
      aria-label="Message usage"
      className="mh-msg__meta flex min-w-0 flex-wrap items-center gap-2.5"
    >
      {stats.modelID !== null && <span className="min-w-0 truncate">{stats.modelID}</span>}
      {stats.cost !== null && <span title="Cost">${stats.cost.toFixed(4)}</span>}
      {stats.input > 0 && (
        <span className="flex items-center gap-1" title="Input tokens">
          <ArrowUpIcon size={12} />
          {formatCount(stats.input)}
        </span>
      )}
      {stats.output > 0 && (
        <span className="flex items-center gap-1" title="Output tokens">
          <ArrowDownIcon size={12} />
          {formatCount(stats.output)}
        </span>
      )}
      {stats.reasoning > 0 && (
        <span className="flex items-center gap-1" title="Reasoning tokens">
          <SparkleIcon size={12} />
          {formatCount(stats.reasoning)}
        </span>
      )}
      {stats.speed !== null && (
        <span className="flex items-center gap-1" title="Generation speed">
          <BoltIcon size={12} />
          {formatSpeed(stats.speed)}
        </span>
      )}
    </p>
  )
}
