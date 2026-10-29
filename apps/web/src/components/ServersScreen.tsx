import { useEffect, useState } from "react"
import type { ServerProfile } from "../servers"
import { BrandMark } from "./BrandMark"
import { Deco } from "./Deco"
import { ChevronLeftIcon } from "./icons"
import {
  ServerAddRow,
  ServerForm,
  ServerMonogram,
  ServerRow,
  serverHost,
  type ServerFormSubmission,
} from "./ServerBits"

export interface ConnectingServer {
  label: string
  url: string
}

/**
 * The Servers screen: first run, saved list, add form, re-auth and the
 * connecting transition. It owns only presentation/validation; the root owns
 * profiles, clients and credentials.
 */
export function ServersScreen({
  profiles,
  activeID,
  initialUrl,
  busy,
  error,
  notice,
  connecting,
  reauthProfile,
  startAdding = false,
  draft = null,
  onSubmit,
  onSelect,
  onCancel,
  onCancelConnect,
}: {
  profiles: ServerProfile[]
  activeID: string | null
  initialUrl: string
  busy: boolean
  error: string | null
  notice: string | null
  connecting: ConnectingServer | null
  reauthProfile: ServerProfile | null
  startAdding?: boolean
  draft?: { url: string; label: string } | null
  onSubmit: (
    mode: "first-run" | "add" | "reauth",
    submission: ServerFormSubmission,
    profile?: ServerProfile,
  ) => void
  onSelect: (profile: ServerProfile) => void
  onCancel: () => void
  onCancelConnect: () => void
}) {
  const [adding, setAdding] = useState(startAdding)

  useEffect(() => {
    if (startAdding) setAdding(true)
  }, [startAdding])

  if (connecting) {
    return (
      <main className="mh-servers-screen">
        <div className="mh-servers-intro" aria-hidden="true">
          <Deco variant="blob" />
          <Deco variant="dots" />
        </div>
        <div className="mh-servers-aside">
          <div className="mh-srv-connecting">
            <Deco variant="blob" />
            <Deco variant="dots" />
            <div className="mh-srv-connecting__card" role="status">
              <ServerMonogram label={connecting.label} active />
              <h1 className="mh-srv-title">Connecting to {connecting.label}</h1>
              <p className="mh-srv-sub">{serverHost(connecting.url)}</p>
              <span className="mh-srv-spin" aria-hidden="true" />
              <p className="mh-srv-fine">This can take a few seconds.</p>
              <button type="button" className="mh-btn mh-btn--ghost mh-btn--sm" onClick={onCancelConnect}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      </main>
    )
  }

  const firstRun = profiles.length === 0
  const showReauth = reauthProfile !== null
  const showAdd = adding && !firstRun

  return (
    <main className="mh-servers-screen">
      <div className="mh-servers-intro">
        <Deco variant="blob" />
        <Deco variant="dots" />
        <div className="mh-brand">
          <BrandMark />
          <span className="mh-brand__name">MasterHand</span>
        </div>
        <p className="mh-micro mh-eyebrow">{firstRun ? "First run" : "Your workspace"}</p>
        <h1 className="mh-servers-display">
          {firstRun ? (
            <>
              Your agents,
              <br />
              one desk away.
            </>
          ) : (
            <>
              One desk.
              <br />
              Every server.
            </>
          )}
        </h1>
        <p className="mh-servers-lede">
          {firstRun
            ? "Connect your first server. Self-hosted, single-user — your data never leaves your machine."
            : "Connect to the MasterHand servers you own. One at a time, with each session kept exactly where you left it."}
        </p>
        <p className="mh-srv-quiet">Sessions keep running on the servers you are not viewing.</p>
      </div>

      <div className="mh-servers-aside">
        <section className="mh-servers-sheet">
          {notice ? (
            <p className="mh-srv-error" role="alert">
              <span className="mh-dot mh-dot--warning" aria-hidden="true" />
              {notice}
            </p>
          ) : null}
          {showReauth && reauthProfile ? (
            <>
              <button
                type="button"
                className="mh-btn mh-btn--ghost mh-btn--sm self-start"
                onClick={onCancel}
              >
                <ChevronLeftIcon size={14} />
                Servers
              </button>
              <ServerForm
                mode="reauth"
                profile={reauthProfile}
                busy={busy}
                error={error}
                onSubmit={(submission) => onSubmit("reauth", submission, reauthProfile)}
              />
            </>
          ) : firstRun ? (
            <ServerForm
              mode="first-run"
              initialUrl={draft?.url ?? initialUrl}
              initialLabel={draft?.label ?? ""}
              profiles={profiles}
              busy={busy}
              error={error}
              onSubmit={(submission) => onSubmit("first-run", submission)}
            />
          ) : showAdd ? (
            <>
              <button
                type="button"
                className="mh-btn mh-btn--ghost mh-btn--sm self-start"
                onClick={() => {
                  setAdding(false)
                  onCancel()
                }}
              >
                <ChevronLeftIcon size={14} />
                Servers
              </button>
              <ServerForm
                mode="add"
                initialUrl={draft?.url ?? ""}
                initialLabel={draft?.label ?? ""}
                profiles={profiles}
                busy={busy}
                error={error}
                onSubmit={(submission) => onSubmit("add", submission)}
                onCancel={() => {
                  setAdding(false)
                  onCancel()
                }}
              />
            </>
          ) : (
            <>
              <div className="mh-srv-sheet__head">
                <div>
                  <h2 className="mh-srv-title">Servers</h2>
                  <p className="mh-srv-sub">One connection at a time.</p>
                </div>
                <span className="mh-chip">
                  {profiles.length} saved
                </span>
              </div>
              <div className="mh-srv-list" data-testid="server-list">
                {profiles.map((profile) => (
                  <ServerRow
                    key={profile.id}
                    profile={profile}
                    active={profile.id === activeID}
                    status={profile.expired ? "expired" : "saved"}
                    onSelect={() => onSelect(profile)}
                    disabled={busy}
                  />
                ))}
              </div>
              <ServerAddRow
                onClick={() => {
                  onCancel()
                  setAdding(true)
                }}
              />
              <p className="mh-srv-note">
                Only the active server sends live updates. The others keep working.
              </p>
            </>
          )}
        </section>
        <p className="mh-srv-fine mh-servers-foot">Your data stays on your servers.</p>
      </div>
    </main>
  )
}
