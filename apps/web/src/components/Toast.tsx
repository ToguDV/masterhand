import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react"

/**
 * Inverted ink pills for confirmations ("✓ Copied", "✓ Session deleted").
 * Auto-dismissing and decorative, so the host is `aria-live` and the messages
 * never block interaction.
 */
const ToastContext = createContext<(message: string) => void>(() => {})

export function useToast(): (message: string) => void {
  return useContext(ToastContext)
}

const TOAST_DURATION_MS = 2600

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Array<{ id: number; message: string }>>([])
  const nextID = useRef(0)

  const push = useCallback((message: string) => {
    const id = nextID.current++
    setToasts((prev) => [...prev, { id, message }])
    window.setTimeout(() => setToasts((prev) => prev.filter((toast) => toast.id !== id)), TOAST_DURATION_MS)
  }, [])

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="mh-toast-host" aria-live="polite">
        {toasts.map((toast) => (
          <span key={toast.id} className="mh-toast" role="status">
            {toast.message}
          </span>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
