import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query"
import {
  ApiError,
  RequestTimeoutError,
  createEventHandler,
  createSessionMarker,
  formIsQuestion,
  invalidateOnReconnect,
  isAmbiguousError,
  isMixedContentBlocked,
  normalizeServerLabel,
  normalizeServerUrl,
  reconcileForms,
  reconcilePermissions,
  rootSessions,
  serverAuthMode,
  sessionCreateMarker,
  shouldAutoAccept,
  useBffStatus,
  useEventStream,
  useSessionDirectories,
  useSessions,
  useSessionStatuses,
  useWorkspaces,
  useUpdate,
  type CreateWorkspaceInput,
  type FormAnswer,
  type FormInfo,
  type Permission,
  type PermissionResponse,
  type Session,
} from "@masterhand/client-core"
import { client, createServerClient, setActiveClient } from "./client"
import { AddWorkspaceDialog } from "./components/AddWorkspaceDialog"
import { AuditSheet, AuditTrigger } from "./components/AuditPanel"
import { BoardPanel, BoardView } from "./components/BoardView"
import { BottomNav } from "./components/BottomNav"
import { BrandMark } from "./components/BrandMark"
import { ChatView } from "./components/ChatView"
import { ChoiceModal } from "./components/ChoiceModal"
import { Deco } from "./components/Deco"
import { BranchPicker } from "./components/BranchPicker"
import { RunPreviewSheet, RunPreviewTrigger } from "./components/RunPreviewPanel"
import { RemoveSessionDialog } from "./components/RemoveSessionDialog"
import { RemoveWorkspaceDialog } from "./components/RemoveWorkspaceDialog"
import { SchedulerPanel } from "./components/SchedulerPanel"
import { ServerSwitcher } from "./components/ServerSwitcher"
import { ServersScreen, type ConnectingServer } from "./components/ServersScreen"
import { SessionList } from "./components/SessionList"
import { SessionToolbar } from "./components/SessionToolbar"
import { SettingsDialog, type SettingsModule } from "./components/SettingsPanel"
import { UpdateNotices } from "./components/UpdateNotice"
import { useToast } from "./components/Toast"
import { WorkspacePicker } from "./components/WorkspacePicker"
import {
  ArrowLeftIcon,
  ChatBubbleIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClockIcon,
  EllipsisIcon,
  GearIcon,
  KanbanIcon,
  LogOutIcon,
  WavesIcon,
} from "./components/icons"
import type { AnsweredPermission } from "./components/PermissionCard"
import { useThemeMode } from "./theme"
import { useMediaQuery, MOBILE_MEDIA_QUERY } from "./useMediaQuery"
import { markSessionSeen } from "./sessionSeen"
import {
  clearServerToken,
  createProfile,
  findProfileByUrl,
  getOrCreateInstallID,
  loadRegistry,
  loadScopedJSON,
  loadServerToken,
  migrateLegacyPreferences,
  removeProfile,
  saveRegistry,
  saveScopedJSON,
  saveServerToken,
  webDeviceName,
  type ServerProfile,
  type ServerRegistry,
} from "./servers"

const AUTO_ACCEPT_KEY = "masterhand.autoAcceptSessions"
const SIDEBAR_COLLAPSED_KEY = "mh-sidebar-collapsed"
const SIDEBAR_SECTION_KEY = "mh-sidebar-section"

function autoAcceptKey(profileID: string): string {
  return `${AUTO_ACCEPT_KEY}.${profileID}`
}

/** Sections of the sidebar. Sessions is first; board and scheduler follow. */
type SidebarSection = "sessions" | "board" | "scheduler"

/** Auto-accept retry policy: bounded attempts with a short backoff. */
const AUTO_ACCEPT_MAX_ATTEMPTS = 3
const AUTO_ACCEPT_RETRY_DELAYS_MS = [1_000, 3_000]

function initialWorkspaceID(profile: ServerProfile, useUrlState: boolean): string | null {
  if (useUrlState) {
    const fromUrl = new URLSearchParams(window.location.search).get("workspace")
    if (fromUrl) return fromUrl
  }
  return profile.lastWorkspaceID
}

function initialSessionID(profile: ServerProfile, useUrlState: boolean): string | null {
  if (useUrlState) {
    const fromUrl = new URLSearchParams(window.location.search).get("session")
    if (fromUrl) return fromUrl
  }
  return profile.lastSessionID
}

function loadAutoAcceptSessions(profileID: string): string[] {
  const parsed = loadScopedJSON<unknown>(autoAcceptKey(profileID), [])
  return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []
}

function legacyWorkspaceID(): string | null {
  try {
    return window.localStorage.getItem("masterhand.workspace")
  } catch {
    return null
  }
}

function clearUrlState(): void {
  const url = new URL(window.location.href)
  url.searchParams.delete("session")
  url.searchParams.delete("workspace")
  window.history.replaceState(null, "", url)
}

function newQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: 1 } } })
}

/** Compact free-space label for the low-disk banner. */
function formatFreeBytes(bytes: number | null): string {
  if (bytes === null) return "unknown"
  const gb = bytes / 1024 ** 3
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.max(0, Math.round(bytes / 1024 ** 2))} MB`
}

function connectErrorMessage(
  error: unknown,
  url: string,
  mode: "first-run" | "add" | "reauth" | "saved",
): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "Wrong password. Try again."
    if (error.status === 429) return "Too many attempts; wait 15 minutes."
    if (error.status === 400) {
      return mode === "reauth" ? "Enter the password." : "Check the server URL and password."
    }
    if (error.status === 404) return "This server does not expose the MasterHand API (404)."
    return `The server answered with error ${error.status}.`
  }
  if (error instanceof RequestTimeoutError) {
    return "The server did not answer in time. Check the URL and try again."
  }
  let host = url
  try {
    host = new URL(url).host
  } catch {
    // keep the raw value
  }
  return `Could not reach ${host}. Check the URL, that the server is running, and that it allows cross-origin token requests (an older BFF may need an update).`
}

type RootPhase = "loading" | "servers" | "connecting" | "app" | "boot-error"

/**
 * Multi-server root (ADR-39): owns the profile registry, the one active
 * client/QueryClient and the connect/switch/disconnect/remove lifecycle. The
 * authenticated tree is keyed by profile id, so switching unmounts the old
 * server's UI, stops its SSE stream and starts from a clean cache.
 */
export default function App() {
  const themeMode = useThemeMode()
  const toast = useToast()
  const [registry, setRegistry] = useState<ServerRegistry>(() => loadRegistry())
  const registryRef = useRef(registry)
  registryRef.current = registry
  const [phase, setPhase] = useState<RootPhase>("loading")
  const [pending, setPending] = useState<ConnectingServer | null>(null)
  const [connectError, setConnectError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [reauthProfile, setReauthProfile] = useState<ServerProfile | null>(null)
  const [busy, setBusy] = useState(false)
  const [bootError, setBootError] = useState<string | null>(null)
  const [useUrlState, setUseUrlState] = useState(true)
  const [openAdd, setOpenAdd] = useState(false)
  const [draft, setDraft] = useState<{ url: string; label: string } | null>(null)
  const [queryClient, setQueryClient] = useState<QueryClient>(newQueryClient)
  const generationRef = useRef(0)
  const bootedRef = useRef(false)
  const expireRef = useRef<(profileID: string) => void>(() => {})
  // Drop the previous server's cache (and its gc timers) on switch/unmount.
  useEffect(() => () => queryClient.clear(), [queryClient])

  const activeProfile =
    phase === "app" ? (registry.profiles.find((item) => item.id === registry.activeID) ?? null) : null

  const updateRegistry = useCallback((updater: (previous: ServerRegistry) => ServerRegistry) => {
    setRegistry((previous) => {
      const next = updater(previous)
      saveRegistry(next)
      return next
    })
  }, [])

  const clientFor = useCallback((profile: ServerProfile) => {
    return createServerClient({
      baseUrl: profile.url,
      ...(profile.authMode === "device"
        ? { getToken: () => loadServerToken(profile.id) }
        : {}),
      onUnauthorized: () => expireRef.current(profile.id),
    })
  }, [])

  const expire = useCallback(
    (profileID: string) => {
      // A late 401 from a replaced client must not tear down the new server.
      if (registryRef.current.activeID !== profileID) return
      const profile = registryRef.current.profiles.find((item) => item.id === profileID) ?? null
      if (profile?.authMode === "device") clearServerToken(profileID)
      updateRegistry((previous) => ({
        profiles: previous.profiles.map((item) =>
          item.id === profileID ? { ...item, expired: true } : item,
        ),
        activeID: null,
      }))
      generationRef.current += 1
      setQueryClient(newQueryClient())
      setReauthProfile(profile ? { ...profile, expired: true } : null)
      setConnectError(profile ? `${profile.label}'s saved session expired. Enter its password again.` : null)
      setPending(null)
      setBusy(false)
      setPhase("servers")
    },
    [updateRegistry],
  )
  expireRef.current = expire

  /**
   * Connects one profile with a password (add/re-auth) or its saved
   * credential (switch/restore). Never logs or persists the password.
   */
  const connectProfile = useCallback(
    async (
      profile: ServerProfile,
      options: {
        password?: string
        restoreURL: boolean
        firstRun?: boolean
        formMode?: "first-run" | "add" | "reauth"
      },
    ) => {
      const run = ++generationRef.current
      const targetUrl = profile.url
      const mode: "first-run" | "add" | "reauth" | "saved" =
        options.formMode ?? (options.firstRun ? "first-run" : "saved")
      setConnectError(null)
      setNotice(null)
      setReauthProfile(null)
      setPending({ label: profile.label, url: profile.url })
      setPhase("connecting")
      setBusy(true)

      const candidate = createServerClient({
        baseUrl: targetUrl,
        ...(profile.authMode === "device"
          ? { getToken: () => loadServerToken(profile.id) }
          : {}),
      })
      let deviceID = profile.deviceID

      try {
        if (options.password) {
          if (profile.authMode === "cookie") {
            await candidate.auth.login(options.password)
          } else {
            const result = await candidate.auth.loginDevice(
              options.password,
              webDeviceName(),
              getOrCreateInstallID(),
            )
            saveServerToken(profile.id, result.token)
            deviceID = result.device.id
          }
        } else if (profile.authMode === "device" && !loadServerToken(profile.id)) {
          if (run !== generationRef.current) return
          setBusy(false)
          setPending(null)
          setReauthProfile(profile)
          setPhase("servers")
          return
        }

        // Verify the saved/issued credential before entering the app: a 401
        // here means "wrong password"/"expired", never a half-connected UI.
        await candidate.auth.status()
        if (run !== generationRef.current) return

        const legacyWorkspace = profile.authMode === "cookie" ? legacyWorkspaceID() : null
        const nextProfile: ServerProfile = {
          ...profile,
          authMode: profile.authMode,
          lastUsedAt: Date.now(),
          deviceID,
          expired: false,
          // The legacy single-server preferences belong to the serving origin
          // (cookie profile). A remote profile must never inherit them.
          ...(legacyWorkspace ? { lastWorkspaceID: legacyWorkspace } : {}),
        }
        updateRegistry((previous) => ({
          profiles: previous.profiles.some((item) => item.id === nextProfile.id)
            ? previous.profiles.map((item) => (item.id === nextProfile.id ? nextProfile : item))
            : [...previous.profiles, nextProfile],
          activeID: nextProfile.id,
        }))
        // Idempotent: copies the old global preferences to the current-origin
        // profile only, then removes them from the global keys.
        if (nextProfile.authMode === "cookie") migrateLegacyPreferences(nextProfile.id)
        setActiveClient(clientFor(nextProfile))
        setQueryClient(newQueryClient())
        setPending(null)
        setBusy(false)
        setUseUrlState(options.restoreURL)
        setOpenAdd(false)
        setDraft(null)
        if (!options.restoreURL) clearUrlState()
        setPhase("app")
      } catch (error) {
        if (run !== generationRef.current) return
        // A failed device login must not leave a token around.
        if (options.password && profile.authMode === "device") clearServerToken(profile.id)
        setBusy(false)
        setPending(null)
        setConnectError(connectErrorMessage(error, targetUrl, mode))
        const expiredSession = error instanceof ApiError && error.status === 401
        setOpenAdd(mode === "add")
        setReauthProfile(
          mode === "reauth" || (mode === "saved" && (profile.expired || expiredSession))
            ? profile
            : null,
        )
        setPhase("servers")
      }
    },
    [clientFor, updateRegistry],
  )

  const retryBoot = useCallback(async () => {
    const current = registryRef.current
    setBootError(null)
    setPhase("loading")
    if (current.profiles.length === 0) {
      const probe = createServerClient({ baseUrl: window.location.origin })
      try {
        await probe.auth.status()
        const profile = createProfile({
          url: window.location.origin,
          authMode: "cookie",
        })
        profile.lastWorkspaceID = legacyWorkspaceID()
        migrateLegacyPreferences(profile.id)
        const next = { profiles: [profile], activeID: profile.id }
        saveRegistry(next)
        setRegistry(next)
        setActiveClient(clientFor(profile))
        setQueryClient(newQueryClient())
        setUseUrlState(true)
        setPhase("app")
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          setPhase("servers")
        } else {
          setBootError(
            error instanceof ApiError
              ? `The server answered with error ${error.status}. Check the server logs and try again.`
              : "Could not reach the MasterHand server. Check the URL and that it is running.",
          )
          setPhase("boot-error")
        }
      }
      return
    }
    const active = current.profiles.find((item) => item.id === current.activeID)
    if (!active) {
      setPhase("servers")
      return
    }
    await connectProfile(active, { restoreURL: true })
  }, [clientFor, connectProfile])

  // Boot: migrate an existing same-origin cookie session into a profile, or
  // restore the last active profile. A 401 sends the user to the Servers
  // screen (re-auth prompt); other errors keep the old retry screen.
  useEffect(() => {
    if (bootedRef.current) return
    bootedRef.current = true
    void retryBoot()
  }, [retryBoot])

  useEffect(() => {
    document.title =
      phase === "app" && activeProfile
        ? `${activeProfile.label} · MasterHand`
        : phase === "servers"
          ? "Servers · MasterHand"
          : "MasterHand"
  }, [phase, activeProfile])

  const handleSubmit = useCallback(
    async (
      mode: "first-run" | "add" | "reauth",
      submission: { url: string; label: string; password: string },
      profile?: ServerProfile,
    ) => {
      setConnectError(null)
      setDraft({ url: submission.url, label: submission.label })
      const normalized = normalizeServerUrl(submission.url)
      if (!normalized.ok) {
        setConnectError("Enter a valid server URL")
        setPhase("servers")
        return
      }
      if (isMixedContentBlocked(normalized.server.url)) {
        setConnectError(
          "This page is served over https and cannot reach an http server. Use https:// for remote servers.",
        )
        setPhase("servers")
        return
      }
      const target =
        mode === "reauth" && profile
          ? profile
          : createProfile({
              url: normalized.server.url,
              label: submission.label,
              authMode: serverAuthMode(normalized.server.url),
            })
      const duplicate = findProfileByUrl(registryRef.current.profiles, normalized.server.url)
      if (mode !== "reauth" && duplicate && duplicate.id !== target.id) {
        setConnectError("This server is already saved.")
        setPhase("servers")
        return
      }
      await connectProfile(target, {
        password: submission.password,
        restoreURL: false,
        firstRun: mode === "first-run" && registryRef.current.profiles.length === 0,
        formMode: mode,
      })
    },
    [connectProfile],
  )

  const handleSelect = useCallback(
    (profile: ServerProfile) => {
      setConnectError(null)
      setNotice(null)
      if (profile.authMode === "device" && !loadServerToken(profile.id)) {
        setReauthProfile(profile)
        setPhase("servers")
        return
      }
      void connectProfile(profile, { restoreURL: false })
    },
    [connectProfile],
  )

  const handleSwitch = useCallback(
    (profile: ServerProfile) => {
      if (profile.id === registryRef.current.activeID) return
      setConnectError(null)
      setNotice(null)
      if (profile.authMode === "device" && !loadServerToken(profile.id)) {
        setReauthProfile(profile)
        setPhase("servers")
        return
      }
      void connectProfile(profile, { restoreURL: false })
    },
    [connectProfile],
  )

  const disconnectProfile = useCallback(
    async (profile: ServerProfile) => {
      let residual = false
      const target = createServerClient({
        baseUrl: profile.url,
        ...(profile.authMode === "device"
          ? { getToken: () => loadServerToken(profile.id) }
          : {}),
        timeoutMs: 10_000,
      })
      if (profile.authMode === "cookie") {
        await target.auth.logout().catch(() => {})
      } else {
        const token = loadServerToken(profile.id)
        if (token && profile.deviceID) {
          try {
            await target.auth.revokeDevice(profile.deviceID)
          } catch {
            residual = true
          }
        }
        clearServerToken(profile.id)
      }
      const wasActive = registryRef.current.activeID === profile.id
      updateRegistry((previous) => ({
        profiles: previous.profiles.map((item) =>
          item.id === profile.id ? { ...item, expired: false } : item,
        ),
        activeID: wasActive ? null : previous.activeID,
      }))
      if (wasActive) {
        generationRef.current += 1
        setQueryClient(newQueryClient())
        setPending(null)
        setBusy(false)
        setReauthProfile(null)
        setConnectError(null)
        setPhase("servers")
        if (residual) {
          setNotice("Disconnected. The device token could not be revoked; revoke it from that server's settings.")
        }
      } else if (residual) {
        toast("Disconnected. The device token could not be revoked.")
      }
    },
    [toast, updateRegistry],
  )

  const removeServer = useCallback(
    async (profile: ServerProfile) => {
      let residual = false
      if (profile.authMode === "cookie") {
        const target = createServerClient({ baseUrl: profile.url, timeoutMs: 10_000 })
        await target.auth.logout().catch(() => {})
      } else {
        const token = loadServerToken(profile.id)
        if (token && profile.deviceID) {
          const target = createServerClient({
            baseUrl: profile.url,
            getToken: () => token,
            timeoutMs: 10_000,
          })
          try {
            await target.auth.revokeDevice(profile.deviceID)
          } catch {
            residual = true
          }
        }
        clearServerToken(profile.id)
      }
      const wasActive = registryRef.current.activeID === profile.id
      updateRegistry((previous) => ({
        profiles: removeProfile(previous.profiles, profile.id),
        activeID: wasActive ? null : previous.activeID,
      }))
      if (wasActive) {
        generationRef.current += 1
        setQueryClient(newQueryClient())
        setPending(null)
        setBusy(false)
        setReauthProfile(null)
        setConnectError(null)
        setPhase("servers")
      }
      toast(
        residual
          ? "Server removed. Its device token could not be revoked — revoke it from that server's settings."
          : "Server removed",
      )
    },
    [toast, updateRegistry],
  )

  const renameServer = useCallback(
    (profile: ServerProfile, label: string) => {
      updateRegistry((previous) => ({
        ...previous,
        profiles: previous.profiles.map((item) =>
          item.id === profile.id ? { ...item, label: normalizeServerLabel(label, item.url) } : item,
        ),
      }))
    },
    [updateRegistry],
  )

  const updateProfileState = useCallback(
    (profileID: string, patch: Partial<Pick<ServerProfile, "lastWorkspaceID" | "lastSessionID">>) => {
      updateRegistry((previous) => {
        let changed = false
        const profiles = previous.profiles.map((item) => {
          if (item.id !== profileID) return item
          const next = { ...item }
          if ("lastWorkspaceID" in patch && patch.lastWorkspaceID !== item.lastWorkspaceID) {
            next.lastWorkspaceID = patch.lastWorkspaceID ?? null
            changed = true
          }
          if ("lastSessionID" in patch && patch.lastSessionID !== item.lastSessionID) {
            next.lastSessionID = patch.lastSessionID ?? null
            changed = true
          }
          return changed ? next : item
        })
        return changed ? { ...previous, profiles } : previous
      })
    },
    [updateRegistry],
  )

  const openServersAdd = useCallback(() => {
    setReauthProfile(null)
    setConnectError(null)
    setNotice(null)
    setDraft(null)
    setOpenAdd(true)
    // Adding is done from the Servers screen so credential entry is never
    // mixed with the active app's mutable state.
    generationRef.current += 1
    setPending(null)
    setBusy(false)
    setPhase("servers")
  }, [])

  const activeProfileID = activeProfile?.id ?? null
  const onProfileStateActive = useCallback(
    (patch: Partial<Pick<ServerProfile, "lastWorkspaceID" | "lastSessionID">>) => {
      if (activeProfileID) updateProfileState(activeProfileID, patch)
    },
    [activeProfileID, updateProfileState],
  )

  if (phase === "loading") {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-canvas">
        <p className="animate-pulse text-sm text-ink-muted">Loading…</p>
      </main>
    )
  }

  if (phase === "boot-error") {
    return (
      <main className="mh-login">
        <Deco variant="blob" />
        <Deco variant="dots" />
        <div className="mh-login-card">
          <div className="mh-brand">
            <BrandMark />
            <span className="mh-brand__name">MasterHand</span>
          </div>
          <p className="mh-body-sm text-ink-muted">{bootError}</p>
          <button type="button" onClick={() => void retryBoot()} className="mh-btn mh-btn--primary w-full">
            Retry
          </button>
        </div>
      </main>
    )
  }

  if (phase === "servers" || phase === "connecting") {
    return (
      <ServersScreen
        profiles={registry.profiles}
        activeID={registry.activeID}
        initialUrl={window.location.origin}
        busy={busy}
        error={connectError}
        notice={notice}
        connecting={pending}
        reauthProfile={reauthProfile}
        startAdding={openAdd}
        draft={draft}
        onSubmit={(mode, submission, profile) => void handleSubmit(mode, submission, profile)}
        onSelect={handleSelect}
        onCancel={() => {
          setOpenAdd(false)
          setDraft(null)
          setReauthProfile(null)
          setConnectError(null)
        }}
        onCancelConnect={() => {
          generationRef.current += 1
          setPending(null)
          setBusy(false)
          setOpenAdd(false)
          setConnectError(null)
          setPhase("servers")
        }}
      />
    )
  }

  if (!activeProfile) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-canvas">
        <p className="text-sm text-ink-muted">No server selected.</p>
      </main>
    )
  }

  return (
    <QueryClientProvider client={queryClient}>
      <AuthenticatedApp
        key={activeProfile.id}
        profile={activeProfile}
        profiles={registry.profiles}
        useUrlState={useUrlState}
        themeMode={themeMode}
        onSwitchServer={handleSwitch}
        onDisconnect={() => void disconnectProfile(activeProfile)}
        onSessionExpired={() => expire(activeProfile.id)}
        onDisconnectServer={(profile) => void disconnectProfile(profile)}
        onRemoveServer={(profile) => void removeServer(profile)}
        onRenameServer={renameServer}
        onAddServer={openServersAdd}
        onProfileState={onProfileStateActive}
      />
    </QueryClientProvider>
  )
}

function AuthenticatedApp({
  profile,
  profiles,
  useUrlState,
  themeMode,
  onSwitchServer,
  onDisconnect,
  onSessionExpired,
  onDisconnectServer,
  onRemoveServer,
  onRenameServer,
  onAddServer,
  onProfileState,
}: {
  profile: ServerProfile
  profiles: ServerProfile[]
  useUrlState: boolean
  themeMode: ReturnType<typeof useThemeMode>
  onSwitchServer: (profile: ServerProfile) => void
  onDisconnect: () => void
  onSessionExpired: () => void
  onDisconnectServer: (profile: ServerProfile) => void
  onRemoveServer: (profile: ServerProfile) => void
  onRenameServer: (profile: ServerProfile, label: string) => void
  onAddServer: () => void
  onProfileState: (patch: Partial<Pick<ServerProfile, "lastWorkspaceID" | "lastSessionID">>) => void
}) {
  const queryClient = useQueryClient()
  const toast = useToast()
  const [sessionID, setSessionID] = useState<string | null>(() => initialSessionID(profile, useUrlState))
  const [workspaceID, setWorkspaceID] = useState<string | null>(() =>
    initialWorkspaceID(profile, useUrlState),
  )
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
  // Same-tick double submit is a ref guard, not state (rule 7): two clicks can
  // both read `busy` as false before React re-renders.
  const respondingPermissionRef = useRef(new Set<string>())
  const busyFormRef = useRef(new Set<string>())
  const [dismissedChoiceFormIDs, setDismissedChoiceFormIDs] = useState<string[]>([])
  const [creating, setCreating] = useState(false)
  const [banner, setBanner] = useState<string | null>(null)
  const [autoAcceptSessions, setAutoAcceptSessions] = useState<string[]>(() =>
    loadAutoAcceptSessions(profile.id),
  )
  const [panel, setPanel] = useState<"audit" | "run" | "settings" | null>(null)
  const [settingsModule, setSettingsModule] = useState<SettingsModule | undefined>(undefined)
  const [menuOpen, setMenuOpen] = useState(false)
  // Mobile shell (<768px): bottom nav instead of the sidebar drawer. The two
  // shells mount different panels, so the split is JS-driven; mounting both
  // (one `display: none`) would duplicate queries, controls and text.
  const isMobile = useMediaQuery(MOBILE_MEDIA_QUERY)
  // Desktop-only sidebar collapse, persisted like the theme choice. The mobile
  // shell has no sidebar: it navigates through the bottom bar.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1"
    } catch {
      return false
    }
  })
  // Active sidebar section, persisted like the collapse choice. It drives the
  // rail highlight and the main view; the collapse toggle only changes width.
  const [activeSection, setActiveSection] = useState<SidebarSection>(() => {
    try {
      const stored = window.localStorage.getItem(SIDEBAR_SECTION_KEY)
      return stored === "board" || stored === "scheduler" ? stored : "sessions"
    } catch {
      return "sessions"
    }
  })
  // False shows the active section's panel; the `<` back button shows the
  // sections home instead. It never changes the main view.
  const [sidebarShowsHome, setSidebarShowsHome] = useState(false)
  // Set when the user picks Sessions with no session open and the list has not
  // loaded yet: open the most recent session once it arrives.
  const pendingSectionAutoOpenRef = useRef(false)
  function toggleSidebarCollapsed() {
    setSidebarCollapsed((value) => {
      const next = !value
      try {
        window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0")
      } catch {
        // Storage may be unavailable (private mode); the toggle still works.
      }
      return next
    })
  }

  // Mirrors for the memoized event handler: it must see the latest values
  // without being recreated (which would resubscribe the stream).
  const autoAcceptSessionsRef = useRef(autoAcceptSessions)
  autoAcceptSessionsRef.current = autoAcceptSessions
  const answeringRef = useRef(new Set<string>())
  // Auto-accept failures are retried with backoff (bounded); after the cap the
  // user is pointed at the inline card instead of the session stalling forever.
  // `autoPending` tracks requests only auto-accept answers (they never enter
  // `permissions` state), so a stale retry can drop itself.
  const autoPendingRef = useRef(new Set<string>())
  const autoAcceptAttemptsRef = useRef(new Map<string, number>())
  const autoAcceptTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  // Requests whose auto-accept budget is spent: the drain effect (which now also
  // re-runs on every session refresh) must not restart the cycle until the
  // request is gone or answered elsewhere.
  const autoGivenUpRef = useRef(new Set<string>())
  const formsRef = useRef(forms)
  formsRef.current = forms
  // Set when the user switches workspace: drop the open session and open the
  // new workspace's most recent one once its session list arrives.
  const pendingWorkspaceAutoOpenRef = useRef(false)
  // Session ids from the last list snapshot (see the reconciliation effect).
  const knownSessionIDsRef = useRef<Set<string>>(new Set())
  const sessionIDRef = useRef(sessionID)
  sessionIDRef.current = sessionID
  // Restore the exact workspace/session on the next visit to this profile.
  useEffect(() => {
    onProfileState({ lastSessionID: sessionID })
  }, [sessionID, onProfileState])
  useEffect(() => {
    onProfileState({ lastWorkspaceID: workspaceID })
  }, [workspaceID, onProfileState])
  // Persist "seen" on every open path (list, creation, banners, restored URL).
  // App owns it because the mobile shell unmounts the session list in a chat.
  useEffect(() => {
    if (sessionID) markSessionSeen(sessionID, profile.id)
  }, [sessionID, profile.id])
  // Session graph mirror for the event handler: a permission raised in a
  // subagent (or a Goal Mode critic/judge) resolves its auto-accept inheritance
  // against the latest list without resubscribing the stream.
  const sessionsRef = useRef<Session[]>([])

  /** Answers a permission request automatically ("once", reversible). */
  const answerAuto = useCallback(async (permission: Permission, retry = false) => {
    if (answeringRef.current.has(permission.id)) return
    // A retry only applies while auto-accept still owns an unanswered request.
    if (
      retry &&
      (!autoPendingRef.current.has(permission.id) ||
        !shouldAutoAccept(permission.sessionID, sessionsRef.current, autoAcceptSessionsRef.current))
    ) {
      autoPendingRef.current.delete(permission.id)
      autoAcceptAttemptsRef.current.delete(permission.id)
      return
    }
    autoPendingRef.current.add(permission.id)
    answeringRef.current.add(permission.id)
    try {
      await client.api.respondPermission(permission.sessionID, permission.id, "once")
      autoPendingRef.current.delete(permission.id)
      autoAcceptAttemptsRef.current.delete(permission.id)
      autoGivenUpRef.current.delete(permission.id)
      setPermissions((prev) => prev.filter((item) => item.id !== permission.id))
      // Auto-answers stay in the transcript as resolved history.
      setAnsweredPermissions((prev) =>
        [...prev.filter((entry) => entry.permission.id !== permission.id), { permission, response: "once" as const, at: Date.now() }].slice(-50),
      )
    } catch {
      const attempts = (autoAcceptAttemptsRef.current.get(permission.id) ?? 0) + 1
      if (attempts < AUTO_ACCEPT_MAX_ATTEMPTS) {
        autoAcceptAttemptsRef.current.set(permission.id, attempts)
        const delay = AUTO_ACCEPT_RETRY_DELAYS_MS[attempts - 1] ?? AUTO_ACCEPT_RETRY_DELAYS_MS[AUTO_ACCEPT_RETRY_DELAYS_MS.length - 1]!
        const timer = setTimeout(() => {
          autoAcceptTimersRef.current.delete(permission.id)
          void answerAutoRef.current(permission, true)
        }, delay)
        autoAcceptTimersRef.current.set(permission.id, timer)
      } else {
        // Stop retrying, keep the inline card reachable and say what to do.
        autoPendingRef.current.delete(permission.id)
        autoAcceptAttemptsRef.current.delete(permission.id)
        autoGivenUpRef.current.add(permission.id)
        setBanner("Could not auto-accept the permission request — answer it in the chat")
      }
    } finally {
      answeringRef.current.delete(permission.id)
    }
  }, [])
  const answerAutoRef = useRef(answerAuto)
  answerAutoRef.current = answerAuto

  // Never leave retry timers running after unmount.
  useEffect(
    () => () => {
      for (const timer of autoAcceptTimersRef.current.values()) clearTimeout(timer)
      autoAcceptTimersRef.current.clear()
    },
    [],
  )

  const statusQuery = useBffStatus(client, 15_000)
  // Release manifest (#131): hourly poll plus refetch on window focus (see
  // `useUpdate`). Advisory only — an unknown upstream shows no notice.
  const updateQuery = useUpdate(client, true)

  useEffect(() => {
    if (statusQuery.isSuccess) return
    if (!statusQuery.error) return
    if (statusQuery.error instanceof ApiError) {
      if (statusQuery.error.status === 401) {
        onSessionExpired()
        return
      }
      setBanner(`The server answered with error ${statusQuery.error.status}`)
    } else {
      setBanner("Could not reach the MasterHand server")
    }
  }, [statusQuery.isSuccess, statusQuery.error, onSessionExpired])

  const handleEvent = useMemo(
    () =>
      createEventHandler(queryClient, {
        onPermission: (permission) => {
          if (shouldAutoAccept(permission.sessionID, sessionsRef.current, autoAcceptSessionsRef.current)) {
            void answerAutoRef.current(permission)
            return
          }
          setPermissions((prev) => (prev.some((item) => item.id === permission.id) ? prev : [...prev, permission]))
        },
        onPermissionReplied: (permissionID) => {
          // Answered elsewhere: the event carries no response, so no resolved
          // row is recorded (the tool card still reflects the outcome). Drop
          // any pending auto-accept retry for it too.
          autoPendingRef.current.delete(permissionID)
          autoAcceptAttemptsRef.current.delete(permissionID)
          autoGivenUpRef.current.delete(permissionID)
          const timer = autoAcceptTimersRef.current.get(permissionID)
          if (timer) {
            clearTimeout(timer)
            autoAcceptTimersRef.current.delete(permissionID)
          }
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

  const openSession = useCallback(
    (id: string | null) => {
      setSessionID(id)
      setMenuOpen(false)
      const url = new URL(window.location.href)
      if (id) url.searchParams.set("session", id)
      else url.searchParams.delete("session")
      window.history.replaceState(null, "", url)
      // Fresh sidebar state on switch (badges, relative times, new sessions).
      void queryClient.invalidateQueries({ queryKey: ["sessions"] })
    },
    [queryClient],
  )

  const selectWorkspace = useCallback((id: string | null) => {
    setWorkspaceID(id)
    const url = new URL(window.location.href)
    if (id) url.searchParams.set("workspace", id)
    else url.searchParams.delete("workspace")
    window.history.replaceState(null, "", url)
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

  const workspacesQuery = useWorkspaces(client, true)
  const workspaces = workspacesQuery.data ?? []

  useEffect(() => {
    if (!workspacesQuery.data) return
    if (workspaceID && workspacesQuery.data.some((workspace) => workspace.id === workspaceID)) return
    selectWorkspace(workspacesQuery.data[0]?.id ?? null)
  }, [workspacesQuery.data, workspaceID, selectWorkspace])

  const workspace = workspaces.find((item) => item.id === workspaceID) ?? null
  const workspacePath = workspace?.path ?? null
  const directoriesQuery = useSessionDirectories(client, true, workspaceID)
  const sessionsQuery = useSessions(client, true, 10_000, workspaceID)

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
    enabled: true,
    onEvent: handleEvent,
    onConnectionChange: setConnected,
    onConnect: handleConnect,
  })

  useEffect(() => {
    if (!workspacesQuery.data) return
    void syncPending()
  }, [workspacesQuery.data, syncPending])

  useEffect(() => {
    saveScopedJSON(autoAcceptKey(profile.id), autoAcceptSessions)
  }, [autoAcceptSessions, profile.id])

  const toggleAutoAccept = useCallback((id: string, on: boolean) => {
    setAutoAcceptSessions((prev) =>
      on ? (prev.includes(id) ? prev : [...prev, id]) : prev.filter((item) => item !== id),
    )
  }, [])

  useEffect(() => {
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
  }, [queryClient])

  const statusesQuery = useSessionStatuses(client, true, connected)

  useEffect(() => {
    if (sessionsQuery.error instanceof ApiError && sessionsQuery.error.status === 401) onSessionExpired()
  }, [sessionsQuery.error, onSessionExpired])

  const sessions = useMemo(
    () => [...(sessionsQuery.data ?? [])].sort((a, b) => b.time.updated - a.time.updated),
    [sessionsQuery.data],
  )
  sessionsRef.current = sessions

  // Drain the queue for sessions whose permissions we auto-answer. This also
  // covers pending requests recovered on reconnect/reload (they never arrive as
  // events) and re-evaluates once the session graph loads, so a subagent that
  // inherited auto-accept before its child session was listed still matches.
  useEffect(() => {
    if (permissions.length === 0) return
    for (const permission of permissions) {
      if (autoGivenUpRef.current.has(permission.id)) continue
      if (shouldAutoAccept(permission.sessionID, sessions, autoAcceptSessions)) void answerAuto(permission)
    }
  }, [autoAcceptSessions, permissions, answerAuto, sessions])

  // Auto-open only targets sessions the sidebar can show: a Goal Mode critic
  // session is often the most recently updated and must never be opened by
  // fallback (it would leave the user on an invisible session).
  const listableSessions = useMemo(() => rootSessions(sessions), [sessions])

  // Reconcile the open session when it disappears from the list (deleted from
  // another device/TUI: `session.deleted` invalidates the list and the refetch
  // confirms it). Only a session that was present in the previous snapshot is
  // closed, so a just-created session is never dropped by a stale fetch.
  useEffect(() => {
    if (!sessionsQuery.isSuccess) return
    const current = new Set(sessions.map((session) => session.id))
    const openID = sessionIDRef.current
    const wasKnown = openID !== null && knownSessionIDsRef.current.has(openID)
    knownSessionIDsRef.current = current
    if (wasKnown && openID && !current.has(openID)) {
      openSession(listableSessions[0]?.id ?? null)
    }
  }, [sessions, listableSessions, sessionsQuery.isSuccess, openSession])
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
    const next = listableSessions[0]?.id ?? null
    if (next !== sessionID) openSession(next)
  }, [sessionsQuery.isSuccess, listableSessions, sessionID, openSession])

  /**
   * Marks the active home section and persists it, without touching the open
   * session. The mobile bottom nav uses this: selecting Sessions shows the
   * list, it never re-opens the most recent session.
   */
  const selectHomeSection = useCallback((section: SidebarSection) => {
    setActiveSection(section)
    setSidebarShowsHome(false)
    setMenuOpen(false)
    try {
      window.localStorage.setItem(SIDEBAR_SECTION_KEY, section)
    } catch {
      // storage may be unavailable (private mode)
    }
  }, [])

  /**
   * Switches the sidebar section. It only marks the section and swaps the main
   * view to its default (the most recent session for Sessions, the single
   * placeholder for Board): it never collapses or expands the sidebar.
   */
  const selectSection = useCallback(
    (section: SidebarSection) => {
      selectHomeSection(section)
      if (section !== "sessions" || sessionIDRef.current) return
      const first = rootSessions(sessionsRef.current)[0]
      if (first) openSession(first.id)
      else pendingSectionAutoOpenRef.current = true
    },
    [selectHomeSection, openSession],
  )

  /**
   * Opens a session in the chat, switching to Sessions first. "Open session"
   * actions live outside Sessions (scheduler run history, other-session
   * banners, the choice modal): without the switch the chat would stay hidden
   * behind the active Board/Scheduler view.
   */
  const openSessionInChat = useCallback(
    (id: string) => {
      selectHomeSection("sessions")
      openSession(id)
    },
    [selectHomeSection, openSession],
  )

  // Opens the default Sessions view once the list arrives when the user picked
  // the section while it was still loading.
  useEffect(() => {
    if (!pendingSectionAutoOpenRef.current) return
    if (activeSection !== "sessions") return
    if (!sessionsQuery.isSuccess) return
    pendingSectionAutoOpenRef.current = false
    if (!sessionIDRef.current && listableSessions[0]) openSession(listableSessions[0].id)
  }, [sessionsQuery.isSuccess, listableSessions, activeSection, openSession])

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

  const handleLogout = useCallback(() => {
    setPanel(null)
    setMenuOpen(false)
    onDisconnect()
  }, [onDisconnect])

  const openSettings = useCallback((module?: SettingsModule) => {
    setSettingsModule(module)
    setPanel("settings")
  }, [])

  /**
   * Walks the session list for a marker after an ambiguous create. Bounded
   * (three attempts): the session may appear once the BFF finishes server-side.
   */
  async function findCreatedSession(marker: string): Promise<string | null> {
    if (!workspaceID) return null
    for (const delay of [0, 1000, 2500]) {
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
      try {
        const page = await client.api.sessions.list(workspaceID)
        const found = page.sessions.find((session) => sessionCreateMarker(session) === marker)
        if (found) return found.id
      } catch {
        // keep polling: a transient failure must not hide the confirmation
      }
    }
    return null
  }

  async function createSession(isolated: boolean) {
    if (!workspaceID) {
      setBanner("Add a workspace first")
      return
    }
    setCreating(true)
    setBanner(null)
    const marker = createSessionMarker()
    try {
      const session = await client.api.sessions.create(workspaceID, { isolated, marker })
      void queryClient.invalidateQueries({ queryKey: ["sessions"] })
      void queryClient.invalidateQueries({ queryKey: ["directories"] })
      openSession(session.id)
    } catch (error) {
      if (isAmbiguousError(error)) {
        // Session creation is not idempotent: reconcile by the marker before
        // reporting anything, and never retry automatically.
        const created = await findCreatedSession(marker)
        if (created) {
          void queryClient.invalidateQueries({ queryKey: ["sessions"] })
          void queryClient.invalidateQueries({ queryKey: ["directories"] })
          openSession(created)
          return
        }
        void queryClient.invalidateQueries({ queryKey: ["sessions"] })
        setBanner("The server did not answer in time — the session may still be created. Check the list before retrying.")
      } else {
        setBanner("Could not create the session")
      }
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

  /** The location of a session from the loaded list, or null when unknown. */
  function directoryOfSession(id: string): string | null {
    return (sessionsQuery.data ?? []).find((session) => session.id === id)?.location.directory ?? null
  }

  /**
   * Confirms an ambiguous permission reply actually settled by checking
   * opencode's pending list: a lost response may still have been applied.
   * Bounded attempts; `false` means "still pending or unverifiable", so the
   * user can retry without risking a double answer.
   */
  async function confirmPermissionSettled(permission: Permission): Promise<boolean> {
    const directory = directoryOfSession(permission.sessionID)
    if (!directory) return false
    for (const delay of [0, 1000, 2500]) {
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
      try {
        const pending = await client.api.permissions(directory)
        if (!pending.some((item) => item.id === permission.id)) return true
      } catch {
        // keep trying: a transient failure must not read as "settled"
      }
    }
    return false
  }

  /** Same reconciliation for forms (the `question` tool). */
  async function confirmFormSettled(form: FormInfo): Promise<boolean> {
    const directory = directoryOfSession(form.sessionID)
    if (!directory) return false
    for (const delay of [0, 1000, 2500]) {
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
      try {
        const pending = await client.api.pendingForms(directory)
        if (!pending.some((item) => item.id === form.id)) return true
      } catch {
        // keep trying
      }
    }
    return false
  }

  function markPermissionAnswered(permission: Permission, response: PermissionResponse) {
    setPermissions((prev) => prev.filter((item) => item.id !== permission.id))
    // Keep the answered request so it renders as resolved history inline.
    setAnsweredPermissions((prev) =>
      [...prev.filter((entry) => entry.permission.id !== permission.id), { permission, response, at: Date.now() }].slice(-50),
    )
  }

  function markFormSettled(form: FormInfo, answer: FormAnswer | null) {
    setForms((prev) => prev.filter((item) => item.id !== form.id))
    setDismissedChoiceFormIDs((prev) => prev.filter((id) => id !== form.id))
    if (answer) {
      // Keep the local answer so the inline card can render it read-only.
      setAnsweredForms((prev) =>
        [...prev.filter((entry) => entry.form.id !== form.id), { form, answer }].slice(-50),
      )
    }
  }

  async function respondPermission(permission: Permission, response: PermissionResponse) {
    if (respondingPermissionRef.current.has(permission.id)) return
    respondingPermissionRef.current.add(permission.id)
    setRespondingPermissionID(permission.id)
    try {
      // The session id resolves the request regardless of the active workspace.
      await client.api.respondPermission(permission.sessionID, permission.id, response)
      markPermissionAnswered(permission, response)
    } catch (error) {
      if (isAmbiguousError(error)) {
        // The reply may have been applied: reconcile before reporting, and
        // only invite a retry when the request is provably still pending.
        if (await confirmPermissionSettled(permission)) {
          markPermissionAnswered(permission, response)
        } else {
          setBanner("The server did not answer in time — the permission may not have been answered. Try again.")
        }
      } else {
        // Keep the inline card so the user can retry.
        setBanner("Could not answer the permission request")
      }
    } finally {
      respondingPermissionRef.current.delete(permission.id)
      setRespondingPermissionID(null)
    }
  }

  async function respondForm(form: FormInfo, answer: FormAnswer) {
    if (busyFormRef.current.has(form.id)) return
    busyFormRef.current.add(form.id)
    setBusyFormID(form.id)
    setBanner(null)
    try {
      // The form id resolves the question regardless of the active workspace.
      await client.api.respondForm(form.sessionID, form.id, answer)
      markFormSettled(form, answer)
    } catch (error) {
      if (isAmbiguousError(error)) {
        if (await confirmFormSettled(form)) {
          markFormSettled(form, answer)
        } else {
          setBanner("The server did not answer in time — the answer may not have been applied. Try again.")
        }
      } else {
        setBanner("Could not answer the question")
      }
    } finally {
      busyFormRef.current.delete(form.id)
      setBusyFormID(null)
    }
  }

  async function cancelForm(form: FormInfo) {
    if (busyFormRef.current.has(form.id)) return
    busyFormRef.current.add(form.id)
    setBusyFormID(form.id)
    try {
      await client.api.cancelForm(form.sessionID, form.id)
      markFormSettled(form, null)
    } catch (error) {
      if (isAmbiguousError(error)) {
        if (await confirmFormSettled(form)) {
          markFormSettled(form, null)
        } else {
          setBanner("The server did not answer in time — the question may not have been dismissed. Try again.")
        }
      } else {
        setBanner("Could not dismiss the question")
      }
    } finally {
      busyFormRef.current.delete(form.id)
      setBusyFormID(null)
    }
  }

  // The desktop sidebar holds one section list at a time: a 60px icon rail
  // when collapsed, or the panel (sections home / active section + options
  // box) when expanded. The mobile shell has no sidebar; the bottom nav
  // switches sections and an open chat takes over the screen. The edge-handle
  // curve reuses the border paint (`currentColor` over `--mh-hairline`) so it
  // tracks every palette; the straight border stays a CSS border and the SVG
  // only redraws the bump. Depth comes from a faint blurred copy underneath —
  // never a filter on the curve itself, which would tint it. The curve is
  // 1.25px (not 1px): on the sloped shoulders a 1px stroke never reaches full
  // coverage, so it reads fainter than the straight border.
  const collapseCurveD = sidebarCollapsed
    ? "M18.85 23.4 C18.85 35.1 33.15 36.4 33.15 46.8 C33.15 57.2 18.85 58.5 18.85 70.2"
    : "M18.85 23.4 C18.85 35.1 4.55 36.4 4.55 46.8 C4.55 57.2 18.85 58.5 18.85 70.2"
  const asideClass = [
    "hidden min-h-0 flex-row border-r border-hairline bg-canvas md:relative md:flex md:w-[272px] md:shrink-0",
    sidebarCollapsed ? "mh-aside-collapsed" : "",
  ].join(" ")
  // Opens the sections home, expanding the sidebar when collapsed (going
  // home needs the panel). The collapse choice stays persisted.
  function backToSections() {
    setSidebarShowsHome(true)
    if (!sidebarCollapsed) return
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, "0")
    } catch {
      // Storage may be unavailable (private mode); the toggle still works.
    }
    setSidebarCollapsed(false)
  }

  // Rail and panel never render together: the section navigation lives in
  // exactly one place. Mobile never mounts either (the aside is `hidden`).
  const showRail = sidebarCollapsed

  return (
    <div className="flex h-dvh flex-col bg-canvas text-ink">
      <header className="flex h-14 shrink-0 items-center gap-1 border-b border-hairline px-2 md:px-4">
        {/* Mobile back: an open chat takes over the screen (the bottom nav
            hides); this returns to the Sessions list. */}
        {sessionID && activeSection === "sessions" && (
          <button
            type="button"
            onClick={() => openSession(null)}
            className="mh-btn mh-btn--quiet md:hidden"
            aria-label="Back"
            title="Back"
          >
            <ChevronLeftIcon size={18} />
          </button>
        )}
        {/* Desktop back to the sections home, left of the title. Visible even
            when collapsed: going home needs the panel, so it expands it. */}
        {!sidebarShowsHome && (
          <button
            type="button"
            onClick={backToSections}
            className="mh-btn mh-btn--quiet max-md:hidden"
            aria-label="Back to sections"
            title="Back to sections"
          >
            <ChevronLeftIcon size={18} />
          </button>
        )}
        <h1 className="min-w-0 flex-1 truncate px-1 text-[15px] font-medium">
          {activeSection === "board"
            ? "Board"
            : activeSection === "scheduler"
              ? "Scheduler"
              : sessionID && selected
                ? selected.title || "Untitled"
                : "Sessions"}
        </h1>
        {isMobile && (
          <ServerSwitcher
            profiles={profiles}
            activeProfile={profile}
            variant="mobile"
            onSwitch={onSwitchServer}
            onManage={() => openSettings("servers")}
            onAdd={onAddServer}
          />
        )}
        {connected ? (
          <span
            className="mh-dot mh-dot--connected"
            title="Connected to opencode"
          />
        ) : (
          <span title="Reconnecting…">
            <WavesIcon size={14} className="shrink-0 text-ink-muted" />
          </span>
        )}
        {sessionID && activeSection === "sessions" && (
          <div className="hidden items-center gap-1 md:flex">
            <AuditTrigger onOpen={() => setPanel("audit")} />
            <RunPreviewTrigger sessionID={sessionID} workspaceID={workspaceID} onOpen={() => setPanel("run")} />
          </div>
        )}
        {/* Session-scoped overflow actions only: without them the mobile
            popover would open empty on the Board/Scheduler screens. */}
        {sessionID && activeSection === "sessions" && (
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
                  <div className="flex flex-col gap-0.5">
                    <AuditTrigger onOpen={() => setPanel("audit")} className="w-full justify-start" />
                    <RunPreviewTrigger
                      sessionID={sessionID}
                      workspaceID={workspaceID}
                      onOpen={() => setPanel("run")}
                      withLabel
                      className="w-full justify-start"
                    />
                  </div>
                </div>
              </>
            )}
          </div>
        )}
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

      {statusQuery.data?.storage?.ok === false && (
        <div className="mh-banner mh-banner--danger">
          The server cannot read its database (storage unavailable). Check the server disk and logs, then restore from a
          backup if needed.
        </div>
      )}

      {statusQuery.data?.storage?.low && (
        <div className="mh-banner mh-banner--warning">
          The server disk is almost full ({formatFreeBytes(statusQuery.data.storage.freeBytes)} free). Free space, or
          the database and git may fail.
        </div>
      )}

      <UpdateNotices status={statusQuery.data} latest={updateQuery.data?.latest} />

      {choiceForm ? null : waitingForm ? (
        <button
          type="button"
          onClick={() => openSessionInChat(waitingForm.sessionID)}
          className="mh-banner mh-banner--info"
        >
          <span className="mh-spin" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">The agent is waiting for your answer · Open session</span>
        </button>
      ) : null}

      {otherPermissionSessions.map((permissionSessionID) => (
        <button
          key={permissionSessionID}
          type="button"
          onClick={() => openSessionInChat(permissionSessionID)}
          className="mh-banner mh-banner--info"
        >
          <span className="mh-spin" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">Permission requested in another session · Open session</span>
        </button>
      ))}

      <div className="relative flex min-h-0 flex-1">
        {!isMobile && (
          <aside className={asideClass}>
            {/* Section rail: only when collapsed. Section icons live here and
                nowhere else in this state. */}
            {showRail && (
              <nav
                aria-label="Sections"
                className="flex w-[60px] shrink-0 flex-col items-center gap-1 border-r border-hairline py-3"
              >
                <button
                  type="button"
                  onClick={() => selectSection("sessions")}
                  className={`mh-btn mh-btn--quiet ${activeSection === "sessions" ? "bg-surface-muted text-ink" : ""}`}
                  aria-label="Sessions section"
                  title="Sessions"
                  aria-current={activeSection === "sessions" ? "page" : undefined}
                >
                  <ChatBubbleIcon size={18} />
                </button>
                <button
                  type="button"
                  onClick={() => selectSection("board")}
                  className={`mh-btn mh-btn--quiet ${activeSection === "board" ? "bg-surface-muted text-ink" : ""}`}
                  aria-label="Board section"
                  title="Board"
                  aria-current={activeSection === "board" ? "page" : undefined}
                >
                  <KanbanIcon size={18} />
                </button>
                <button
                  type="button"
                  onClick={() => selectSection("scheduler")}
                  className={`mh-btn mh-btn--quiet ${activeSection === "scheduler" ? "bg-surface-muted text-ink" : ""}`}
                  aria-label="Scheduler section"
                  title="Scheduler"
                  aria-current={activeSection === "scheduler" ? "page" : undefined}
                >
                  <ClockIcon size={18} />
                </button>
                <div className="mt-auto flex flex-col items-center gap-1">
                  <ServerSwitcher
                    profiles={profiles}
                    activeProfile={profile}
                    variant="sidebar"
                    collapsed
                    onSwitch={onSwitchServer}
                    onManage={() => openSettings("servers")}
                    onAdd={onAddServer}
                  />
                  <button
                    type="button"
                    onClick={() => openSettings()}
                    className="mh-btn mh-btn--quiet"
                    aria-label="Settings"
                    title="Settings"
                  >
                    <GearIcon size={18} />
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleLogout()}
                    className="mh-btn mh-btn--quiet"
                    aria-label="Disconnect"
                    title="Disconnect"
                  >
                    <LogOutIcon size={16} />
                  </button>
                </div>
              </nav>
            )}
            {/* Section panel: the sections home or the active section. The `<`
                back button only exists here, in the expanded sidebar. */}
            {!showRail && (
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                {sidebarShowsHome ? (
                  <div className="flex min-h-0 flex-1 flex-col">
                    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 py-3">
                      <div className="mh-session">
                        <button
                          type="button"
                          onClick={() => selectSection("sessions")}
                          className={`mh-session-item ${activeSection === "sessions" ? "is-active" : ""}`}
                        >
                          <span className="mh-session-item__top">
                            <ChatBubbleIcon size={18} />
                            <span className="mh-session-item__title">Sessions</span>
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => selectSection("board")}
                          className={`mh-session-item ${activeSection === "board" ? "is-active" : ""}`}
                        >
                          <span className="mh-session-item__top">
                            <KanbanIcon size={18} />
                            <span className="mh-session-item__title">Board</span>
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => selectSection("scheduler")}
                          className={`mh-session-item ${activeSection === "scheduler" ? "is-active" : ""}`}
                        >
                          <span className="mh-session-item__top">
                            <ClockIcon size={18} />
                            <span className="mh-session-item__title">Scheduler</span>
                          </span>
                        </button>
                      </div>
                    </div>
                  </div>
                ) : activeSection === "sessions" ? (
                  <SessionList
                    sessions={sessions}
                    statuses={statuses}
                    selectedID={sessionID}
                    onSelect={openSession}
                    onDelete={setRemoveSessionID}
                    hasWorkspace={Boolean(workspaceID)}
                    onCreateSession={(isolated) => void createSession(isolated)}
                    creating={creating}
                    serverID={profile.id}
                  />
                ) : activeSection === "scheduler" ? (
                  <SchedulerPanel onOpenSession={openSessionInChat} />
                ) : (
                  <div className="flex min-h-0 flex-1 flex-col">
                    <BoardPanel workspaceID={workspaceID} />
                  </div>
                )}
                {/* Bottom-left options box: app-level actions live here, not in the top bar. */}
                <div className="flex shrink-0 flex-col gap-2 border-t border-hairline p-3">
                  <ServerSwitcher
                    profiles={profiles}
                    activeProfile={profile}
                    variant="sidebar"
                    onSwitch={onSwitchServer}
                    onManage={() => openSettings("servers")}
                    onAdd={onAddServer}
                  />
                  <div className="flex w-fit items-center gap-2 rounded-md border border-hairline bg-surface p-1">
                    <button
                      type="button"
                      onClick={() => openSettings()}
                      className="mh-btn mh-btn--quiet"
                      aria-label="Settings"
                      title="Settings"
                    >
                      <GearIcon size={18} />
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleLogout()}
                      className="mh-btn mh-btn--ghost"
                    >
                      <LogOutIcon size={16} />
                      Disconnect
                    </button>
                  </div>
                </div>
              </div>
            )}
            {/* Edge handle: the desktop-only collapse toggle. The sidebar border
                opens into a curve that wraps the bare arrow — an SVG covers the
                straight segment and redraws it bumping outward when collapsed,
                inward when expanded. */}
            <div className="absolute -right-[17.5px] top-1/2 z-20 max-md:hidden -translate-y-1/2">
              <svg
                width="36"
                height="94"
                viewBox="0 0 36.4 93.6"
                aria-hidden="true"
                className="block"
                style={{ color: "var(--mh-hairline)" }}
              >
                <defs>
                  <filter id="mh-collapse-shadow" x="-60%" y="-30%" width="220%" height="160%">
                    <feGaussianBlur stdDeviation="0.4" />
                  </filter>
                </defs>
                <path
                  d="M18.85 23.4 L18.85 70.2"
                  fill="none"
                  strokeWidth="3"
                  style={{ stroke: "var(--mh-canvas)" }}
                />
                <path
                  d={collapseCurveD}
                  fill="none"
                  strokeWidth="1"
                  opacity="0.35"
                  transform="translate(0.5 0.6)"
                  filter="url(#mh-collapse-shadow)"
                  style={{ stroke: "light-dark(rgba(12, 12, 11, 0.16), rgba(0, 0, 0, 0.5))" }}
                />
                <path d={collapseCurveD} fill="none" stroke="currentColor" strokeWidth="1.25" />
              </svg>
              <button
                type="button"
                onClick={toggleSidebarCollapsed}
                className={`absolute inset-0 flex items-center justify-center rounded-sm text-ink-muted hover:text-ink ${sidebarCollapsed ? "" : "-translate-x-1.5"}`}
                aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                aria-expanded={!sidebarCollapsed}
              >
                {sidebarCollapsed ? <ChevronRightIcon size={18} /> : <ChevronLeftIcon size={18} />}
              </button>
            </div>
          </aside>
        )}

        <main className="relative flex min-w-0 flex-1 flex-col">
          {activeSection === "board" ? (
            <BoardView
              workspaceID={workspaceID}
              workspaces={workspaces}
              onSelectWorkspace={switchWorkspace}
              onAddWorkspace={() => setAddingWorkspace(true)}
              onRemoveWorkspace={setRemoveWorkspaceID}
            />
          ) : activeSection === "scheduler" ? (
            <>
              {/* Mobile: the scheduler is the task manager itself, full-screen. */}
              {isMobile && (
                <div className="flex min-h-0 flex-1 flex-col">
                  <SchedulerPanel onOpenSession={openSessionInChat} />
                </div>
              )}
              {/* Desktop: the manager lives in the sidebar panel; the main view
                  explains where it is. */}
              {!isMobile && (
                <div className="relative flex flex-1 flex-col items-center justify-center gap-5 p-6">
                  <div className="mh-empty w-full max-w-lg border-0 bg-transparent">
                    <Deco variant="blob" style={{ top: -80, right: -80, width: 280, height: 260 }} />
                    <Deco variant="dots" style={{ bottom: -12, left: -20 }} />
                    <ClockIcon size={26} className="text-ink-faint" />
                    <h3 className="mh-heading-2">Scheduled prompts</h3>
                    <p className="mh-empty__body mh-body-sm">
                      Tasks fire a prompt into an opencode session on their schedule — create one from the sidebar panel.
                    </p>
                  </div>
                </div>
              )}
            </>
          ) : sessionID ? (
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
            <>
              {/* Mobile: Sessions opens the list itself (the drawer is gone);
                  workspace switching stays reachable above it. */}
              {isMobile && (
                <div className="flex min-h-0 flex-1 flex-col">
                  <div className="flex shrink-0 items-center gap-2 border-b border-hairline px-3 py-2">
                    <WorkspacePicker
                      workspaces={workspaces}
                      selectedID={workspaceID}
                      onSelect={switchWorkspace}
                      onAdd={() => setAddingWorkspace(true)}
                      onDelete={setRemoveWorkspaceID}
                    />
                  </div>
                  <SessionList
                    sessions={sessions}
                    statuses={statuses}
                    selectedID={sessionID}
                    onSelect={openSession}
                    onDelete={setRemoveSessionID}
                    hasWorkspace={Boolean(workspaceID)}
                    onCreateSession={(isolated) => void createSession(isolated)}
                    creating={creating}
                    serverID={profile.id}
                  />
                </div>
              )}
              {/* Desktop: the session list is the sidebar panel; the main view
                  keeps the composer toolbar and the empty state. */}
              {!isMobile && (
                <div className="relative flex flex-1 flex-col items-center justify-center gap-5 p-6">
                  <SessionToolbar
                    workspaces={workspaces}
                    workspaceID={workspaceID}
                    onSelectWorkspace={switchWorkspace}
                    onAddWorkspace={() => setAddingWorkspace(true)}
                    onRemoveWorkspace={setRemoveWorkspaceID}
                    branch={workspaceID ? <BranchPicker workspaceID={workspaceID} /> : undefined}
                  />
                  <div className="mh-empty w-full max-w-lg border-0 bg-transparent">
                    <Deco variant="blob" style={{ top: -80, right: -80, width: 280, height: 260 }} />
                    <Deco variant="dots" style={{ bottom: -12, left: -20 }} />
                    <h3 className="mh-heading-2">No session open</h3>
                    <p className="mh-empty__body mh-body-sm">Pick one from the session list or start a new one.</p>
                  </div>
                </div>
              )}
            </>
          )}

          {sessionID && parentSessionID && activeSection === "sessions" && (
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

      {/* Mobile home chrome: an open chat takes over the screen exactly like
          the native app. The component also carries `md:hidden` as defense. */}
      {isMobile && !(sessionID && activeSection === "sessions") && (
        <BottomNav
          section={activeSection}
          onSelectSection={selectHomeSection}
          onOpenSettings={() => openSettings()}
        />
      )}

      {choiceForm && (
        <ChoiceModal
          form={choiceForm}
          busy={busyFormID === choiceForm.id}
          onRespond={(form, answer) => void respondForm(form, answer)}
          onCancel={(form) => void cancelForm(form)}
          onOpenSession={() => openSessionInChat(choiceForm.sessionID)}
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
      {panel === "settings" && (
        <SettingsDialog
          mode={themeMode.mode}
          onSelectMode={themeMode.setMode}
          palette={themeMode.palette}
          onSelectPalette={themeMode.setPalette}
          onSignOut={() => void handleLogout()}
          onClose={() => setPanel(null)}
          initialModule={settingsModule}
          servers={{
            profiles,
            activeID: profile.id,
            onRename: onRenameServer,
            onDisconnect: onDisconnectServer,
            onRemove: onRemoveServer,
            onAdd: onAddServer,
          }}
        />
      )}
      {sessionID && panel === "run" && (
        <RunPreviewSheet sessionID={sessionID} workspaceID={workspaceID} onClose={() => setPanel(null)} />
      )}
    </div>
  )
}
