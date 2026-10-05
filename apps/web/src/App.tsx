import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  ApiError,
  createEventHandler,
  formIsQuestion,
  invalidateOnReconnect,
  reconcileForms,
  reconcilePermissions,
  useBffStatus,
  useEventStream,
  useSessionDirectories,
  useSessions,
  useSessionStatuses,
  useWorkspaces,
  type CreateWorkspaceInput,
  type FormAnswer,
  type FormInfo,
  type Permission,
  type PermissionResponse,
} from "@masterhand/client-core"
import { client } from "./client"
import { AddWorkspaceDialog } from "./components/AddWorkspaceDialog"
import { AuditSheet, AuditTrigger } from "./components/AuditPanel"
import { BrandMark } from "./components/BrandMark"
import { ChatView } from "./components/ChatView"
import { ChoiceModal } from "./components/ChoiceModal"
import { Deco } from "./components/Deco"
import { Login } from "./components/Login"
import { PreviewSheet, PreviewTrigger } from "./components/PreviewPanel"
import { RemoveSessionDialog } from "./components/RemoveSessionDialog"
import { RemoveWorkspaceDialog } from "./components/RemoveWorkspaceDialog"
import { RunSheet, RunTrigger } from "./components/RunPanel"
import { SessionList } from "./components/SessionList"
import { SessionToolbar } from "./components/SessionToolbar"
import { ThemeToggle } from "./components/ThemeToggle"
import { useToast } from "./components/Toast"
import { ArrowLeftIcon, ChevronLeftIcon, EllipsisIcon, MenuIcon } from "./components/icons"
import type { AnsweredPermission } from "./components/PermissionCard"

const WORKSPACE_STORAGE_KEY = "masterhand.workspace"
const AUTO_ACCEPT_STORAGE_KEY = "masterhand.autoAcceptSessions"

function initialWorkspaceID(): string | null {
  const fromUrl = new URLSearchParams(window.location.search).get("workspace")
  if (fromUrl) return fromUrl
  try {
    return window.localStorage.getItem(WORKSPACE_STORAGE_KEY)
  } catch {
    return null
  }
}

function loadAutoAcceptSessions(): string[] {
  try {
    const raw = window.localStorage.getItem(AUTO_ACCEPT_STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []
  } catch {
    return []
  }
}

export default function App() {
  const queryClient = useQueryClient()
  const toast = useToast()
  const [authed, setAuthed] = useState<boolean | null>(null)
  const [statusFailed, setStatusFailed] = useState(false)
  // Read inside the status effect without re-running it: a stale 401 from
  // before login must not sign the user out after a successful login.
  const authedRef = useRef(authed)
  authedRef.current = authed
  const [sessionID, setSessionID] = useState<string | null>(
    () => new URLSearchParams(window.location.search).get("session"),
  )
  const [workspaceID, setWorkspaceID] = useState<string | null>(initialWorkspaceID)
  const [addingWorkspace, setAddingWorkspace] = useState(false)
  const [removeWorkspaceID, setRemoveWorkspaceID] = useState<string | null>(null)
  const [removingWorkspace, setRemovingWorkspace] = useState(false)
  const [removeSessionID, setRemoveSessionID] = useState<string | null>(null)
  const [removingSession, setRemovingSession] = useState(false)
  const [connected, setConnected] = useState(false)
  const [permissions, setPermissions] = useState<Permission[]>([])
  const [answeredPermissions, setAnsweredPermissions] = useState<AnsweredPermission[]>([])
  const [respondingPermissionID, setRespondingPermissionID] = useState<string | null>(null)
  const [forms, setForms] = useState<FormInfo[]>([])
  const [answeredForms, setAnsweredForms] = useState<Array<{ form: FormInfo; answer: FormAnswer }>>([])
  const [busyFormID, setBusyFormID] = useState<string | null>(null)
  const [dismissedChoiceFormIDs, setDismissedChoiceFormIDs] = useState<string[]>([])
  const [creating, setCreating] = useState(false)
  const [banner, setBanner] = useState<string | null>(null)
  const [autoAcceptSessions, setAutoAcceptSessions] = useState<string[]>(loadAutoAcceptSessions)
  const [panel, setPanel] = useState<"audit" | "run" | "preview" | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)

  // Mirrors for the memoized event handler: it must see the latest values
  // without being recreated (which would resubscribe the stream).
  const autoAcceptSessionsRef = useRef(autoAcceptSessions)
  autoAcceptSessionsRef.current = autoAcceptSessions
  const answeringRef = useRef(new Set<string>())
  const formsRef = useRef(forms)
  formsRef.current = forms
  // Set when the user switches workspace: drop the open session and open the
  // new workspace's most recent one once its session list arrives.
  const pendingWorkspaceAutoOpenRef = useRef(false)

  /** Answers a permission request automatically ("once", reversible). */
  const answerAuto = useCallback(async (permission: Permission) => {
    if (answeringRef.current.has(permission.id)) return
    answeringRef.current.add(permission.id)
    try {
      await client.api.respondPermission(permission.sessionID, permission.id, "once")
      setPermissions((prev) => prev.filter((item) => item.id !== permission.id))
      // Auto-answers stay in the transcript as resolved history.
      setAnsweredPermissions((prev) =>
        [...prev.filter((entry) => entry.permission.id !== permission.id), { permission, response: "once" as const, at: Date.now() }].slice(-50),
      )
    } catch {
      setBanner("Could not answer the permission request")
    } finally {
      answeringRef.current.delete(permission.id)
    }
  }, [])
  const answerAutoRef = useRef(answerAuto)
  answerAutoRef.current = answerAuto

  const statusQuery = useBffStatus(client, authed ? 15_000 : false)

  useEffect(() => {
    if (statusQuery.isSuccess) {
      setStatusFailed(false)
      setAuthed(true)
    } else if (statusQuery.error) {
      if (statusQuery.error instanceof ApiError) {
        if (statusQuery.error.status === 401) {
          setStatusFailed(false)
          setAuthed(false)
        } else if (authedRef.current === null) {
          // Any other HTTP error (5xx, unexpected 4xx): terminal, so show a
          // retry screen instead of leaving the app on "Loading…" forever.
          setStatusFailed(true)
        }
      } else {
        setStatusFailed(false)
        setBanner("Could not reach the MasterHand server")
        setAuthed(false)
      }
    }
  }, [statusQuery.isSuccess, statusQuery.error])

  const handleEvent = useMemo(
    () =>
      createEventHandler(queryClient, {
        onPermission: (permission) => {
          if (autoAcceptSessionsRef.current.includes(permission.sessionID)) {
            void answerAutoRef.current(permission)
            return
          }
          setPermissions((prev) => (prev.some((item) => item.id === permission.id) ? prev : [...prev, permission]))
        },
        onPermissionReplied: (permissionID) => {
          // Answered elsewhere: the event carries no response, so no resolved
          // row is recorded (the tool card still reflects the outcome).
          setPermissions((prev) => prev.filter((item) => item.id !== permissionID))
        },
        onForm: (form) =>
          setForms((prev) => (prev.some((item) => item.id === form.id) ? prev : [...prev, form])),
        onFormSettled: (formID) => {
          setForms((prev) => prev.filter((item) => item.id !== formID))
          setDismissedChoiceFormIDs((prev) => prev.filter((id) => id !== formID))
        },
        onSessionError: (message) => setBanner(message),
        onServerConnected: () => void syncPendingRef.current(),
      }),
    [queryClient],
  )

  const openSession = useCallback((id: string | null) => {
    setSessionID(id)
    if (!id) setDrawerOpen(false)
    const url = new URL(window.location.href)
    if (id) url.searchParams.set("session", id)
    else url.searchParams.delete("session")
    window.history.replaceState(null, "", url)
  }, [])

  const selectWorkspace = useCallback((id: string | null) => {
    setWorkspaceID(id)
    const url = new URL(window.location.href)
    if (id) url.searchParams.set("workspace", id)
    else url.searchParams.delete("workspace")
    window.history.replaceState(null, "", url)
    try {
      if (id) window.localStorage.setItem(WORKSPACE_STORAGE_KEY, id)
      else window.localStorage.removeItem(WORKSPACE_STORAGE_KEY)
    } catch {
      // storage may be unavailable (private mode)
    }
  }, [])

  /**
   * Switching workspace must not keep showing a session from the previous one
   * (its chat, run and preview). Drop the open session immediately and let the
   * reconciliation effect open the new workspace's most recent session once its
   * list arrives.
   */
  const switchWorkspace = useCallback(
    (id: string | null) => {
      if (id === workspaceID) return
      if (id !== null) pendingWorkspaceAutoOpenRef.current = true
      selectWorkspace(id)
      openSession(null)
    },
    [workspaceID, selectWorkspace, openSession],
  )

  const workspacesQuery = useWorkspaces(client, authed === true)
  const workspaces = workspacesQuery.data ?? []

  useEffect(() => {
    if (!workspacesQuery.data) return
    if (workspaceID && workspacesQuery.data.some((workspace) => workspace.id === workspaceID)) return
    selectWorkspace(workspacesQuery.data[0]?.id ?? null)
  }, [workspacesQuery.data, workspaceID, selectWorkspace])

  const workspace = workspaces.find((item) => item.id === workspaceID) ?? null
  const workspacePath = workspace?.path ?? null
  const directoriesQuery = useSessionDirectories(client, authed === true, workspaceID)
  const sessionsQuery = useSessions(client, authed === true, 10_000, workspaceID)

  // `permission.asked` and `form.created` events are lost while disconnected
  // and never replayed. On connect (and once workspaces load) reconcile against
  // opencode, which exposes pending permissions and forms per directory
  // (workspace folder + worktrees).
  const syncPending = useCallback(async () => {
    const directories = directoriesQuery.data ?? (workspacePath ? [workspacePath] : [])
    if (directories.length === 0) return

    // A directory that fails to answer must not look like "nothing pending":
    // it stays out of the covered set, so its live state is kept instead of
    // pruned. Permissions and forms are fetched together so one slow endpoint
    // cannot make the other look abandoned.
    type DirectorySnapshot = { directory: string; permissions: Permission[]; forms: FormInfo[] }
    const results = await Promise.all(
      directories.map(async (directory): Promise<DirectorySnapshot | null> => {
        try {
          const [permissions, forms] = await Promise.all([
            client.api.permissions(directory),
            client.api.pendingForms(directory),
          ])
          return { directory, permissions, forms }
        } catch {
          return null
        }
      }),
    )
    const answered = results.filter((result): result is DirectorySnapshot => result !== null)
    if (answered.length === 0) return

    const covered = new Set(
      (sessionsQuery.data ?? [])
        .filter((session) => answered.some((result) => result.directory === session.location.directory))
        .map((session) => session.id),
    )
    setPermissions((prev) =>
      reconcilePermissions(prev, answered.flatMap((result) => result.permissions), covered),
    )
    setForms((prev) => reconcileForms(prev, answered.flatMap((result) => result.forms), covered))
  }, [client, directoriesQuery.data, workspacePath, sessionsQuery.data])
  const syncPendingRef = useRef(syncPending)
  syncPendingRef.current = syncPending

  const handleConnect = useCallback(() => {
    invalidateOnReconnect(queryClient)
    void syncPending()
  }, [queryClient, syncPending])

  useEventStream(client, {
    enabled: authed === true,
    onEvent: handleEvent,
    onConnectionChange: setConnected,
    onConnect: handleConnect,
  })

  useEffect(() => {
    if (authed !== true || !workspacesQuery.data) return
    void syncPending()
  }, [authed, workspacesQuery.data, syncPending])

  useEffect(() => {
    try {
      window.localStorage.setItem(AUTO_ACCEPT_STORAGE_KEY, JSON.stringify(autoAcceptSessions))
    } catch {
      // storage may be unavailable (private mode)
    }
  }, [autoAcceptSessions])

  // Drain the queue for sessions with auto-accept on. This also covers pending
  // requests recovered on reconnect/reload (they never arrive as events).
  useEffect(() => {
    if (autoAcceptSessions.length === 0 || permissions.length === 0) return
    for (const permission of permissions) {
      if (autoAcceptSessions.includes(permission.sessionID)) void answerAuto(permission)
    }
  }, [autoAcceptSessions, permissions, answerAuto])

  const toggleAutoAccept = useCallback((id: string, on: boolean) => {
    setAutoAcceptSessions((prev) =>
      on ? (prev.includes(id) ? prev : [...prev, id]) : prev.filter((item) => item !== id),
    )
  }, [])

  useEffect(() => {
    if (authed !== true) return
    function refresh(): void {
      if (document.visibilityState !== "visible") return
      void queryClient.invalidateQueries({ queryKey: ["messages"] })
      void queryClient.invalidateQueries({ queryKey: ["statuses"] })
      void queryClient.invalidateQueries({ queryKey: ["sessions"] })
    }
    document.addEventListener("visibilitychange", refresh)
    window.addEventListener("online", refresh)
    return () => {
      document.removeEventListener("visibilitychange", refresh)
      window.removeEventListener("online", refresh)
    }
  }, [authed, queryClient])

  const statusesQuery = useSessionStatuses(client, authed === true, connected)

  useEffect(() => {
    if (sessionsQuery.error instanceof ApiError && sessionsQuery.error.status === 401) setAuthed(false)
  }, [sessionsQuery.error])

  const sessions = useMemo(
    () => [...(sessionsQuery.data ?? [])].sort((a, b) => b.time.updated - a.time.updated),
    [sessionsQuery.data],
  )
  const statuses = statusesQuery.data ?? {}
  const selected = sessions.find((session) => session.id === sessionID) ?? null
  const parentSessionID = selected?.parentID ?? null
  const busy = sessionID ? statuses[sessionID]?.type === "busy" : false

  // The open session belongs to one workspace. `switchWorkspace` drops it and
  // sets this flag; once the new workspace's session list is available, open
  // its most recent session instead of leaving another workspace's chat (and
  // its preview and run state) on screen.
  useEffect(() => {
    if (!pendingWorkspaceAutoOpenRef.current) return
    if (!sessionsQuery.isSuccess) return
    pendingWorkspaceAutoOpenRef.current = false
    const next = sessions[0]?.id ?? null
    if (next !== sessionID) openSession(next)
  }, [sessionsQuery.isSuccess, sessions, sessionID, openSession])

  // Questions raised in another session still block their agents: surface them
  // as the choice-modal (the first not dismissed, so dismissing one reveals the
  // next). Once every one is dismissed, the info banner stays as a fallback.
  const otherForms = forms.filter((form) => formIsQuestion(form) && form.sessionID !== sessionID)
  const choiceForm = otherForms.find((form) => !dismissedChoiceFormIDs.includes(form.id)) ?? null
  const waitingForm = choiceForm ?? otherForms[0] ?? null
  // A permission raised in another session is invisible in the transcript: one
  // banner per affected session keeps it reachable.
  const otherPermissionSessions = [
    ...new Set(permissions.filter((permission) => permission.sessionID !== sessionID).map((p) => p.sessionID)),
  ]

  const handleLogout = useCallback(async () => {
    await client.auth.logout().catch(() => {})
    queryClient.clear()
    setPermissions([])
    setAnsweredPermissions([])
    setForms([])
    setAnsweredForms([])
    setPanel(null)
    setMenuOpen(false)
    setDrawerOpen(false)
    setAuthed(false)
    openSession(null)
  }, [queryClient, openSession])

  async function createSession(isolated: boolean) {
    if (!workspaceID) {
      setBanner("Add a workspace first")
      return
    }
    setCreating(true)
    setBanner(null)
    try {
      const session = await client.api.sessions.create(workspaceID, { isolated })
      void queryClient.invalidateQueries({ queryKey: ["sessions"] })
      void queryClient.invalidateQueries({ queryKey: ["directories"] })
      openSession(session.id)
    } catch {
      setBanner("Could not create the session")
    } finally {
      setCreating(false)
    }
  }

  async function confirmRemoveSession() {
    const id = removeSessionID
    if (!workspaceID || !id) return
    setRemovingSession(true)
    try {
      await client.api.sessions.remove(workspaceID, id)
      if (sessionID === id) openSession(null)
      void queryClient.invalidateQueries({ queryKey: ["sessions"] })
      void queryClient.invalidateQueries({ queryKey: ["directories"] })
      toast("✓ Session deleted")
      setRemoveSessionID(null)
    } catch {
      setBanner("Could not delete the session")
    } finally {
      setRemovingSession(false)
    }
  }

  async function addWorkspace(input: CreateWorkspaceInput) {
    const created = await client.workspaces.create(input)
    await queryClient.invalidateQueries({ queryKey: ["workspaces"] })
    switchWorkspace(created.id)
    setAddingWorkspace(false)
  }

  async function confirmRemoveWorkspace(deleteFiles: boolean) {
    const id = removeWorkspaceID
    if (!id) return
    setRemovingWorkspace(true)
    try {
      await client.workspaces.remove(id, { deleteFiles })
      if (workspaceID === id) selectWorkspace(null)
      await queryClient.invalidateQueries({ queryKey: ["workspaces"] })
      setRemoveWorkspaceID(null)
    } catch {
      setBanner("Could not remove the workspace")
    } finally {
      setRemovingWorkspace(false)
    }
  }

  async function respondPermission(permission: Permission, response: PermissionResponse) {
    setRespondingPermissionID(permission.id)
    try {
      // The session id resolves the request regardless of the active workspace.
      await client.api.respondPermission(permission.sessionID, permission.id, response)
      setPermissions((prev) => prev.filter((item) => item.id !== permission.id))
      // Keep the answered request so it renders as resolved history inline.
      setAnsweredPermissions((prev) =>
        [...prev.filter((entry) => entry.permission.id !== permission.id), { permission, response, at: Date.now() }].slice(-50),
      )
    } catch {
      // Keep the inline card so the user can retry.
      setBanner("Could not answer the permission request")
    } finally {
      setRespondingPermissionID(null)
    }
  }

  async function respondForm(form: FormInfo, answer: FormAnswer) {
    setBusyFormID(form.id)
    setBanner(null)
    try {
      // The form id resolves the question regardless of the active workspace.
      await client.api.respondForm(form.sessionID, form.id, answer)
      setForms((prev) => prev.filter((item) => item.id !== form.id))
      setDismissedChoiceFormIDs((prev) => prev.filter((id) => id !== form.id))
      // Keep the local answer so the inline card can render it read-only.
      setAnsweredForms((prev) =>
        [...prev.filter((entry) => entry.form.id !== form.id), { form, answer }].slice(-50),
      )
    } catch {
      setBanner("Could not answer the question")
    } finally {
      setBusyFormID(null)
    }
  }

  async function cancelForm(form: FormInfo) {
    setBusyFormID(form.id)
    try {
      await client.api.cancelForm(form.sessionID, form.id)
      setForms((prev) => prev.filter((item) => item.id !== form.id))
      setDismissedChoiceFormIDs((prev) => prev.filter((id) => id !== form.id))
    } catch {
      setBanner("Could not dismiss the question")
    } finally {
      setBusyFormID(null)
    }
  }

  if (statusFailed) {
    return (
      <main className="mh-login">
        <Deco variant="blob" />
        <Deco variant="dots" />
        <div className="mh-login-card">
          <div className="mh-brand">
            <BrandMark />
            <span className="mh-brand__name">MasterHand</span>
          </div>
          <p className="mh-body-sm text-ink-muted">
            The server answered with an error. Check the server logs and try again.
          </p>
          <button
            type="button"
            onClick={() => {
              setStatusFailed(false)
              void statusQuery.refetch()
            }}
            className="mh-btn mh-btn--primary w-full"
          >
            Retry
          </button>
        </div>
      </main>
    )
  }

  if (authed === null) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-canvas">
        <p className="animate-pulse text-sm text-ink-muted">Loading…</p>
      </main>
    )
  }

  if (!authed) {
    return <Login onSuccess={() => setAuthed(true)} />
  }

  // The session list is always the mobile drawer; the main column (empty state
  // or chat) stays visible so the composer's workspace/new-session bar is
  // reachable without a session. On desktop the aside docks beside it.
  const asideClass = [
    "min-h-0 flex-col border-r border-hairline bg-canvas md:flex md:w-[272px] md:shrink-0",
    "hidden",
    drawerOpen
      ? "max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-40 max-md:flex max-md:w-[85vw] max-md:max-w-[272px] max-md:shadow-elev3"
      : "",
  ].join(" ")

  return (
    <div className="flex h-dvh flex-col bg-canvas text-ink">
      <header className="flex h-14 shrink-0 items-center gap-1 border-b border-hairline px-2 md:px-4">
        {sessionID && (
          <button
            type="button"
            onClick={() => openSession(null)}
            className="mh-btn mh-btn--quiet md:hidden"
            aria-label="Back"
          >
            <ChevronLeftIcon size={18} />
          </button>
        )}
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          className="mh-btn mh-btn--quiet md:hidden"
          aria-label="Sessions"
        >
          <MenuIcon size={18} />
        </button>
        <h1 className="min-w-0 flex-1 truncate px-1 text-[15px] font-medium">
          {selected ? selected.title || "Untitled" : "MasterHand"}
        </h1>
        <span
          className={`mh-dot ${connected ? "mh-dot--connected" : "mh-dot--busy"}`}
          title={connected ? "Connected to opencode" : "Reconnecting…"}
        />
        {sessionID && (
          <div className="hidden items-center gap-1 md:flex">
            <AuditTrigger onOpen={() => setPanel("audit")} />
            <RunTrigger sessionID={sessionID} workspaceID={workspaceID} onOpen={() => setPanel("run")} />
            <PreviewTrigger sessionID={sessionID} onOpen={() => setPanel("preview")} />
          </div>
        )}
        <div className="mx-1 hidden h-6 w-px bg-hairline md:block" />
        <ThemeToggle />
        <button
          type="button"
          onClick={() => void handleLogout()}
          className="mh-btn mh-btn--ghost hidden md:inline-flex"
        >
          Sign out
        </button>
        <div className="relative md:hidden">
          <button
            type="button"
            onClick={() => setMenuOpen((value) => !value)}
            className="mh-btn mh-btn--icon"
            aria-label="More actions"
            aria-expanded={menuOpen}
          >
            <EllipsisIcon size={18} />
          </button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-20" aria-hidden="true" onClick={() => setMenuOpen(false)} />
              <div
                className="absolute right-0 top-full z-30 mt-1 w-60 rounded-md border border-hairline bg-surface p-1.5 shadow-elev3"
                onClick={() => setMenuOpen(false)}
              >
                {sessionID && (
                  <div className="mb-1.5 flex flex-col gap-0.5 border-b border-hairline pb-1.5">
                    <AuditTrigger onOpen={() => setPanel("audit")} className="w-full justify-start" />
                    <RunTrigger
                      sessionID={sessionID}
                      workspaceID={workspaceID}
                      onOpen={() => setPanel("run")}
                      className="w-full justify-start"
                    />
                    <PreviewTrigger
                      sessionID={sessionID}
                      onOpen={() => setPanel("preview")}
                      className="w-full justify-start"
                    />
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => void handleLogout()}
                  className="mh-btn mh-btn--ghost w-full justify-start"
                >
                  Sign out
                </button>
              </div>
            </>
          )}
        </div>
      </header>

      {banner && (
        <button type="button" onClick={() => setBanner(null)} className="mh-banner mh-banner--warning">
          {banner} · tap to dismiss
        </button>
      )}

      {statusQuery.data?.opencode?.error === "unauthorized" && (
        <div className="mh-banner mh-banner--danger">
          opencode rejected MasterHand&apos;s credentials. MasterHand and opencode must share
          OPENCODE_SERVER_PASSWORD: set it in apps/server/.env.local (or unset it in opencode), then
          restart both.
        </div>
      )}

      {statusQuery.data?.opencode?.error === "unreachable" && (
        <div className="mh-banner mh-banner--danger">opencode is not reachable. Is its server running?</div>
      )}

      {choiceForm ? null : waitingForm ? (
        <button
          type="button"
          onClick={() => openSession(waitingForm.sessionID)}
          className="mh-banner mh-banner--info"
        >
          <span className="mh-dot mh-dot--busy" />
          <span className="min-w-0 flex-1 truncate">The agent is waiting for your answer · Open session</span>
        </button>
      ) : null}

      {otherPermissionSessions.map((permissionSessionID) => (
        <button
          key={permissionSessionID}
          type="button"
          onClick={() => openSession(permissionSessionID)}
          className="mh-banner mh-banner--info"
        >
          <span className="mh-dot mh-dot--busy" />
          <span className="min-w-0 flex-1 truncate">Permission requested in another session · Open session</span>
        </button>
      ))}

      <div className="relative flex min-h-0 flex-1">
        {drawerOpen && (
          <div
            className="mh-overlay fixed inset-0 z-30 md:hidden"
            aria-hidden="true"
            onClick={() => setDrawerOpen(false)}
          />
        )}
        <aside className={asideClass}>
          <SessionList
            sessions={sessions}
            statuses={statuses}
            selectedID={sessionID}
            onSelect={(id) => {
              openSession(id)
              setDrawerOpen(false)
            }}
            onDelete={setRemoveSessionID}
            hasWorkspace={Boolean(workspaceID)}
            onCreateSession={(isolated) => {
              setDrawerOpen(false)
              void createSession(isolated)
            }}
            creating={creating}
          />
        </aside>

        <main className="relative flex min-w-0 flex-1 flex-col">
          {sessionID ? (
            <ChatView
              key={sessionID}
              sessionID={sessionID}
              busy={busy}
              connected={connected}
              workspaceID={workspaceID}
              workspacePath={workspacePath}
              workspaces={workspaces}
              isolation={selected?.isolation}
              autoAccept={autoAcceptSessions.includes(sessionID)}
              onToggleAutoAccept={(on) => toggleAutoAccept(sessionID, on)}
              onOpenSession={openSession}
              onSelectWorkspace={switchWorkspace}
              onAddWorkspace={() => setAddingWorkspace(true)}
              onRemoveWorkspace={setRemoveWorkspaceID}
              forms={forms}
              answeredForms={answeredForms}
              busyFormID={busyFormID}
              onRespondForm={(form, answer) => void respondForm(form, answer)}
              onCancelForm={(form) => void cancelForm(form)}
              permissions={permissions}
              answeredPermissions={answeredPermissions}
              respondingPermissionID={respondingPermissionID}
              onRespondPermission={(permission, response) => void respondPermission(permission, response)}
            />
          ) : (
            <div className="relative flex flex-1 flex-col items-center justify-center gap-5 p-6">
              <SessionToolbar
                workspaces={workspaces}
                workspaceID={workspaceID}
                onSelectWorkspace={switchWorkspace}
                onAddWorkspace={() => setAddingWorkspace(true)}
                onRemoveWorkspace={setRemoveWorkspaceID}
              />
              <div className="mh-empty w-full max-w-lg border-0 bg-transparent">
                <Deco variant="blob" style={{ top: -80, right: -80, width: 280, height: 260 }} />
                <Deco variant="dots" style={{ bottom: -12, left: -20 }} />
                <h3 className="mh-heading-2">No session open</h3>
                <p className="mh-empty__body mh-body-sm">Pick one from the session list or start a new one.</p>
              </div>
            </div>
          )}

          {sessionID && parentSessionID && (
            <button
              type="button"
              onClick={() => openSession(parentSessionID)}
              className="mh-btn mh-btn--secondary mh-btn--sm absolute left-1/2 top-3 z-20 -translate-x-1/2 shadow-elev1"
            >
              <ArrowLeftIcon size={14} />
              Back to main agent
            </button>
          )}
        </main>
      </div>

      {choiceForm && (
        <ChoiceModal
          form={choiceForm}
          busy={busyFormID === choiceForm.id}
          onRespond={(form, answer) => void respondForm(form, answer)}
          onCancel={(form) => void cancelForm(form)}
          onOpenSession={() => openSession(choiceForm.sessionID)}
          onNotNow={() => setDismissedChoiceFormIDs((prev) => [...prev, choiceForm.id])}
        />
      )}

      {addingWorkspace && (
        <AddWorkspaceDialog onSubmit={addWorkspace} onClose={() => setAddingWorkspace(false)} />
      )}

      {removeWorkspaceID && (
        <RemoveWorkspaceDialog
          name={workspaces.find((item) => item.id === removeWorkspaceID)?.name ?? ""}
          busy={removingWorkspace}
          onConfirm={confirmRemoveWorkspace}
          onClose={() => setRemoveWorkspaceID(null)}
        />
      )}

      {removeSessionID && (
        <RemoveSessionDialog
          name={
            sessions.find((item) => item.id === removeSessionID)?.title ||
            "this session"
          }
          busy={removingSession}
          onConfirm={confirmRemoveSession}
          onClose={() => setRemoveSessionID(null)}
        />
      )}

      {panel === "audit" && <AuditSheet onClose={() => setPanel(null)} />}
      {sessionID && panel === "run" && (
        <RunSheet sessionID={sessionID} workspaceID={workspaceID} onClose={() => setPanel(null)} />
      )}
      {sessionID && panel === "preview" && <PreviewSheet sessionID={sessionID} onClose={() => setPanel(null)} />}
    </div>
  )
}
