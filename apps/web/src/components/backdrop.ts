import type { PointerEvent } from "react"

/**
 * Closes an overlay only when the press starts on the backdrop itself.
 *
 * A click handler is wrong here: selecting text inside a dialog and releasing
 * the mouse over the backdrop produces a click whose target is the common
 * ancestor (the backdrop), so the card closed mid-selection. Pointer-down is
 * the start of the gesture, and the target check keeps drags that began
 * inside from dismissing.
 */
export function backdropDismiss(onDismiss: () => void) {
  return (event: PointerEvent<HTMLElement>): void => {
    if (event.button !== 0) return
    if (event.target !== event.currentTarget) return
    onDismiss()
  }
}
