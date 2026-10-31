import { useCallback, useEffect, useState } from "react"
import type { AgentActivityKind, AgentActivityPreferences } from "@masterhand/client-core"
import {
  notificationPermission,
  notificationsSupported,
  requestNotificationPermission,
  sendTestNotification,
  type NotificationPreferences,
} from "../notifications"

const KINDS: Array<{
  kind: AgentActivityKind
  label: string
  description: string
}> = [
  { kind: "finished", label: "Agent finished", description: "A run completes or goes idle." },
  { kind: "failed", label: "Agent failed", description: "A run ends with an error." },
  {
    kind: "permission",
    label: "Permission requests",
    description: "An agent needs approval to continue.",
  },
  { kind: "question", label: "Questions", description: "An agent asks you for input." },
]

function permissionCopy(
  permission: NotificationPermission | "unsupported",
  supported: boolean,
): string {
  if (!supported) {
    return window.isSecureContext === false
      ? "Notifications need HTTPS or localhost."
      : "This browser cannot show notifications."
  }
  if (permission === "granted") return "System permission granted"
  if (permission === "denied") return "Blocked in your browser or system settings"
  return "Permission required — allow notifications to start"
}

/**
 * Settings > Notifications: local OS alerts on this device. On by default for
 * the desktop shell (Electron grants the permission); in a browser the user
 * still has to approve the permission once. Only fires while the window is not
 * focused, so in-app banners keep owning the foreground.
 */
export function NotificationsSection({
  preferences,
  onChange,
}: {
  preferences: NotificationPreferences
  onChange: (preferences: NotificationPreferences) => void
}) {
  const supported = notificationsSupported()
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(() =>
    notificationPermission(),
  )
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const refreshPermission = useCallback(() => {
    setPermission(notificationPermission())
  }, [])

  useEffect(() => {
    refreshPermission()
    window.addEventListener("focus", refreshPermission)
    document.addEventListener("visibilitychange", refreshPermission)
    return () => {
      window.removeEventListener("focus", refreshPermission)
      document.removeEventListener("visibilitychange", refreshPermission)
    }
  }, [refreshPermission])

  const setEnabled = useCallback(
    async (on: boolean) => {
      setNotice(null)
      if (!on) {
        onChange({ ...preferences, enabled: false })
        return
      }
      if (!supported) {
        setNotice("Notifications are not available on this device.")
        return
      }
      setBusy(true)
      try {
        const allowed = await requestNotificationPermission()
        setPermission(notificationPermission())
        if (!allowed) {
          setNotice("Notifications are blocked. Allow them in your browser or system settings first.")
          return
        }
        onChange({ ...preferences, enabled: true })
      } finally {
        setBusy(false)
      }
    },
    [onChange, preferences, supported],
  )

  const setKind = useCallback(
    (kind: AgentActivityKind, value: boolean) => {
      const kinds: AgentActivityPreferences = { ...preferences.kinds, [kind]: value }
      onChange({ ...preferences, kinds })
    },
    [onChange, preferences],
  )

  const sendTest = useCallback(async () => {
    setNotice(null)
    setBusy(true)
    try {
      const allowed = await requestNotificationPermission()
      setPermission(notificationPermission())
      if (!allowed) {
        setNotice("Notifications are blocked. Allow them in your browser or system settings first.")
        return
      }
      sendTestNotification()
      setNotice("Test sent. Check the notification tray.")
    } finally {
      setBusy(false)
    }
  }, [])

  const needsPermission = supported && permission === "default" && preferences.enabled
  const blocked = supported && permission === "denied"

  return (
    <section aria-labelledby="settings-notifications">
      <h3 id="settings-notifications" className="mh-settings__title">
        Notifications
      </h3>
      <p className="mh-settings__desc">
        System alerts on this device when an agent finishes, fails, or needs you while MasterHand is
        in the background.
      </p>

      <div className="mt-4">
        <NotificationSwitch
          label="Agent activity"
          description={permissionCopy(permission, supported)}
          checked={preferences.enabled}
          disabled={busy}
          onChange={(value) => void setEnabled(value)}
        />
        {KINDS.map((item) => (
          <NotificationSwitch
            key={item.kind}
            label={item.label}
            description={item.description}
            checked={preferences.kinds[item.kind]}
            disabled={busy || !preferences.enabled}
            onChange={(value) => setKind(item.kind, value)}
          />
        ))}
      </div>

      {needsPermission && (
        <button
          type="button"
          className="mh-btn mh-btn--secondary mh-btn--sm mt-3"
          disabled={busy}
          onClick={() => void setEnabled(true)}
        >
          Allow notifications
        </button>
      )}

      {notice ? <p className="mh-caption mt-2 text-warning">{notice}</p> : null}
      {blocked && !notice ? (
        <p className="mh-caption mt-2 text-warning">
          Notifications are blocked. Allow them in your browser or system settings.
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className="mh-btn mh-btn--secondary mh-btn--sm"
          disabled={busy || !supported}
          onClick={() => void sendTest()}
        >
          Send test
        </button>
      </div>

      <p className="mh-caption mh-muted mt-4">
        Alerts stay silent while the MasterHand window is focused: the in-app banners already cover
        it. The desktop app keeps notifying while it runs, even minimized; a browser tab must stay
        open.
      </p>
    </section>
  )
}

function NotificationSwitch({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string
  description: string
  checked: boolean
  disabled: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-hairline py-3 first:border-t">
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink">{label}</p>
        <p className="mh-caption mh-muted mt-0.5">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
          checked ? "bg-accent" : "bg-hairline-strong"
        }`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full transition-transform ${
            checked ? "translate-x-4.5 bg-on-accent" : "translate-x-0.5 bg-surface"
          }`}
        />
      </button>
    </div>
  )
}
