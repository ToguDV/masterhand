import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useDismissable } from "./useDismissable"
import { ChevronDownIcon } from "./icons"

export interface SearchSelectOption {
  value: string
  label: string
}

export function SearchSelect({
  value,
  options,
  onChange,
  ariaLabel,
  placeholder,
  previewCount = 6,
  compact = false,
  icon,
  title,
}: {
  value: string
  options: SearchSelectOption[]
  onChange: (value: string) => void
  ariaLabel: string
  placeholder: string
  previewCount?: number
  /** Condensed trigger (composer footer) instead of the full-width field. */
  compact?: boolean
  /** Optional leading glyph (kept out of the accessible name). */
  icon?: ReactNode
  title?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [expanded, setExpanded] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const selected = options.find((option) => option.value === value)
  const searchable = options.length > previewCount

  useDismissable(open, rootRef, () => setOpen(false))

  useEffect(() => {
    if (!open) {
      setQuery("")
      setExpanded(false)
      return
    }
    inputRef.current?.focus()
  }, [open])

  const visible = useMemo(() => {
    const term = query.trim().toLowerCase()
    if (term) return options.filter((option) => option.label.toLowerCase().includes(term))
    if (!searchable || expanded) return options
    const pinned = selected ? [selected, ...options.filter((option) => option.value !== selected.value)] : options
    return pinned.slice(0, previewCount)
  }, [options, query, searchable, expanded, selected, previewCount])

  const truncated = searchable && !expanded && !query.trim()

  return (
    <div ref={rootRef} className={`relative min-w-0 ${compact ? "" : "basis-full md:basis-32 md:flex-1"}`}>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault()
            setOpen(true)
          }
        }}
        title={title ?? ariaLabel}
        className={compact ? compactTriggerClass : triggerClass}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {icon}
          <span className={`truncate ${selected ? "text-ink" : "text-ink-muted"}`}>
            {selected?.label ?? placeholder}
          </span>
        </span>
        <ChevronDownIcon size={14} className="shrink-0 text-ink-muted" />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 z-30 mb-2 w-72 max-w-[85vw] rounded-md border border-hairline bg-surface p-2 shadow-elev3">
          {searchable && (
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && visible[0]) {
                  event.preventDefault()
                  onChange(visible[0].value)
                  setOpen(false)
                }
              }}
              placeholder="Search…"
              aria-label={`Search ${ariaLabel.toLowerCase()}`}
              className="mb-2 w-full rounded-sm border border-hairline-strong bg-surface px-2 py-1.5 text-xs text-ink outline-none placeholder:text-ink-faint focus:border-accent"
            />
          )}

          <ul role="listbox" aria-label={ariaLabel} className="max-h-60 space-y-0.5 overflow-y-auto">
            {visible.map((option) => (
              <li key={option.value}>
                <button
                  type="button"
                  role="option"
                  aria-selected={option.value === value}
                  onClick={() => {
                    onChange(option.value)
                    setOpen(false)
                  }}
                  className={`w-full truncate rounded-sm px-2 py-1.5 text-left text-xs hover:bg-surface-muted ${
                    option.value === value ? "text-accent" : "text-ink-soft"
                  }`}
                >
                  {option.label}
                </button>
              </li>
            ))}
            {visible.length === 0 && <li className="px-2 py-3 text-xs text-ink-muted">No matches</li>}
          </ul>

          {truncated && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="mt-1 w-full rounded-sm px-2 py-1.5 text-left text-xs text-accent hover:bg-surface-muted"
            >
              Show all {options.length} {ariaLabel.toLowerCase()}s
            </button>
          )}
        </div>
      )}
    </div>
  )
}

const triggerClass =
  "flex w-full items-center justify-between gap-2 rounded-sm border border-hairline-strong bg-surface px-2.5 py-1.5 text-sm outline-none transition-colors hover:bg-surface-muted focus-visible:border-accent"

const compactTriggerClass =
  "flex max-w-[14rem] cursor-pointer items-center justify-between gap-1.5 rounded-sm border border-hairline-strong bg-surface px-2 py-1 text-xs outline-none transition-colors hover:bg-surface-muted focus-visible:border-accent"
