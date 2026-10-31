import { PlusIcon } from "./icons"

/**
 * The Sessions header's new-session action: creates a session immediately in
 * the active workspace.
 */
export function NewSessionMenu({
  onCreate,
  creating,
  disabled,
}: {
  onCreate: () => void
  creating: boolean
  disabled: boolean
}) {
  return (
    <button
      type="button"
      onClick={onCreate}
      disabled={disabled || creating}
      aria-label="New session"
      title={disabled ? "Add a workspace first" : "Create a session"}
      className="mh-btn mh-btn--primary mh-btn--sm shrink-0 px-2.5"
    >
      <PlusIcon size={16} />
    </button>
  )
}
