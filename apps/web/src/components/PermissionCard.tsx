import { formatRelative, type Permission, type PermissionResponse } from "@masterhand/client-core"

export interface AnsweredPermission {
  permission: Permission
  response: PermissionResponse
  at: number
}

function actionLabel(response: PermissionResponse): string {
  if (response === "always") return "Always allowed"
  if (response === "reject") return "Rejected"
  return "Allowed once"
}

/**
 * Permission requests render inline in the transcript, inside the agent turn
 * that raised them — never as a modal (DESIGN.md, Conversation). Once answered
 * the card collapses to a quiet caption row kept as history.
 */
export function PermissionCard({
  permission,
  busy,
  onRespond,
}: {
  permission: Permission
  busy: boolean
  onRespond: (response: PermissionResponse) => void
}) {
  const resources = permission.resources.join(", ")
  const command = typeof permission.metadata?.command === "string" ? permission.metadata.command : null

  return (
    <div className="mh-permission" data-testid="permission-card">
      <div className="mh-permission__head">
        <span className="mh-dot mh-dot--busy" />
        <h3 className="mh-heading-4">Permission requested</h3>
      </div>
      <p className="mh-body-sm mh-permission__context">
        opencode wants to run <span className="mh-mono-sm" data-testid="permission-kind">{permission.action}</span>
        {resources && (
          <>
            {" · "}
            <span className="mh-mono-sm" data-testid="permission-patterns">{resources}</span>
          </>
        )}
      </p>
      {command && (
        <div className="mh-code">
          <div className="mh-code__header">{permission.action}</div>
          <pre>{command}</pre>
        </div>
      )}
      <div className="mh-permission__actions">
        <button
          type="button"
          className="mh-btn mh-btn--primary"
          disabled={busy}
          onClick={() => onRespond("once")}
        >
          Allow once
        </button>
        <button
          type="button"
          className="mh-btn mh-btn--secondary"
          disabled={busy}
          onClick={() => onRespond("always")}
        >
          Always allow
        </button>
        <button
          type="button"
          className="mh-btn mh-btn--danger"
          disabled={busy}
          onClick={() => onRespond("reject")}
        >
          Reject
        </button>
      </div>
    </div>
  )
}

/** Resolved permissions stay in the flow as a caption row. */
export function PermissionResolved({ entry }: { entry: AnsweredPermission }) {
  return (
    <div className="mh-permission is-resolved" data-testid="permission-resolved">
      <span className={`mh-dot ${entry.response === "reject" ? "mh-dot--danger" : "mh-dot--connected"}`} />
      <span>
        {actionLabel(entry.response)} · {formatRelative(entry.at)}
      </span>
    </div>
  )
}
