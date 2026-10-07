import { SidePanel } from "./SidePanel"
import { CheckIcon } from "./icons"
import { ProvidersSection } from "./ProvidersSection"
import type { ThemeMode } from "../theme"

const MODES: Array<{ value: ThemeMode; label: string; hint: string }> = [
  { value: "system", label: "System", hint: "Follow this device" },
  { value: "light", label: "Light", hint: "Paper" },
  { value: "dark", label: "Dark", hint: "Ink" },
]

/**
 * App-level settings (issue #119): one right-docked sheet behind the top-bar
 * gear. The Appearance section owns the mode (System clears the stored
 * choice); later sections append below without reworking the shell.
 */
export function SettingsSheet({
  mode,
  onSelectMode,
  onClose,
}: {
  mode: ThemeMode
  onSelectMode: (mode: ThemeMode) => void
  onClose: () => void
}) {
  return (
    <SidePanel title="Settings" closeLabel="Close settings" onClose={onClose}>
      <section className="border-b border-hairline p-4" aria-labelledby="settings-appearance">
        <h3
          id="settings-appearance"
          className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-muted"
        >
          Appearance
        </h3>
        <div role="radiogroup" aria-label="Theme mode" className="flex flex-col gap-1">
          {MODES.map((option) => {
            const selected = mode === option.value
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => onSelectMode(option.value)}
                className={`mh-btn mh-btn--quiet w-full justify-start gap-3 ${selected ? "mh-btn--secondary" : ""}`}
              >
                <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                  <span className="mh-body-sm font-medium">{option.label}</span>
                  <span className="text-xs text-ink-muted">{option.hint}</span>
                </span>
                {selected && <CheckIcon size={16} className="text-accent" />}
              </button>
            )
          })}
        </div>
      </section>

      <ProvidersSection />
    </SidePanel>
  )
}
