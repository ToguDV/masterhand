import { useState, type ComponentType } from "react"
import { DEFAULT_PALETTE, PALETTES, PALETTE_IDS, type PaletteID } from "@masterhand/client-core"
import { useModalFocus } from "./useModalFocus"
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  KeyIcon,
  SearchIcon,
  SparkleIcon,
  SunIcon,
  XIcon,
  type IconProps,
} from "./icons"
import { GoalReviewSection } from "./GoalReviewSection"
import { ProvidersSection } from "./ProvidersSection"
import { WebSearchSection } from "./WebSearchSection"
import type { ThemeMode } from "../theme"

const THEMES: Array<{ value: ThemeMode; label: string; canvas: string }> = [
  { value: "light", label: "Light", canvas: "#FAFAF7" },
  { value: "dark", label: "Dark", canvas: "#0C0C0B" },
]

type SettingsModule = "appearance" | "goal" | "websearch" | "providers"

const MODULES: Array<{ id: SettingsModule; label: string; desc: string; icon: ComponentType<IconProps> }> = [
  { id: "appearance", label: "Appearance", desc: "Theme and color", icon: SunIcon },
  { id: "goal", label: "Goal review", desc: "Critic, judge and rounds", icon: SparkleIcon },
  { id: "websearch", label: "Web search", desc: "Default source and keys", icon: SearchIcon },
  { id: "providers", label: "Providers", desc: "API keys and custom providers", icon: KeyIcon },
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
  // Mobile (<768px) is a master-detail flow: the dialog opens on the vertical
  // section list and shows only the selected section, with a back control.
  // Desktop keeps the two-pane layout and ignores this flag.
  const [mobileList, setMobileList] = useState(true)

  function openModule(id: SettingsModule): void {
    setModule(id)
    setMobileList(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center mh-overlay md:items-center md:p-4">
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        data-mobile-view={mobileList ? "list" : "detail"}
        className="mh-settings pb-safe outline-none"
      >
        <header className="mh-settings__head">
          {!mobileList && (
            <button
              type="button"
              className="mh-settings__back-header mh-btn mh-btn--quiet"
              aria-label="Back to settings"
              onClick={() => setMobileList(true)}
            >
              <ArrowLeftIcon size={16} />
            </button>
          )}
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
                  aria-label={item.label}
                  aria-current={module === item.id ? "page" : undefined}
                  onClick={() => openModule(item.id)}
                >
                  <Icon size={16} />
                  <span className="mh-settings__nav-text">
                    <span className="mh-settings__nav-label">{item.label}</span>
                    <span className="mh-settings__nav-desc">{item.desc}</span>
                  </span>
                  <ChevronRightIcon size={16} className="mh-settings__nav-chevron" />
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
            ) : module === "goal" ? (
              <GoalReviewSection />
            ) : module === "websearch" ? (
              <WebSearchSection />
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
          const accent = option.value === "light" ? PALETTES[palette].light.accent : PALETTES[palette].dark.accent
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
              <span className="mh-theme-name mh-body-sm font-medium" title={option.label}>{option.label}</span>
              <ThemeDrop
                top={option.canvas}
                bottom={accent}
                selected={selected}
                clipId={`mh-drop-${option.value}`}
              />
            </button>
          )
        })}
      </div>
      <p className="mh-caption mh-muted mt-4">Color theme</p>
      <div role="radiogroup" aria-label="Color theme" className="mh-palette-grid">
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
              <span className="mh-palette-name mh-body-sm font-medium">{entry.label}</span>
              <span
                className="mh-palette-dot"
                aria-hidden="true"
                style={{
                  background: `linear-gradient(135deg, ${entry.light.canvas} 0 33%, ${entry.light.accent} 33% 66%, ${entry.dark.accent} 66% 100%)`,
                }}
              />
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
