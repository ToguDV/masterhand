import { useEffect, useRef } from "react"

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Focus management for modal surfaces: move focus inside on mount, keep Tab
 * cycling within the dialog, close on Escape and restore the previous focus on
 * unmount. The returned ref goes on the dialog container, which should be
 * focusable (`tabIndex={-1}`) as the fallback target.
 */
export function useModalFocus<T extends HTMLElement>(onClose: () => void) {
  const ref = useRef<T>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    const container = ref.current
    if (!container) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null

    function focusable(): HTMLElement[] {
      return Array.from(container!.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (element) => element.offsetParent !== null,
      )
    }

    const first = focusable()[0]
    if (first) first.focus()
    else container.focus()

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault()
        closeRef.current()
        return
      }
      if (event.key !== "Tab") return
      const items = focusable()
      if (items.length === 0) {
        event.preventDefault()
        container!.focus()
        return
      }
      const index = items.indexOf(document.activeElement as HTMLElement)
      const next = event.shiftKey
        ? items[index <= 0 ? items.length - 1 : index - 1]
        : items[index === items.length - 1 || index === -1 ? 0 : index + 1]
      event.preventDefault()
      next?.focus()
    }

    container.addEventListener("keydown", onKeyDown)
    return () => {
      container.removeEventListener("keydown", onKeyDown)
      previous?.focus()
    }
  }, [])

  return ref
}
