import { useEffect, useState } from "react"

/** The mobile shell breakpoint; Tailwind's `md` starts at 768px. */
export const MOBILE_MEDIA_QUERY = "(max-width: 767px)"

/**
 * Tracks a CSS media query. The initial value is read synchronously so the
 * first paint already picks the right shell (there is no server renderer).
 *
 * The app shell uses this for the mobile/desktop split instead of CSS alone:
 * the two shells mount different panels, and mounting both (one merely
 * `display: none`) would duplicate queries, focusable controls and text.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false
    return window.matchMedia(query).matches
  })

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return
    const media = window.matchMedia(query)
    const onChange = () => setMatches(media.matches)
    onChange()
    media.addEventListener("change", onChange)
    return () => media.removeEventListener("change", onChange)
  }, [query])

  return matches
}
