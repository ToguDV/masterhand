import { Deco } from "./Deco"

/**
 * Placeholder main view for the Board section. The kanban board itself is not
 * built yet: selecting the section swaps the main column to this empty state
 * while sessions keep working untouched.
 */
export function BoardView() {
  return (
    <div className="relative flex flex-1 flex-col items-center justify-center gap-5 p-6">
      <div className="mh-empty w-full max-w-lg border-0 bg-transparent">
        <Deco variant="blob" style={{ top: -80, right: -80, width: 280, height: 260 }} />
        <Deco variant="dots" style={{ bottom: -12, left: -20 }} />
        <h3 className="mh-heading-2">Board</h3>
        <p className="mh-empty__body mh-body-sm">Kanban board coming soon.</p>
      </div>
    </div>
  )
}
