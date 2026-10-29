import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Alert, AppState, Platform, Pressable, StyleSheet, View } from "react-native"
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query"
import { fetch as expoFetch } from "expo/fetch"
import { useFonts } from "expo-font"
import { Fraunces_400Regular, Fraunces_500Medium, Fraunces_600SemiBold } from "@expo-google-fonts/fraunces"
import {
  InstrumentSans_400Regular,
  InstrumentSans_500Medium,
  InstrumentSans_600SemiBold,
} from "@expo-google-fonts/instrument-sans"
import { JetBrainsMono_400Regular, JetBrainsMono_500Medium } from "@expo-google-fonts/jetbrains-mono"
import {
  ApiError,
  createClient,
  createEventHandler,
  defaultServerLabel,
  formIsQuestion,
  invalidateOnReconnect,
  isMixedContentBlocked,
  MAX_SERVER_PROFILES,
  normalizeServerLabel,
  normalizeServerUrl,
  reconcileForms,
  reconcilePermissions,
  rootSessions,
  serverUrlErrorMessage,
  shouldAutoAccept,
  useEventStream,
  useSessionDirectories,
  useSessions,
  useSessionStatuses,
  useWorkspaces,
  type Client,
  type CreateWorkspaceInput,
  type FormAnswer,
  type FormInfo,
  type Permission,
  type Session,
} from "@masterhand/client-core"
import { SafeAreaProvider } from "react-native-safe-area-context"
import { GestureHandlerRootView } from "react-native-gesture-handler"
import { ServersScreen } from "./src/screens/ServersScreen"
import { SessionsScreen, type HomeSection } from "./src/screens/SessionsScreen"
import { BoardScreen } from "./src/screens/BoardScreen"
import { ChatScreen } from "./src/screens/ChatScreen"
import { PermissionModal } from "./src/components/PermissionModal"
import { SchedulerSection } from "./src/components/SchedulerSection"
import { SettingsModal } from "./src/components/SettingsModal"
import { ServerSwitcher } from "./src/components/ServerSwitcher"
import { UpdateBanner } from "./src/components/UpdateNotice"
import { Screen } from "./src/components/Screen"
import { ThemedSystemBars } from "./src/components/SystemBars"
import { ActivityIndicator, Text } from "react-native"
import {
  fonts as appFonts,
  systemFonts,
  ThemeProvider,
  useTheme,
  useThemedStyles,
  type Fonts,
  type Palette,
} from "./src/theme"
import {
  clearServerToken,
  getOrCreateInstallID,
  loadAutoAcceptSessionsFor,
  loadServerRegistry,
  loadServerToken,
  newServerID,
  saveAutoAcceptSessionsFor,
  saveServerRegistry,
  saveServerToken,
  type ServerRegistry,
  type StoredServerProfile,
} from "./src/storage"

const fetchImpl = expoFetch as unknown as typeof fetch

/** Auto-accept retry policy: bounded attempts with a short backoff (web parity). */
const AUTO_ACCEPT_MAX_ATTEMPTS = 3
const AUTO_ACCEPT_RETRY_DELAYS_MS = [1_000, 3_000]

export default function App() {
  // Render even before the fonts resolve: the theme falls back to system
  // families and swaps in the loaded ones when they are ready.
  const [fontsLoaded] = useFonts({
    InstrumentSans_400Regular,
    InstrumentSans_500Medium,
    InstrumentSans_600SemiBold,
    Fraunces_400Regular,
    Fraunces_500Medium,
    Fraunces_600SemiBold,
    JetBrainsMono_400Regular,
    JetBrainsMono_500Medium,
  })

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider fonts={fontsLoaded ? appFonts : systemFonts}>
          <ThemedSystemBars />
          <Root />
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}

function newQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: 1 } } })
}

/** Same server under another saved hostname: revoking one token kills both. */
function sharesDevice(profiles: StoredServerProfile[], profile: StoredServerProfile): boolean {
  if (!profile.device) return false
  return profiles.some(
    (item) => item.id !== profile.id && item.device?.id === profile.device?.id,
  )
}

function connectErrorMessage(error: unknown, url: string): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "Wrong password. Try again."
    if (error.status === 429) return "Too many attempts; wait 15 minutes."
    if (error.status === 400) return "Check the server URL and password."
    if (error.status === 404) return "This server does not expose the MasterHand API (404)."
    return `The server answered with error ${error.status}.`
  }
  let host = url
  try {
    host = new URL(url).host
  } catch {
    // keep the raw value
  }
  return `Could not reach ${host}. Check the URL, the network, and that the server is running.`
}

/**
 * Multi-server root (ADR-39): profile registry, one active client and one
 * QueryClient. Switching remounts the authenticated tree (keyed by profile id)
 * and therefore stops the old SSE stream and discards its cache.
 */
function Root() {
  const [ready, setReady] = useState(false)
  const [registry, setRegistry] = useState<ServerRegistry>({ profiles: [], activeID: null })
  const [view, setView] = useState<"servers" | "app">("servers")
  const [activeProfile, setActiveProfile] = useState<StoredServerProfile | null>(null)
  const [connection, setConnection] = useState<Client | null>(null)
  const [queryClient, setQueryClient] = useState<QueryClient>(newQueryClient)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [reauthProfile, setReauthProfile] = useState<StoredServerProfile | null>(null)
  const [openAdd, setOpenAdd] = useState(false)
  const [storageWarning, setStorageWarning] = useState<string | null>(null)
  const [draft, setDraft] = useState<{ url: string; label: string } | null>(null)
  const [connecting, setConnecting] = useState<{ label: string; url: string } | null>(null)
  const connectGenerationRef = useRef(0)
  const connectInFlightRef = useRef<Promise<void> | null>(null)
  const activeRef = useRef<StoredServerProfile | null>(null)
  const connectionRef = useRef<Client | null>(null)
  const viewRef = useRef<"servers" | "app">(view)
  const registryRef = useRef(registry)
  registryRef.current = registry
  activeRef.current = activeProfile
  connectionRef.current = connection
  viewRef.current = view
  const expireRef = useRef<(profileID: string, client?: Client) => void>(() => {})
  // Drop the previous server's cache (and its gc timers) on switch/unmount.
  useEffect(() => () => queryClient.clear(), [queryClient])
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()

  const persistRegistry = useCallback((next: ServerRegistry) => {
    setRegistry(next)
    void saveServerRegistry(next).catch(() => {
      setStorageWarning(
        "The server list could not be saved to this device's secure storage. It will work until the app restarts.",
      )
    })
  }, [])

  const enter = useCallback(
    (profile: StoredServerProfile, token: string) => {
      let nextClient: Client
      nextClient = createClient({
        baseUrl: profile.url,
        // Capture this profile's token: a later switch must never make an old
        // client send the new profile's credential.
        getToken: () => token,
        fetchImpl,
        onUnauthorized: () => expireRef.current(profile.id, nextClient),
      })
      connectionRef.current = nextClient
      connectionRef.current = nextClient
      setConnection(nextClient)
      setActiveProfile(profile)
      setQueryClient(newQueryClient())
      setBusy(false)
      setError(null)
      setReauthProfile(null)
      setView("app")
    },
    [],
  )

  const expire = useCallback(
    (profileID: string, client?: Client) => {
      // A late 401 from a replaced client must not abort a switch or expire
      // the profile that is no longer mounted.
      if (viewRef.current !== "app") return
      if (client && connectionRef.current !== client) return
      if (activeRef.current?.id !== profileID) return
      void clearServerToken(profileID).catch(() => {})
      const previous = registryRef.current
      const profile = previous.profiles.find((item) => item.id === profileID) ?? null
      const next: ServerRegistry = {
        profiles: previous.profiles.map((item) =>
          item.id === profileID ? { ...item, expired: true } : item,
        ),
        activeID: null,
      }
      persistRegistry(next)
      setActiveProfile(null)
      setConnection(null)
      setQueryClient(newQueryClient())
      setReauthProfile(profile ? { ...profile, expired: true } : null)
      setError(profile ? `${profile.label}'s saved session expired. Enter its password again.` : null)
      viewRef.current = "servers"
      setView("servers")
    },
    [persistRegistry],
  )
  expireRef.current = expire

  // Boot: the last active profile connects with its saved token (no re-auth);
  // a missing token opens the Servers screen for a password prompt.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const stored = await loadServerRegistry()
        if (cancelled) return
        setRegistry(stored)
        const active = stored.profiles.find((item) => item.id === stored.activeID) ?? null
        if (active) {
          const token = await loadServerToken(active.id)
          if (cancelled) return
          if (token && !active.expired) {
            enter(active, token)
          } else {
            setReauthProfile(active.expired ? active : null)
            setView("servers")
          }
        }
      } catch {
        // SecureStore failures must never leave the app on a permanent spinner
        // (#82): show the Servers screen with a specific message.
        setError("Could not read the saved servers from this device's secure storage.")
      } finally {
        if (!cancelled) setReady(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [enter])

  const connect = useCallback(
    async (profile: StoredServerProfile, password: string, mode: "first-run" | "add" | "reauth") => {
      const run = ++connectGenerationRef.current
      const previous = connectInFlightRef.current
      let release!: () => void
      const inFlight = new Promise<void>((resolve) => {
        release = resolve
      })
      connectInFlightRef.current = inFlight
      setBusy(true)
      setError(null)
      setNotice(null)
      setConnecting({ label: profile.label, url: profile.url })
      let issued: { token: string; device: { id: string } } | null = null
      let cancelled = false

      try {
        // A cancelled attempt may still be revoking its just-issued token: let
        // it finish before this attempt logs in, so revocation cannot invalidate
        // the new token (same stable installID/device row).
        if (previous) await previous
        if (run !== connectGenerationRef.current) {
          cancelled = true
          return
        }

        const candidate = createClient({ baseUrl: profile.url, fetchImpl })
        const deviceName = Platform.OS === "ios" ? "iOS device" : "Android device"
        const installID = await getOrCreateInstallID()
        if (run !== connectGenerationRef.current) {
          cancelled = true
          return
        }
        const result = await candidate.auth.loginDevice(password, deviceName, installID)
        issued = result
        if (run !== connectGenerationRef.current) {
          cancelled = true
          return
        }

        let persistenceWarning = false
        try {
          await saveServerToken(profile.id, result.token)
        } catch {
          persistenceWarning = true
        }
        if (run !== connectGenerationRef.current) {
          cancelled = true
          await clearServerToken(profile.id).catch(() => {})
          return
        }

        const nextProfile: StoredServerProfile = {
          ...profile,
          device: result.device,
          expired: false,
          lastUsedAt: Date.now(),
        }
        const previousRegistry = registryRef.current
        const next: ServerRegistry = {
          profiles: previousRegistry.profiles.some((item) => item.id === nextProfile.id)
            ? previousRegistry.profiles.map((item) => (item.id === nextProfile.id ? nextProfile : item))
            : [...previousRegistry.profiles, nextProfile],
          activeID: nextProfile.id,
        }
        if (run !== connectGenerationRef.current) {
          cancelled = true
          await clearServerToken(profile.id).catch(() => {})
          return
        }
        persistRegistry(next)
        if (persistenceWarning) {
          setStorageWarning(
            "Signed in, but this device could not save the session. You will need to sign in again after restarting.",
          )
        }
        setOpenAdd(false)
        setDraft(null)
        enter(nextProfile, result.token)
      } catch (err) {
        if (run !== connectGenerationRef.current) {
          cancelled = true
          return
        }
        setError(connectErrorMessage(err, profile.url))
        setReauthProfile(mode === "reauth" ? profile : null)
        setOpenAdd(mode === "add")
      } finally {
        if (cancelled || run !== connectGenerationRef.current) {
          if (issued) {
            let residual = false
            try {
              const revokeClient = createClient({
                baseUrl: profile.url,
                getToken: () => issued!.token,
                fetchImpl,
                timeoutMs: 10_000,
              })
              await revokeClient.auth.revokeDevice(issued.device.id)
            } catch {
              residual = true
            }
            if (residual) {
              setNotice("Cancelled. The just-issued device token could not be revoked.")
            }
          }
        }
        release()
        if (connectInFlightRef.current === inFlight) connectInFlightRef.current = null
        if (run === connectGenerationRef.current) {
          setBusy(false)
          setConnecting(null)
        }
      }
    },
    [enter, persistRegistry],
  )

  const submit = useCallback(
    (mode: "first-run" | "add" | "reauth", values: { url: string; label: string; password: string }, profile?: StoredServerProfile) => {
      setError(null)
      setDraft({ url: values.url, label: values.label })
      if (mode !== "reauth" && registryRef.current.profiles.length >= MAX_SERVER_PROFILES) {
        setError(`You can save at most ${MAX_SERVER_PROFILES} servers.`)
        return
      }
      const normalized = normalizeServerUrl(values.url)
      if (!normalized.ok) {
        setError(serverUrlErrorMessage(normalized.error))
        return
      }
      if (isMixedContentBlocked(normalized.server.url, null)) {
        setError("Use https:// for remote servers.")
        return
      }
      const duplicate = registryRef.current.profiles.find(
        (item) => item.url === normalized.server.url,
      )
      if (mode !== "reauth" && duplicate) {
        setError("This server is already saved.")
        return
      }
      const target =
        mode === "reauth" && profile
          ? profile
          : {
              id: newServerID(),
              label: normalizeServerLabel(values.label, normalized.server.url),
              url: normalized.server.url,
              device: null,
              lastWorkspaceID: null,
              lastSessionID: null,
              expired: false,
              lastUsedAt: Date.now(),
            }
      void connect(target, values.password, mode)
    },
    [connect],
  )

  const select = useCallback(
    (profile: StoredServerProfile) => {
      setError(null)
      setNotice(null)
      const run = ++connectGenerationRef.current
      setConnecting({ label: profile.label, url: profile.url })
      setBusy(true)
      viewRef.current = "servers"
      setView("servers")
      void (async () => {
        try {
          const token = await loadServerToken(profile.id).catch(() => null)
          if (run !== connectGenerationRef.current) return
          if (!token) {
            setReauthProfile(profile)
            return
          }
          const candidate = createClient({
            baseUrl: profile.url,
            getToken: () => token,
            fetchImpl,
          })
          // Verify the saved token before showing the app; a 401 must go to
          // re-auth instead of a half-connected screen.
          await candidate.auth.status()
          if (run !== connectGenerationRef.current) return
          const nextProfile: StoredServerProfile = {
            ...profile,
            expired: false,
            lastUsedAt: Date.now(),
          }
          const previous = registryRef.current
          persistRegistry({
            profiles: previous.profiles.some((item) => item.id === nextProfile.id)
              ? previous.profiles.map((item) => (item.id === nextProfile.id ? nextProfile : item))
              : [...previous.profiles, nextProfile],
            activeID: nextProfile.id,
          })
          enter(nextProfile, token)
        } catch (err) {
          if (run !== connectGenerationRef.current) return
          const expired = err instanceof ApiError && err.status === 401
          if (expired) {
            await clearServerToken(profile.id).catch(() => {})
            const previous = registryRef.current
            persistRegistry({
              profiles: previous.profiles.map((item) =>
                item.id === profile.id ? { ...item, expired: true } : item,
              ),
              activeID: null,
            })
            setReauthProfile({ ...profile, expired: true })
            setError(`${profile.label}'s saved session expired. Enter its password again.`)
          } else {
            setError(connectErrorMessage(err, profile.url))
          }
        } finally {
          if (run === connectGenerationRef.current) {
            setBusy(false)
            setConnecting(null)
          }
        }
      })()
    },
    [enter, persistRegistry],
  )

  const reportResidual = useCallback((message: string) => {
    if (viewRef.current === "servers") setNotice(message)
    else Alert.alert("Connection", message)
  }, [])

  const disconnect = useCallback(
    (profile: StoredServerProfile) => {
      const shared = sharesDevice(registryRef.current.profiles, profile)
      const wasActive = activeRef.current?.id === profile.id
      const previous = registryRef.current
      // Switch the UI and drop the profile's active marker immediately; the
      // idempotent revocation runs in the background.
      persistRegistry({
        profiles: previous.profiles.map((item) =>
          item.id === profile.id ? { ...item, expired: false } : item,
        ),
        activeID: wasActive ? null : previous.activeID,
      })
      if (wasActive) {
        connectionRef.current = null
        setActiveProfile(null)
        setConnection(null)
        setQueryClient(newQueryClient())
        setReauthProfile(null)
        setError(null)
        viewRef.current = "servers"
        setView("servers")
      }

      void (async () => {
        const token = await loadServerToken(profile.id).catch(() => null)
        await clearServerToken(profile.id).catch(() => {})
        if (!token || !profile.device || shared) return
        try {
          const target = createClient({
            baseUrl: profile.url,
            getToken: () => token,
            fetchImpl,
            timeoutMs: 10_000,
          })
          await target.auth.revokeDevice(profile.device.id)
        } catch {
          reportResidual(
            "Disconnected. The device token could not be revoked; revoke it from that server's settings.",
          )
        }
      })()
    },
    [persistRegistry, reportResidual],
  )

  const remove = useCallback(
    (profile: StoredServerProfile) => {
      const shared = sharesDevice(registryRef.current.profiles, profile)
      const wasActive = activeRef.current?.id === profile.id
      const previous = registryRef.current
      persistRegistry({
        profiles: previous.profiles.filter((item) => item.id !== profile.id),
        activeID: wasActive ? null : previous.activeID,
      })
      if (wasActive) {
        connectionRef.current = null
        setActiveProfile(null)
        setConnection(null)
        setQueryClient(newQueryClient())
        setReauthProfile(null)
        setError(null)
        setNotice("Server removed")
        viewRef.current = "servers"
        setView("servers")
      }

      void (async () => {
        const token = await loadServerToken(profile.id).catch(() => null)
        await clearServerToken(profile.id).catch(() => {})
        if (!token || !profile.device || shared) return
        try {
          const target = createClient({
            baseUrl: profile.url,
            getToken: () => token,
            fetchImpl,
            timeoutMs: 10_000,
          })
          await target.auth.revokeDevice(profile.device.id)
        } catch {
          reportResidual(
            "Server removed. Its device token could not be revoked — revoke it from that server's settings.",
          )
        }
      })()
    },
    [persistRegistry, reportResidual],
  )

  const rename = useCallback(
    (profile: StoredServerProfile, label: string) => {
      const previous = registryRef.current
      persistRegistry({
        ...previous,
        profiles: previous.profiles.map((item) =>
          item.id === profile.id ? { ...item, label: normalizeServerLabel(label, item.url) } : item,
        ),
      })
    },
    [persistRegistry],
  )

  const updateProfileState = useCallback(
    (profileID: string, patch: Partial<Pick<StoredServerProfile, "lastWorkspaceID" | "lastSessionID">>) => {
      const previous = registryRef.current
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
      if (changed) persistRegistry({ ...previous, profiles })
    },
    [persistRegistry],
  )

  const openAddServer = useCallback(() => {
    setOpenAdd(true)
    setDraft(null)
    setError(null)
    setNotice(null)
    setReauthProfile(null)
    setView("servers")
  }, [])

  if (!ready) {
    return (
      <Screen style={styles.centered}>
        <ActivityIndicator color={colors.accent} />
      </Screen>
    )
  }

  const currentProfile = activeProfile
    ? (registry.profiles.find((item) => item.id === activeProfile.id) ?? activeProfile)
    : null

  if (view === "servers" || !currentProfile || !connection) {
    return (
      <ServersScreen
        profiles={registry.profiles}
        activeID={view === "app" ? currentProfile?.id ?? null : null}
        initialUrl=""
        busy={busy}
        error={error}
        notice={notice}
        reauthProfile={reauthProfile}
        startAdding={openAdd}
        draft={draft}
        connecting={connecting}
        onSubmit={submit}
        onSelect={select}
        onCancel={() => {
          setOpenAdd(false)
          setDraft(null)
          setReauthProfile(null)
          setError(null)
        }}
        onCancelAdd={() => {
          setOpenAdd(false)
          setDraft(null)
          setError(null)
        }}
        onCancelConnect={() => {
          connectGenerationRef.current += 1
          setConnecting(null)
          setBusy(false)
          setError(null)
        }}
      />
    )
  }

  return (
    <QueryClientProvider client={queryClient}>
      <AuthenticatedApp
        key={currentProfile.id}
        client={connection}
        profile={currentProfile}
        profiles={registry.profiles}
        initialBanner={storageWarning}
        onDisconnect={disconnect}
        onDisconnectServer={(profile) => void disconnect(profile)}
        onRemoveServer={(profile) => void remove(profile)}
        onRenameServer={rename}
        onAddServer={openAddServer}
        onProfileState={(patch) => updateProfileState(currentProfile.id, patch)}
        onSwitch={(profile) => select(profile)}
      />
    </QueryClientProvider>
  )
}

function AuthenticatedApp({
  client,
  profile,
  profiles,
  initialBanner = null,
  onDisconnect,
  onDisconnectServer,
  onRemoveServer,
  onRenameServer,
  onAddServer,
  onProfileState,
  onSwitch,
}: {
  client: Client
  profile: StoredServerProfile
  profiles: StoredServerProfile[]
  initialBanner?: string | null
  onDisconnect: (profile: StoredServerProfile) => void
  onDisconnectServer: (profile: StoredServerProfile) => void
  onRemoveServer: (profile: StoredServerProfile) => void
  onRenameServer: (profile: StoredServerProfile, label: string) => void
  onAddServer: () => void
  onProfileState: (patch: Partial<Pick<StoredServerProfile, "lastWorkspaceID" | "lastSessionID">>) => void
  onSwitch: (profile: StoredServerProfile) => void
}) {
  const queryClient = useQueryClient()
  const [sessionID, setSessionID] = useState<string | null>(profile.lastSessionID)
  const [workspaceID, setWorkspaceID] = useState<string | null>(profile.lastWorkspaceID)
  const [permissions, setPermissions] = useState<Permission[]>([])
  const [forms, setForms] = useState<FormInfo[]>([])
  const [answeredForms, setAnsweredForms] = useState<Array<{ form: FormInfo; answer: FormAnswer }>>([])
  const [busyFormID, setBusyFormID] = useState<string | null>(null)
  const [responding, setResponding] = useState(false)
  const [connected, setConnected] = useState(false)
  const [creating, setCreating] = useState(false)
  const [banner, setBanner] = useState<string | null>(initialBanner)
  const [autoAcceptSessions, setAutoAcceptSessions] = useState<string[]>([])
  const autoAcceptLoaded = useRef(false)
  // App-level settings modal (Servers, Appearance, Providers, Account).
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<"servers" | null>(null)
  // Home section (Sessions/Scheduler), mirroring the web sidebar rail. The
  // chat takes over the screen while a session is open; backing out returns
  // to the selected section.
  const [section, setSection] = useState<HomeSection>("sessions")
  // Set when the user switches workspace: drop the open session and open the
  // new workspace's most recent one once its session list arrives.
  const pendingWorkspaceAutoOpenRef = useRef(false)
  const styles = useThemedStyles(createStyles)
  const { mode, setMode, palette, setPalette } = useTheme()

  useEffect(() => {
    void loadAutoAcceptSessionsFor(profile.id).then((ids) => {
      setAutoAcceptSessions(ids)
      autoAcceptLoaded.current = true
    })
  }, [profile.id])

  useEffect(() => {
    if (!autoAcceptLoaded.current) return
    void saveAutoAcceptSessionsFor(profile.id, autoAcceptSessions).catch(() => {})
  }, [autoAcceptSessions, profile.id])

  useEffect(() => {
    onProfileState({ lastSessionID: sessionID })
  }, [sessionID, onProfileState])
  useEffect(() => {
    onProfileState({ lastWorkspaceID: workspaceID })
  }, [workspaceID, onProfileState])

  // Mirrors for the memoized event handler: it must see the latest values
  // without being recreated (which would resubscribe the stream).
  const autoAcceptSessionsRef = useRef(autoAcceptSessions)
  autoAcceptSessionsRef.current = autoAcceptSessions
  const answeringRef = useRef(new Set<string>())
  // Auto-accept failures are retried with backoff (bounded); after the cap the
  // user is pointed at the inline card instead of the session stalling forever.
  // `autoPending` tracks requests only auto-accept answers, so a stale retry
  // can drop itself.
  const autoPendingRef = useRef(new Set<string>())
  const autoAcceptAttemptsRef = useRef(new Map<string, number>())
  const autoAcceptTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  // Requests whose auto-accept budget is spent: the drain effect (which now also
  // re-runs on every session refresh) must not restart the cycle until the
  // request is gone or answered elsewhere.
  const autoGivenUpRef = useRef(new Set<string>())
  // Session graph mirror for the event handler (subagent inheritance and the
  // forced Goal Mode critic/judge auto-accept), kept fresh without resubscribing.
  const sessionsRef = useRef<Session[]>([])

  /** Answers a permission request automatically ("once", reversible). */
  const answerAuto = useCallback(
    async (permission: Permission, retry = false) => {
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
      } catch {
        const attempts = (autoAcceptAttemptsRef.current.get(permission.id) ?? 0) + 1
        if (attempts < AUTO_ACCEPT_MAX_ATTEMPTS) {
          autoAcceptAttemptsRef.current.set(permission.id, attempts)
          const delay =
            AUTO_ACCEPT_RETRY_DELAYS_MS[attempts - 1] ??
            AUTO_ACCEPT_RETRY_DELAYS_MS[AUTO_ACCEPT_RETRY_DELAYS_MS.length - 1]!
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
    },
    [client],
  )
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

  const workspacesQuery = useWorkspaces(client, true)
  const workspaces = workspacesQuery.data ?? []
  const workspace = workspaces.find((item) => item.id === workspaceID) ?? null
  const workspacePath = workspace?.path ?? null
  const directoriesQuery = useSessionDirectories(client, true, workspaceID)

  useEffect(() => {
    if (!workspacesQuery.data) return
    if (workspaceID && workspacesQuery.data.some((item) => item.id === workspaceID)) return
    setWorkspaceID(workspacesQuery.data[0]?.id ?? null)
  }, [workspacesQuery.data, workspaceID])

  const sessionsQuery = useSessions(client, true, 10_000, workspaceID)
  const statusesQuery = useSessionStatuses(client, true, connected)
  const statuses = statusesQuery.data ?? {}
  const sessions = sessionsQuery.data ?? []
  sessionsRef.current = sessions
  const selected = sessions.find((session) => session.id === sessionID) ?? null
  const parentSessionID = selected?.parentID ?? null
  const busy = sessionID ? statuses[sessionID]?.type === "busy" : false

  // The open session belongs to one workspace. `switchWorkspace` drops it and
  // sets this flag; once the new workspace's session list is available, open
  // its most recent session instead of leaving another workspace's chat on
  // screen (same behavior as web).
  useEffect(() => {
    if (!pendingWorkspaceAutoOpenRef.current) return
    if (!sessionsQuery.isSuccess) return
    pendingWorkspaceAutoOpenRef.current = false
    // Auto-open only listable sessions: a Goal Mode critic session is often the
    // most recently updated and must never be opened by fallback.
    const next = rootSessions([...sessions].sort((a, b) => b.time.updated - a.time.updated))[0]?.id ?? null
    if (next !== sessionID) setSessionID(next)
  }, [sessionsQuery.isSuccess, sessions, sessionID])

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
          autoPendingRef.current.delete(permissionID)
          autoGivenUpRef.current.delete(permissionID)
          const timer = autoAcceptTimersRef.current.get(permissionID)
          if (timer) {
            clearTimeout(timer)
            autoAcceptTimersRef.current.delete(permissionID)
          }
          setPermissions((prev) => prev.filter((item) => item.id !== permissionID))
        },
        onForm: (form) => setForms((prev) => (prev.some((item) => item.id === form.id) ? prev : [...prev, form])),
        onFormSettled: (formID) => setForms((prev) => prev.filter((item) => item.id !== formID)),
        onSessionError: (message) => setBanner(message),
        onServerConnected: () => void syncPendingRef.current(),
      }),
    [],
  )

  // `permission.asked` and `form.created` events are lost while the app is
  // backgrounded and never replayed. Reconcile against opencode on connect and
  // when workspaces load.
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
  }, [syncPending])

  const forceReconnect = useEventStream(client, {
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
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") return
      // The socket usually dies while the app is suspended (and the reconnect
      // ladder may have grown meanwhile): reconnect now instead of waiting.
      forceReconnect()
      syncPending()
    })
    return () => subscription.remove()
  }, [forceReconnect, syncPending])

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

  const toggleAutoAccept = useCallback((id: string, on: boolean) => {
    setAutoAcceptSessions((prev) =>
      on ? (prev.includes(id) ? prev : [...prev, id]) : prev.filter((item) => item !== id),
    )
  }, [])

  function openSettings(section: "servers" | null = null) {
    setSettingsSection(section)
    setSettingsOpen(true)
  }

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
      setSessionID(session.id)
    } catch {
      setBanner("Could not create the session")
    } finally {
      setCreating(false)
    }
  }

  async function deleteSession(id: string) {
    if (!workspaceID) return
    try {
      await client.api.sessions.remove(workspaceID, id)
      if (sessionID === id) setSessionID(null)
      void queryClient.invalidateQueries({ queryKey: ["sessions"] })
      void queryClient.invalidateQueries({ queryKey: ["directories"] })
    } catch {
      setBanner("Could not delete the session")
    }
  }

  async function addWorkspace(input: CreateWorkspaceInput) {
    const created = await client.workspaces.create(input)
    await queryClient.invalidateQueries({ queryKey: ["workspaces"] })
    setWorkspaceID(created.id)
  }

  async function removeWorkspace(id: string, options: { deleteFiles: boolean }) {
    try {
      await client.workspaces.remove(id, options)
      if (workspaceID === id) setWorkspaceID(null)
      await queryClient.invalidateQueries({ queryKey: ["workspaces"] })
    } catch {
      setBanner("Could not remove the workspace")
    }
  }

  function selectWorkspace(id: string) {
    setWorkspaceID(id)
  }

  /**
   * Workspace switch: drop the open session and open the new workspace's most
   * recent one once its list loads (same behavior as web).
   */
  function switchWorkspace(id: string) {
    if (id === workspaceID) return
    pendingWorkspaceAutoOpenRef.current = true
    setSessionID(null)
    selectWorkspace(id)
  }

  async function respondPermission(response: "once" | "always" | "reject") {
    const permission = permissions[0]
    if (!permission) return
    setResponding(true)
    try {
      await client.api.respondPermission(permission.sessionID, permission.id, response)
      setPermissions((prev) => prev.filter((item) => item.id !== permission.id))
    } catch {
      setBanner("Could not answer the permission request")
    } finally {
      setResponding(false)
    }
  }

  async function respondForm(form: FormInfo, answer: FormAnswer) {
    setBusyFormID(form.id)
    setBanner(null)
    try {
      // The form id resolves the question regardless of the active workspace.
      await client.api.respondForm(form.sessionID, form.id, answer)
      setForms((prev) => prev.filter((item) => item.id !== form.id))
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
    } catch {
      setBanner("Could not dismiss the question")
    } finally {
      setBusyFormID(null)
    }
  }

  const waitingForm = forms.find((form) => formIsQuestion(form) && form.sessionID !== sessionID) ?? null

  return (
    <>
      {/* Release update banner (#133): BFF manifest first, F-Droid index as
          fallback; the only action deep-links into F-Droid. */}
      <UpdateBanner client={client} />
      {sessionID ? (
        <View style={styles.screenWrap}>
          {banner ? (
            <Pressable style={styles.banner} onPress={() => setBanner(null)}>
              <Text style={styles.bannerText}>{banner} · tap to dismiss</Text>
            </Pressable>
          ) : null}
          <ChatScreen
            client={client}
            sessionID={sessionID}
            title={selected?.title ?? ""}
            busy={busy}
            connected={connected}
            workspaceID={workspaceID}
            workspacePath={workspacePath}
            isolation={selected?.isolation}
            autoAccept={autoAcceptSessions.includes(sessionID)}
            onToggleAutoAccept={(on) => toggleAutoAccept(sessionID, on)}
            onOpenSession={setSessionID}
            parentSessionID={parentSessionID}
            onBack={() => setSessionID(null)}
            forms={forms}
            answeredForms={answeredForms}
            busyFormID={busyFormID}
            onRespondForm={(form, answer) => void respondForm(form, answer)}
            onCancelForm={(form) => void cancelForm(form)}
            waitingQuestion={Boolean(waitingForm)}
            onOpenWaiting={() => {
              if (waitingForm) setSessionID(waitingForm.sessionID)
            }}
            workspaces={workspaces}
            onSelectWorkspace={switchWorkspace}
            onAddWorkspace={addWorkspace}
            onRemoveWorkspace={(id, options) => void removeWorkspace(id, options)}
          />
        </View>
      ) : (
        <SessionsScreen
          sessions={sessions}
          loading={sessionsQuery.isLoading}
          statuses={statuses}
          connected={connected}
          creating={creating}
          banner={banner}
          workspaces={workspaces}
          workspaceID={workspaceID}
          canCreate={Boolean(workspaceID)}
          activeSessionID={sessionID}
          onOpen={setSessionID}
          onNew={(isolated) => void createSession(isolated)}
          onOpenSettings={() => openSettings()}
          serverSwitcher={
            <ServerSwitcher
              profiles={profiles}
              activeProfile={profile}
              onSwitch={onSwitch}
              onManage={() => openSettings("servers")}
              onAdd={onAddServer}
            />
          }
          onSelectWorkspace={switchWorkspace}
          onAddWorkspace={addWorkspace}
          onRemoveWorkspace={(id, options) => void removeWorkspace(id, options)}
          onDeleteSession={(id) => void deleteSession(id)}
          section={section}
          onSelectSection={setSection}
          board={
            <BoardScreen
              client={client}
              workspaceID={workspaceID}
              workspaces={workspaces}
              onSelectWorkspace={switchWorkspace}
              onAddWorkspace={addWorkspace}
              onRemoveWorkspace={(id, options) => void removeWorkspace(id, options)}
            />
          }
          scheduler={<SchedulerSection client={client} onOpenSession={setSessionID} />}
        />
      )}

      <SettingsModal
        visible={settingsOpen}
        client={client}
        mode={mode}
        onSelectMode={setMode}
        palette={palette}
        onSelectPalette={setPalette}
        initialSection={settingsSection}
        servers={{
          profiles,
          activeID: profile.id,
          onRename: onRenameServer,
          onDisconnect: onDisconnectServer,
          onRemove: onRemoveServer,
          onAdd: () => {
            setSettingsOpen(false)
            onAddServer()
          },
        }}
        onSignOut={() => {
          setSettingsOpen(false)
          void onDisconnect(profile)
        }}
        onClose={() => {
          setSettingsOpen(false)
          setSettingsSection(null)
        }}
      />

      {permissions[0] && (
        <PermissionModal
          permission={permissions[0]}
          busy={responding}
          onRespond={(response) => void respondPermission(response)}
        />
      )}
    </>
  )
}

function createStyles(colors: Palette, fonts: Fonts) {
  return StyleSheet.create({
    centered: {
      alignItems: "center",
      justifyContent: "center",
    },
    screenWrap: {
      flex: 1,
    },
    banner: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.warningLine,
      backgroundColor: colors.warningSoft,
      paddingHorizontal: 12,
      paddingVertical: 7,
    },
    bannerText: {
      color: colors.warning,
      fontFamily: fonts.ui,
      fontSize: 12,
    },
  })
}
