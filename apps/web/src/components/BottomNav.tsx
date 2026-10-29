import type { ComponentType } from "react"
import { ChatBubbleIcon, ClockIcon, GearIcon, KanbanIcon, type IconProps } from "./icons"

/** Home sections, shared by the desktop sidebar and the mobile bottom nav. */
type HomeSection = "sessions" | "board" | "scheduler"

type SectionItem = {
  id: HomeSection
  label: string
  icon: ComponentType<IconProps>
}

const SECTIONS: SectionItem[] = [
  { id: "sessions", label: "Sessions", icon: ChatBubbleIcon },
  { id: "board", label: "Board", icon: KanbanIcon },
  { id: "scheduler", label: "Scheduler", icon: ClockIcon },
]

/**
 * Mobile web (<768px) primary navigation, mirroring the React Native app: the
 * home sections plus Settings, pinned above the bottom safe area. Settings is
 * an action (it opens the settings surface), never an active tab. The bar is
 * home chrome only: an open chat takes over the screen and its back control
 * returns to the section.
 */
export function BottomNav({
  section,
  onSelectSection,
  onOpenSettings,
}: {
  section: HomeSection
  onSelectSection: (section: HomeSection) => void
  onOpenSettings: () => void
}) {
  return (
    <nav
      aria-label="Main navigation"
      className="shrink-0 border-t border-hairline bg-canvas pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <div className="flex items-stretch px-1">
        {SECTIONS.map((item) => {
          const Icon = item.icon
          const active = section === item.id
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectSection(item.id)}
              aria-current={active ? "page" : undefined}
              className="flex min-h-[52px] flex-1 flex-col items-center justify-center gap-[3px] rounded-sm py-1 text-ink-muted"
            >
              <span
                className={`flex h-[26px] min-w-11 items-center justify-center rounded-full ${
                  active ? "bg-accent-soft text-accent" : ""
                }`}
              >
                <Icon size={20} />
              </span>
              <span
                className={`text-xs leading-none ${active ? "font-semibold text-accent" : "font-medium"}`}
              >
                {item.label}
              </span>
            </button>
          )
        })}

        <button
          type="button"
          onClick={onOpenSettings}
          className="flex min-h-[52px] flex-1 flex-col items-center justify-center gap-[3px] rounded-sm py-1 text-ink-muted"
        >
          <span className="flex h-[26px] min-w-11 items-center justify-center rounded-full">
            <GearIcon size={20} />
          </span>
          <span className="text-xs font-medium leading-none">Settings</span>
        </button>
      </div>
    </nav>
  )
}
