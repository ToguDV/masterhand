import { useState, type ComponentType } from "react"
import { useModalFocus } from "./useModalFocus"
import { CheckIcon, KeyIcon, SunIcon, XIcon, type IconProps } from "./icons"
import { ProvidersSection } from "./ProvidersSection"
import type { ThemeMode } from "../theme"

const MODES: Array<{ value: ThemeMode; label: string; hint: string }> = [
  { value: "system", label: "System", hint: "Follow this device" },
  { value: "light", label: "Light", hint: "Paper" },
  { value: "dark", label: "Dark", hint: "Ink" },
]

type SettingsModule = "appearance" | "providers"

const MODULES: Array<{ id: SettingsModule; label: string; icon: ComponentType<IconProps> }> = [
  { id: "appearance", label: "Appearance", icon: SunIcon },
  { id: "providers", label: "Providers", icon: KeyIcon },
]

/**
 * App-level settings (issue #119): a centered modal with the modules on the
 * left and the selected module's content on the right. Appearance owns the
 * mode (System clears the stored choice); later modules append to the nav
 * without reworking the shell.
 */
export function SettingsDialog({
  mode,
  onSelectMode,
  onClose,
}: {
  mode: ThemeMode
  onSelectMode: (mode: ThemeMode) => void
  onClose: () => void
}) {
  const dialogRef = useModalFocus<HTMLDivElement>(onClose)
  const [module, setModule] = useState<SettingsModule>("appearance")

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center mh-overlay md:items-center md:p-4">
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className="mh-settings pb-safe outline-none"
      >
        <header className="mh-settings__head">
          <h2 className="mh-heading-4">Settings</h2>
          <button
            type="button"
            className="mh-settings__close mh-btn mh-btn--quiet"
            aria-label="Close settings"
            onClick={onClose}
          >
            <XIcon size={16} />
          </button>
        </header>

        <div className="mh-settings__body">
          <nav className="mh-settings__nav" aria-label="Settings sections">
            {MODULES.map((item) => {
              const Icon = item.icon
              return (
                <button
                  key={item.id}
                  type="button"
                  className="mh-settings__nav-item"
                  aria-current={module === item.id ? "page" : undefined}
                  onClick={() => setModule(item.id)}
                >
                  <Icon size={16} />
                  {item.label}
                </button>
              )
            })}
          </nav>

          <div className="mh-settings__content scroll-thin">
            {module === "appearance" ? (
              <AppearanceSection mode={mode} onSelectMode={onSelectMode} />
            ) : (
              <ProvidersSection />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function AppearanceSection({
  mode,
  onSelectMode,
}: {
  mode: ThemeMode
  onSelectMode: (mode: ThemeMode) => void
}) {
  return (
    <section aria-labelledby="settings-appearance">
      <h3 id="settings-appearance" className="mh-settings__title">
        Appearance
      </h3>
      <p className="mh-settings__desc">Choose how MasterHand looks on this device.</p>
      <div role="radiogroup" aria-label="Theme mode" className="mt-4 flex flex-col gap-1">
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
  )
}
