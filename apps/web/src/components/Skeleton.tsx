import type { HTMLAttributes } from "react"

/**
 * Placeholder that reserves the final geometry of async content. Size it with
 * Tailwind utilities (`h-3 w-40`, `h-10 w-10 rounded-full`); the surface and
 * pulse come from `.mh-skeleton`.
 */
export function Skeleton({ className = "", ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return <span aria-hidden="true" className={`mh-skeleton ${className}`} {...rest} />
}

/** Screen-reader status for a region whose visible placeholder is aria-hidden. */
export function SkeletonStatus({ label }: { label: string }) {
  return (
    <p className="sr-only" role="status">
      {label}
    </p>
  )
}
