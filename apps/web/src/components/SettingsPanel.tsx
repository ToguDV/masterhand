import { useState, type ComponentType } from "react"
import { DEFAULT_PALETTE, PALETTES, PALETTE_IDS, type PaletteID } from "@masterhand/client-core"
import { useModalFocus } from "./useModalFocus"
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  CircleIcon,
  KeyIcon,
  LogOutIcon,
  PencilIcon,
  SearchIcon,
  ServerIcon,
  SparkleIcon,
  SunIcon,
  TrashIcon,
  XIcon,
  type IconProps,
} from "./icons"
import { GoalReviewSection } from "./GoalReviewSection"
import { ProvidersSection } from "./ProvidersSection"
import { WebSearchSection } from "./WebSearchSection"
import { AboutSection } from "./UpdateNotice"
import { ServerMonogram, ServerStatus } from "./ServerBits"
import type { ServerProfile } from "../servers"
import type { ThemeMode } from "../theme"

const THEMES: Array<{ value: ThemeMode; label: string; canvas: string }> = [
  { value: "light", label: "Light", canvas: "#FAFAF7" },
  { value: "dark", label: "Dark", canvas: "#0C0C0B" },
]

export type SettingsModule = "servers" | "appearance" | "goal" | "websearch" | "providers" | "about"

const MODULES: Array<{ id: SettingsModule; label: string; desc: string; icon: ComponentType<IconProps> }> = [
  { id: "servers", label: "Servers", desc: "Connections and credentials", icon: ServerIcon },
  { id: "appearance", label: "Appearance", desc: "Theme and color", icon: SunIcon },
  { id: "goal", label: "Goal review", desc: "Critic, judge and rounds", icon: SparkleIcon },
  { id: "websearch", label: "Web search", desc: "Default source and keys", icon: SearchIcon },
  { id: "providers", label: "Providers", desc: "API keys and custom providers", icon: KeyIcon },
  { id: "about", label: "About", desc: "Version and updates", icon: CircleIcon },
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
  onSignOut,
  onClose,
  initialModule,
  servers,
}: {
  mode: ThemeMode
  onSelectMode: (mode: ThemeMode) => void
  palette: PaletteID
  onSelectPalette: (palette: PaletteID) => void
  /** Kept for the mobile settings list; the active server's Disconnect lives in Servers. */
  onSignOut: () => void
  onClose: () => void
  initialModule?: SettingsModule
  servers?: {
    profiles: ServerProfile[]
    activeID: string | null
    onRename: (profile: ServerProfile, label: string) => void
    onDisconnect: (profile: ServerProfile) => void
    onRemove: (profile: ServerProfile) => void
    onAdd: () => void
  }
}) {
  const dialogRef = useModalFocus<HTMLDivElement>(onClose)
  const [module, setModule] = useState<SettingsModule>(initialModule ?? "appearance")
  // Mobile (<768px) is a master-detail flow: the dialog opens on the vertical
  // section list and shows only the selected section, with a back control.
  // Desktop keeps the two-pane layout and ignores this flag.
  const [mobileList, setMobileList] = useState(initialModule === undefined)

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

          {/* Mobile only: the bottom nav has no sign-out action, so it lives
              at the end of the settings list (the desktop options box keeps
              its own Sign out). Hidden in the detail view. */}
          <button
            type="button"
            onClick={onSignOut}
            className="mh-settings__signout"
            aria-label="Disconnect from the active server"
          >
            <LogOutIcon size={16} />
            Disconnect
          </button>

          <div className="mh-settings__content scroll-thin">
            {module === "servers" ? (
              servers ? (
                <ServersSection {...servers} />
              ) : null
            ) : module === "appearance" ? (
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
            ) : module === "about" ? (
              <AboutSection />
            ) : (
              <ProvidersSection />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function ServersSection({
  profiles,
  activeID,
  onRename,
  onDisconnect,
  onRemove,
  onAdd,
}: {
  profiles: ServerProfile[]
  activeID: string | null
  onRename: (profile: ServerProfile, label: string) => void
  onDisconnect: (profile: ServerProfile) => void
  onRemove: (profile: ServerProfile) => void
  onAdd: () => void
}) {
  const [renamingID, setRenamingID] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState("")
  const [removing, setRemoving] = useState<ServerProfile | null>(null)

  function startRename(profile: ServerProfile) {
    setRenamingID(profile.id)
    setRenameValue(profile.label)
  }

  function commitRename(profile: ServerProfile) {
    const next = renameValue.trim()
    if (next && next !== profile.label) onRename(profile, next)
    setRenamingID(null)
  }

  return (
    <section aria-labelledby="settings-servers">
      <div className="mh-srv-settings__head">
        <div>
          <h3 id="settings-servers" className="mh-settings__title">
            Servers
          </h3>
          <p className="mh-settings__desc">
            Each profile keeps its own URL and credential. One is connected at a time.
          </p>
        </div>
        <button type="button" className="mh-btn mh-btn--secondary mh-btn--sm" onClick={onAdd}>
          Add server
        </button>
      </div>

      <div className="mh-srv-settings__list">
        {profiles.map((profile) => {
          const active = profile.id === activeID
          return (
            <div key={profile.id} className="mh-srv-settings__row" aria-current={active ? "true" : undefined}>
              <ServerMonogram label={profile.label} active={active} />
              <div className="mh-server__body">
                {renamingID === profile.id ? (
                  <form
                    className="flex items-center gap-2"
                    onSubmit={(event) => {
                      event.preventDefault()
                      commitRename(profile)
                    }}
                  >
                    <input
                      className="mh-input h-9 min-h-0 flex-1"
                      aria-label={`Name for ${profile.label}`}
                      value={renameValue}
                      maxLength={64}
                      onChange={(event) => setRenameValue(event.target.value)}
                      autoFocus
                    />
                    <button type="submit" className="mh-btn mh-btn--secondary mh-btn--sm">
                      Save
                    </button>
                    <button
                      type="button"
                      className="mh-btn mh-btn--ghost mh-btn--sm"
                      onClick={() => setRenamingID(null)}
                    >
                      Cancel
                    </button>
                  </form>
                ) : (
                  <>
                    <span className="mh-server__name">{profile.label}</span>
                    <span className="mh-server__host">{new URL(profile.url).host}</span>
                  </>
                )}
              </div>
              {renamingID === profile.id ? null : (
                <>
                  <ServerStatus status={active ? "connected" : profile.expired ? "expired" : "saved"} />
                  <div className="mh-srv-settings__actions">
                    <button
                      type="button"
                      className="mh-srv-settings__action"
                      aria-label={`Rename ${profile.label}`}
                      title="Rename"
                      onClick={() => startRename(profile)}
                    >
                      <PencilIcon size={16} />
                    </button>
                    <button
                      type="button"
                      className="mh-srv-settings__action"
                      aria-label={`Disconnect ${profile.label}`}
                      title="Disconnect (keeps the profile)"
                      onClick={() => onDisconnect(profile)}
                    >
                      <LogOutIcon size={16} />
                    </button>
                    <button
                      type="button"
                      className="mh-srv-settings__action"
                      aria-label={`Remove ${profile.label}`}
                      title="Remove server"
                      onClick={() => setRemoving(profile)}
                    >
                      <TrashIcon size={16} />
                    </button>
                  </div>
                </>
              )}
            </div>
          )
        })}
      </div>

      <p className="mh-srv-settings__note">
        Disconnect clears this device&apos;s session but keeps the profile. Remove forgets the profile and
        revokes its device token when the server is reachable.
      </p>

      {removing && (
        <div className="fixed inset-0 z-[60] flex items-end justify-center mh-overlay md:items-center md:p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`Remove ${removing.label}`}
            className="pb-safe mh-dialog w-full rounded-b-none outline-none md:rounded-xl"
          >
            <h4 className="mh-dialog__title mh-heading-4">Remove server</h4>
            <p className="mh-body-sm text-ink-muted">
              Remove <span className="font-medium text-ink">{removing.label}</span> from this device?
              Sessions keep running on that server; you can add it again later.
            </p>
            <div className="mh-dialog__actions">
              <button type="button" className="mh-btn mh-btn--secondary" onClick={() => setRemoving(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="mh-btn mh-btn--danger"
                onClick={() => {
                  const profile = removing
                  setRemoving(null)
                  onRemove(profile)
                }}
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
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
