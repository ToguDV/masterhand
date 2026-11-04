/**
 * Shared switch. The knob is anchored with `left-0.5` before it translates:
 * without an explicit inset, `position: absolute` falls back to the button's
 * centered static position and the active knob overflows the 36 px track.
 */
export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean
  onChange: (value: boolean) => void
  label?: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? "bg-accent" : "bg-hairline-strong"
      }`}
    >
      <span
        className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full transition-transform ${
          checked ? "translate-x-4 bg-on-accent" : "bg-surface"
        }`}
      />
    </button>
  )
}
