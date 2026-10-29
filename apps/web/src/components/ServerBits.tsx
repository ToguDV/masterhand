import { useEffect, useRef, useState } from "react"
import {
  MAX_SERVER_LABEL_LENGTH,
  MAX_SERVER_URL_LENGTH,
  browserOrigin,
  isMixedContentBlocked,
  isSameOrigin,
  normalizeServerUrl,
  serverMonogram,
  serverUrlErrorMessage,
} from "@masterhand/client-core"
import type { ServerProfile } from "../servers"
import { EyeIcon, EyeOffIcon, GlobeIcon, KeyIcon, PlusIcon, XIcon } from "./icons"

export type ServerConnectionStatus = "connected" | "saved" | "expired" | "connecting"

const STATUS_COPY: Record<ServerConnectionStatus, string> = {
  connected: "Connected",
  saved: "Saved",
  expired: "Expired",
  connecting: "Connecting",
}

/** Status glyph + text, following the approved animated-stats vocabulary. */
export function ServerStatus({
  status,
  className = "",
}: {
  status: ServerConnectionStatus
  className?: string
}) {
  return (
    <span className={`mh-server__meta ${className}`}>
      <span
        className={`mh-status mh-status--${status === "saved" ? "idle" : status}`}
        data-status={status}
        aria-hidden="true"
      />
      <span data-server-status>{STATUS_COPY[status]}</span>
    </span>
  )
}

/** Standalone glyph for compact chrome (header chip, rails). */
export function ServerStatusGlyph({ status }: { status: ServerConnectionStatus }) {
  return (
    <span
      className={`mh-status mh-status--${status === "saved" ? "idle" : status}`}
      data-status={status}
      title={STATUS_COPY[status]}
      aria-label={STATUS_COPY[status]}
      role="img"
    />
  )
}

export function ServerMonogram({
  label,
  active = false,
  className = "",
}: {
  label: string
  active?: boolean
  className?: string
}) {
  return (
    <span
      className={`mh-server__monogram ${active ? "is-active" : ""} ${className}`}
      aria-hidden="true"
    >
      {serverMonogram(label)}
    </span>
  )
}

export function serverHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** One saved server row (Servers screen, switcher and Settings > Servers). */
export function ServerRow({
  profile,
  active,
  status,
  onSelect,
  disabled = false,
}: {
  profile: ServerProfile
  active: boolean
  status: ServerConnectionStatus
  onSelect?: () => void
  disabled?: boolean
}) {
  const content = (
    <>
      <ServerMonogram label={profile.label} active={active} />
      <span className="mh-server__body">
        <span className="mh-server__name">{profile.label}</span>
        <span className="mh-server__host">{serverHost(profile.url)}</span>
      </span>
      <ServerStatus status={status} />
    </>
  )
  if (!onSelect) return <div className="mh-server">{content}</div>
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-current={active ? "true" : undefined}
      data-server-id={profile.id}
      className="mh-server"
    >
      {content}
    </button>
  )
}

export interface ServerFormSubmission {
  url: string
  label: string
  password: string
}

/**
 * URL + optional name + password. Used for the first run, adding a server and
 * re-authenticating a saved/expired profile.
 */
export function ServerForm({
  mode,
  initialUrl,
  initialLabel = "",
  profile,
  profiles,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  mode: "first-run" | "add" | "reauth"
  initialUrl?: string
  initialLabel?: string
  profile?: ServerProfile | null
  profiles?: ServerProfile[]
  busy: boolean
  error: string | null
  onSubmit: (submission: ServerFormSubmission) => void
  onCancel?: () => void
}) {
  const [url, setUrl] = useState(initialUrl ?? "")
  const [label, setLabel] = useState(initialLabel)
  const [password, setPassword] = useState("")
  const [reveal, setReveal] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const passwordRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    // Re-auth: the URL is fixed and the password is the only field.
    if (mode === "reauth") passwordRef.current?.focus()
  }, [mode])

  const showUrl = mode !== "reauth"
  const showName = mode !== "reauth"
  // A password manager fills for the page's origin. Only let it do so when the
  // credential target is the serving origin; a remote add/re-auth must stay off
  // or the manager could offer the serving origin's password for another server.
  const credentialTarget = mode === "reauth" ? (profile?.url ?? "") : url || initialUrl || ""
  const passwordAutoComplete = isSameOrigin(credentialTarget, browserOrigin())
    ? "current-password"
    : "off"
  const title =
    mode === "first-run"
      ? "Connect your first server"
      : mode === "reauth"
        ? `Reconnect to ${profile?.label ?? "server"}`
        : "Add a server"
  const subtitle =
    mode === "first-run"
      ? "Self-hosted, single-user. Your agents never leave your machine."
      : mode === "reauth"
        ? "The saved session expired. Enter this server's password again."
        : "URL, name and password. Each server keeps its own credential."
  const submitLabel = mode === "reauth" ? "Reconnect" : "Connect"

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (busy) return
    setLocalError(null)

    let normalizedUrl = profile?.url ?? ""
    if (showUrl) {
      const normalized = normalizeServerUrl(url, { allowInsecureOrigin: browserOrigin() })
      if (!normalized.ok) {
        setLocalError(serverUrlErrorMessage(normalized.error))
        return
      }
      normalizedUrl = normalized.server.url
      if (isMixedContentBlocked(normalizedUrl)) {
        setLocalError(
          "This page is served over https and cannot reach an http server. Use https:// for remote servers.",
        )
        return
      }
      if (
        mode === "add" &&
        (profiles ?? []).some((item) => item.url === normalizedUrl)
      ) {
        setLocalError("This server is already saved.")
        return
      }
    }
    if (!password) {
      setLocalError("Enter the password")
      return
    }
    onSubmit({
      url: normalizedUrl,
      label: label.trim().slice(0, MAX_SERVER_LABEL_LENGTH),
      password,
    })
  }

  return (
    <form className="mh-srv-form" onSubmit={handleSubmit} noValidate>
      <div>
        <h3 className="mh-srv-title">{title}</h3>
        <p className="mh-srv-sub">{subtitle}</p>
      </div>
      {showUrl && (
        <div className="mh-srv-field">
          <label className="mh-label" htmlFor="server-url">
            Server URL
          </label>
          <div className="mh-field-icon">
            <GlobeIcon size={16} className="mh-field-icon__lead" />
            <input
              id="server-url"
              className="mh-input"
              type="url"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              maxLength={MAX_SERVER_URL_LENGTH}
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://masterhand.example.com"
              required
            />
          </div>
        </div>
      )}
      {showName && (
        <div className="mh-srv-field">
          <label className="mh-label" htmlFor="server-name">
            Name <span className="mh-srv-field__hint">(optional)</span>
          </label>
          <input
            id="server-name"
            className="mh-input"
            type="text"
            maxLength={MAX_SERVER_LABEL_LENGTH}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="Home"
          />
        </div>
      )}
      <div className="mh-srv-field">
        <label className="mh-label" htmlFor="password">
          Password
        </label>
        <div className="mh-field-icon">
          <KeyIcon size={16} className="mh-field-icon__lead" />
          <input
            ref={passwordRef}
            id="password"
            className="mh-input mh-input--has-end"
            type={reveal ? "text" : "password"}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete={passwordAutoComplete}
            aria-invalid={Boolean(localError || error)}
            required
          />
          <button
            type="button"
            className="mh-field-icon__end"
            onClick={() => setReveal((value) => !value)}
            aria-label={reveal ? "Hide password" : "Show password"}
            title={reveal ? "Hide password" : "Show password"}
          >
            {reveal ? <EyeOffIcon size={16} /> : <EyeIcon size={16} />}
          </button>
        </div>
      </div>
      {(localError || error) && (
        <p className="mh-srv-error" role="alert">
          <span className="mh-dot mh-dot--danger" aria-hidden="true" />
          {localError ?? error}
        </p>
      )}
      <button
        type="submit"
        className="mh-btn mh-btn--primary"
        disabled={busy || password.length === 0 || (showUrl && url.trim().length === 0)}
      >
        {busy ? "Connecting…" : submitLabel}
      </button>
      <p className="mh-srv-fine">
        {mode === "reauth"
          ? "Each server keeps its own credential. This device stores a revocable token."
          : "Your password is sent only to this server. This device remembers the session."}
      </p>
      {onCancel && (
        <button type="button" className="mh-btn mh-btn--ghost mh-btn--sm" onClick={onCancel}>
          Cancel
        </button>
      )}
    </form>
  )
}

export function ServerAddRow({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="mh-server__add" onClick={onClick}>
      <span className="mh-server__plus" aria-hidden="true">
        <PlusIcon size={14} />
      </span>
      <span>Add another server</span>
    </button>
  )
}

export function ServerSheetClose({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="mh-srv-bottom-sheet__close" aria-label="Close servers" onClick={onClick}>
      <XIcon size={16} />
    </button>
  )
}
