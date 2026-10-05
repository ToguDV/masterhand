import type { ReactNode } from "react"
import { useModalFocus } from "./useModalFocus"
import { XIcon } from "./icons"

/**
 * Right sheet used by the run, preview, audit and side-question panels:
 * full width on mobile over a scrim, docked at 360px on desktop.
 */
export function SidePanel({
  title,
  closeLabel,
  actions,
  children,
  onClose,
}: {
  title: string
  closeLabel: string
  actions?: ReactNode
  children: ReactNode
  onClose: () => void
}) {
  const sheetRef = useModalFocus<HTMLDivElement>(onClose)

  return (
    <div className="mh-sheet-scrim" onClick={onClose}>
      <div
        ref={sheetRef}
        tabIndex={-1}
        className="mh-sheet outline-none"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-hairline px-3">
          <h2 className="text-sm font-medium">{title}</h2>
          <span className="flex-1" />
          {actions}
          <button type="button" className="mh-btn mh-btn--quiet" aria-label={closeLabel} onClick={onClose}>
            <XIcon size={16} />
          </button>
        </header>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  )
}
