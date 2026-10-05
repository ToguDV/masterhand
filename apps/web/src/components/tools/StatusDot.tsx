import type { ChatToolStatus } from "@masterhand/client-core"

export function statusDotClass(status: ChatToolStatus): string {
  return status === "completed"
    ? "mh-dot--connected"
    : status === "error"
      ? "mh-dot--danger"
      : status === "running"
        ? "mh-dot--busy"
        : ""
}

/** Small status dot shared by every tool card header. */
export function StatusDot({ status, className = "" }: { status: ChatToolStatus; className?: string }) {
  return <span className={`mh-dot ${statusDotClass(status)} ${className}`} />
}
