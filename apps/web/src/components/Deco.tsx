import type { CSSProperties } from "react"

export type DecoVariant = "blob" | "blob-2" | "dots" | "hatch" | "curve"

/**
 * Organic decoration for surfaces that would otherwise sit empty (login,
 * empty states). Always `aria-hidden`, never behind dense content, and one
 * element per screen on mobile per the design rules.
 */
export function Deco({
  variant,
  className = "",
  style,
}: {
  variant: DecoVariant
  className?: string
  style?: CSSProperties
}) {
  if (variant === "curve") {
    return (
      <svg
        aria-hidden="true"
        className={`mh-deco mh-deco--curve ${className}`}
        style={style}
        viewBox="0 0 220 120"
        fill="none"
      >
        <path
          d="M4 104C58 104 82 16 132 16c28 0 44 18 84 18"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    )
  }
  return <div aria-hidden="true" className={`mh-deco mh-deco--${variant} ${className}`} style={style} />
}
