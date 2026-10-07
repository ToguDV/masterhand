import { useState, type ComponentType } from "react"
import { useModalFocus } from "./useModalFocus"
import { CheckIcon, KeyIcon, SunIcon, XIcon, type IconProps } from "./icons"
import { ProvidersSection } from "./ProvidersSection"
import type { ThemeMode } from "../theme"

const THEMES: Array<{ value: ThemeMode; label: string; swatches: [string, string] }> = [
  { value: "light", label: "Light", swatches: ["#FAFAF7", "#0B6B53"] },
  { value: "dark", label: "Dark", swatches: ["#0C0C0B", "#3ED8A8"] },
]

type SettingsModule = "appearance" | "providers"

const MODULES: Array<{ id: SettingsModule; label: string; icon: ComponentType<IconProps> }> = [
  { id: "appearance", label: "Appearance", icon: SunIcon },
  { id: "providers", label: "Providers", icon: KeyIcon },
]

/**
 * App-level settings (issue #119): a centered modal with the modules on the
 * left and the selected module's content on the right. Appearance owns the
 * explicit theme (light/dark); later modules append to the nav
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
      <p className="mh-caption mh-muted mt-4">Theme color</p>
      <div role="radiogroup" aria-label="Theme color" className="mh-theme-swatches">
        {THEMES.map((option) => {
          const selected = mode === option.value
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={option.label}
              onClick={() => onSelectMode(option.value)}
              className="mh-theme-option"
            >
              <span className="mh-body-sm font-medium">{option.label}</span>
              <span
                className={`mh-theme-drop${selected ? " is-selected" : ""}`}
                aria-hidden="true"
                style={{
                  background: `linear-gradient(135deg, ${option.swatches[0]} 50%, ${option.swatches[1]} 50%)`,
                }}
              >
                {selected && <CheckIcon size={18} className="mh-theme-drop__check" />}
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
