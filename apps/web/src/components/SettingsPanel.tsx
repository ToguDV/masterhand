import { useState, type ComponentType } from "react"
import { DEFAULT_PALETTE, PALETTES, PALETTE_IDS, type PaletteID } from "@masterhand/client-core"
import { useModalFocus } from "./useModalFocus"
import { KeyIcon, SunIcon, XIcon, type IconProps } from "./icons"
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
  palette,
  onSelectPalette,
  onClose,
}: {
  mode: ThemeMode
  onSelectMode: (mode: ThemeMode) => void
  palette: PaletteID
  onSelectPalette: (palette: PaletteID) => void
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
              <AppearanceSection
                mode={mode}
                onSelectMode={onSelectMode}
                palette={palette}
                onSelectPalette={onSelectPalette}
              />
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
  palette,
  onSelectPalette,
}: {
  mode: ThemeMode
  onSelectMode: (mode: ThemeMode) => void
  palette: PaletteID
  onSelectPalette: (palette: PaletteID) => void
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
              <ThemeDrop
                top={option.swatches[0]}
                bottom={option.swatches[1]}
                selected={selected}
                clipId={`mh-drop-${option.value}`}
              />
            </button>
          )
        })}
      </div>
      <p className="mh-caption mh-muted mt-4">Accent color</p>
      <div role="radiogroup" aria-label="Accent color" className="mh-palette-grid">
        {PALETTE_IDS.map((id) => {
          const entry = PALETTES[id]
          const selected = palette === id
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={entry.label}
              title={entry.label}
              onClick={() => onSelectPalette(id)}
              className="mh-palette-option"
            >
              <span
                className="mh-palette-dot"
                aria-hidden="true"
                style={{
                  background: `linear-gradient(135deg, ${entry.light.accent} 50%, ${entry.dark.accent} 50%)`,
                }}
              />
              <span className="mh-body-sm font-medium">{entry.label}</span>
            </button>
          )
        })}
      </div>
      {palette !== DEFAULT_PALETTE && (
        <button
          type="button"
          onClick={() => onSelectPalette(DEFAULT_PALETTE)}
          className="mh-btn mh-btn--ghost mh-btn--sm mt-2"
        >
          Reset to {PALETTES[DEFAULT_PALETTE].label}
        </button>
      )}
    </section>
  )
}

/**
 * Stylized teardrop swatch pointing up: the two theme colors meet at an
 * S-curved "liquid" division, like the reference. The whole drop is clipped
 * so the wave never spills outside the outline.
 */
const DROP_D =
  "M24 2 C27.5 9 42 25 42 40 A18 18 0 0 1 6 40 C6 25 20.5 9 24 2 Z"
const WAVE_TOP_D =
  "M-4 -4 H52 V31 C40 39 32 41 25 36 C18 31 12 29 -4 36 Z"

function ThemeDrop({
  top,
  bottom,
  selected,
  clipId,
}: {
  top: string
  bottom: string
  selected: boolean
  clipId: string
}) {
  return (
    <span className={`mh-theme-drop${selected ? " is-selected" : ""}`} aria-hidden="true">
      <svg viewBox="0 0 48 64" width="40" height="54" focusable="false">
        <defs>
          <clipPath id={clipId}>
            <path d={DROP_D} />
          </clipPath>
        </defs>
        <path d={DROP_D} fill={bottom} />
        <path d={WAVE_TOP_D} fill={top} clipPath={`url(#${clipId})`} />
        <path
          d={DROP_D}
          fill="none"
          stroke={selected ? "var(--mh-accent)" : "var(--mh-hairline-strong)"}
          strokeWidth={selected ? 2 : 1.5}
        />
        {selected && (
          <path
            d="M17.5 41.5 L22.5 46.5 L30.5 36.5"
            fill="none"
            stroke="#ffffff"
            strokeWidth="3.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ filter: "drop-shadow(0 1px 2px rgba(0, 0, 0, 0.55))" }}
          />
        )}
      </svg>
    </span>
  )
}
