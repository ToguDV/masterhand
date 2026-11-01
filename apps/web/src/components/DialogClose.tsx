import { XIcon } from "./icons"

/**
 * The top-right dismiss control shared by every dialog: a quiet icon instead
 * of a full "Cancel" button in the footer.
 */
export function DialogClose({
  onClose,
  disabled = false,
  label = "Close",
}: {
  onClose: () => void
  disabled?: boolean
  label?: string
}) {
  return (
    <button
      type="button"
      className="mh-dialog__action mh-dialog__close"
      aria-label={label}
      title={label}
      onClick={onClose}
      disabled={disabled}
    >
      <XIcon size={17} />
    </button>
  )
}
