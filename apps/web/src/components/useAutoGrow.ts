import { useLayoutEffect, useRef } from "react"

/**
 * Keeps a textarea exactly as tall as its content (never taller than the CSS
 * `max-height`). Used where a one-line field must accept a paragraph — card
 * titles — and where the description should grow instead of showing a native
 * resize grip.
 */
export function useAutoGrow(value: string) {
  const ref = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    element.style.height = "auto"
    element.style.height = `${element.scrollHeight}px`
  }, [value])

  return ref
}
