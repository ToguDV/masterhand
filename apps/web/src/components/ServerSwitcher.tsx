import { useState, type ReactNode } from "react"
import { ChevronDownIcon, GearIcon, PlusIcon, ServerIcon, XIcon } from "./icons"
import { ServerAddRow, ServerMonogram, ServerRow, ServerStatusGlyph } from "./ServerBits"
import { useModalFocus } from "./useModalFocus"
import type { ServerProfile } from "../servers"

/**
 * In-app server switcher. Desktop: a footer chip with a popover. Mobile web: a
 * monogram in the top bar that opens a bottom sheet. Only the active server is
 * connected; choosing another remounts the authenticated tree.
 */
export function ServerSwitcher({
  profiles,
  activeProfile,
  variant,
  collapsed = false,
  onSwitch,
  onManage,
  onAdd,
}: {
  profiles: ServerProfile[]
  activeProfile: ServerProfile
  variant: "sidebar" | "mobile"
  collapsed?: boolean
  onSwitch: (profile: ServerProfile) => void
  onManage: () => void
  onAdd: () => void
}) {
  const [open, setOpen] = useState(false)

  const trigger =
    variant === "sidebar" ? (
      <button
        type="button"
        className={`mh-srv-chip ${collapsed ? "mh-srv-chip--rail" : ""}`}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Server: ${activeProfile.label}`}
        title={`${activeProfile.label} · ${activeProfile.url}`}
      >
        <ServerMonogram label={activeProfile.label} />
        <span className="mh-srv-chip__body">
          <span className="mh-srv-chip__name">{activeProfile.label}</span>
          <span className="mh-srv-chip__host">{new URL(activeProfile.url).host}</span>
        </span>
        <ChevronDownIcon size={14} />
      </button>
    ) : (
      <button
        type="button"
        className="mh-srv-phone__serverchip"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Server: ${activeProfile.label}`}
        title={activeProfile.label}
      >
        <ServerMonogram label={activeProfile.label} />
        <ServerStatusGlyph status="connected" />
      </button>
    )

  const list = (
    <div className="mh-srv-list" data-testid="server-switcher-list">
      {profiles.map((profile) => (
        <ServerRow
          key={profile.id}
          profile={profile}
          active={profile.id === activeProfile.id}
          status={profile.id === activeProfile.id ? "connected" : profile.expired ? "expired" : "saved"}
          onSelect={() => {
            setOpen(false)
            if (profile.id !== activeProfile.id) onSwitch(profile)
          }}
          disabled={profile.id === activeProfile.id}
        />
      ))}
    </div>
  )

  const actions = (
    <div className="mh-srv-pop__foot">
      <button type="button" className="mh-srv-pop__action" onClick={() => { setOpen(false); onAdd() }}>
        <PlusIcon size={14} />
        Add another server
      </button>
      <button type="button" className="mh-srv-pop__action" onClick={() => { setOpen(false); onManage() }}>
        <GearIcon size={14} />
        Manage servers
      </button>
    </div>
  )

  if (variant === "mobile") {
    return (
      <>
        {trigger}
        {open && (
          <div className="mh-srv-mobile-scrim" onClick={() => setOpen(false)}>
            <SwitcherDialog className="mh-srv-bottom-sheet" onClose={() => setOpen(false)}>
              <span className="mh-srv-bottom-sheet__grab" aria-hidden="true" />
              <div className="mh-srv-bottom-sheet__head">
                <div>
                  <h2 className="mh-srv-title">Servers</h2>
                  <p className="mh-srv-sub">One connection at a time.</p>
                </div>
                <button type="button" className="mh-srv-bottom-sheet__close" aria-label="Close servers" onClick={() => setOpen(false)}>
                  <XIcon size={16} />
                </button>
              </div>
              {list}
              <ServerAddRow onClick={() => { setOpen(false); onAdd() }} />
              <p className="mh-srv-note">Only the active server sends live updates.</p>
            </SwitcherDialog>
          </div>
        )}
      </>
    )
  }

  return (
    <div className={`mh-srv-switcher ${collapsed ? "mh-srv-switcher--rail" : ""}`}>
      {trigger}
      {open && (
        <>
          <div className="fixed inset-0 z-20" aria-hidden="true" onClick={() => setOpen(false)} />
          <SwitcherDialog className="mh-srv-pop" onClose={() => setOpen(false)}>
            <div className="mh-srv-sheet__head">
              <div>
                <h3 className="mh-srv-title">Servers</h3>
                <p className="mh-srv-sub">One connection at a time.</p>
              </div>
              <span className="mh-chip">{profiles.length} saved</span>
            </div>
            {list}
            {actions}
          </SwitcherDialog>
        </>
      )}
    </div>
  )
}

/** Small server glyph used by the Settings module empty state. */
export function ServerEmptyGlyph() {
  return <ServerIcon size={22} className="text-ink-faint" />
}

/**
 * Focus-trapped dialog surface for the switcher. Keeps Tab/Shift+Tab inside,
 * closes on Escape and restores the trigger focus on unmount.
 */
function SwitcherDialog({
  className,
  onClose,
  children,
}: {
  className: string
  onClose: () => void
  children: ReactNode
}) {
  const ref = useModalFocus<HTMLDivElement>(onClose)
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Servers"
      className={className}
      onClick={(event) => event.stopPropagation()}
    >
      {children}
    </div>
  )
}
