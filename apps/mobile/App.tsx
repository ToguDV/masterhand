import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { AppState, Platform, Pressable, StyleSheet, View } from "react-native"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
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
  formIsQuestion,
  invalidateOnReconnect,
  reconcileForms,
  reconcilePermissions,
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
} from "@masterhand/client-core"
import { SafeAreaProvider } from "react-native-safe-area-context"
import { LoginScreen } from "./src/screens/LoginScreen"
import { SessionsScreen } from "./src/screens/SessionsScreen"
import { ChatScreen } from "./src/screens/ChatScreen"
import { PermissionModal } from "./src/components/PermissionModal"
import { SettingsModal } from "./src/components/SettingsModal"
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
  clearDevice,
  clearToken,
  clearWorkspaceID,
  loadAutoAcceptSessions,
  loadDevice,
  loadServerUrl,
  loadToken,
  loadWorkspaceID,
  saveAutoAcceptSessions,
  saveDevice,
  saveServerUrl,
  saveToken,
  saveWorkspaceID,
} from "./src/storage"

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
    },
  },
})

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
    <SafeAreaProvider>
      <ThemeProvider fonts={fontsLoaded ? appFonts : systemFonts}>
        <ThemedSystemBars />
        <QueryClientProvider client={queryClient}>
          <Root />
        </QueryClientProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  )
}

function Root() {
  const [ready, setReady] = useState(false)
  const [serverUrl, setServerUrl] = useState<string | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [loginBusy, setLoginBusy] = useState(false)
  const [loginError, setLoginError] = useState<string | null>(null)
  const [storageWarning, setStorageWarning] = useState<string | null>(null)
  const tokenRef = useRef<string | null>(null)
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()

  useEffect(() => {
    void (async () => {
      try {
        const [storedUrl, storedToken] = await Promise.all([loadServerUrl(), loadToken()])
        tokenRef.current = storedToken
        setServerUrl(storedUrl)
        setToken(storedToken)
      } catch {
        // A SecureStore failure (keychain unavailable, corrupted access group)
        // must never leave the app on a permanent spinner: fall back to the
        // login screen with a storage-specific message (issue #82).
        setLoginError(
          "Could not read the saved session from this device's secure storage. Sign in again.",
        )
      } finally {
        setReady(true)
      }
    })()
  }, [])

  const client = useMemo(() => {
    if (!serverUrl) return null
    return createClient({
      baseUrl: serverUrl,
      getToken: () => tokenRef.current,
      fetchImpl,
      onUnauthorized: () => {
        tokenRef.current = null
        void clearToken()
        setToken(null)
      },
    })
  }, [serverUrl])

  async function handleLogin(url: string, password: string) {
    setLoginBusy(true)
    setLoginError(null)
    try {
      const normalized = url.replace(/\/+$/, "")
      const candidate = createClient({ baseUrl: normalized, fetchImpl })
      const deviceName = Platform.OS === "ios" ? "iOS device" : "Android device"
      const result = await candidate.auth.loginDevice(password, deviceName)
      try {
        await Promise.all([saveServerUrl(normalized), saveToken(result.token), saveDevice(result.device)])
      } catch {
        // The login worked but the device cannot persist it: keep the session
        // usable in memory and say it will not survive a restart (issue #82).
        setStorageWarning(
          "Signed in, but this device could not save the session. You will need to sign in again after restarting.",
        )
      }
      tokenRef.current = result.token
      setServerUrl(normalized)
      setToken(result.token)
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401) setLoginError("Wrong password")
        else if (err.status === 429) setLoginError("Too many attempts; wait 15 minutes")
        else if (err.status === 400) setLoginError("Check the server URL and password")
        else setLoginError(`Error ${err.status}`)
      } else {
        setLoginError("Could not reach the server")
      }
    } finally {
      setLoginBusy(false)
    }
  }

  async function handleSignOut() {
    if (client) {
      const device = await loadDevice().catch(() => null)
      if (device) await client.auth.revokeDevice(device.id).catch(() => {})
    }
    await Promise.all([clearToken(), clearDevice(), clearWorkspaceID()])
    tokenRef.current = null
    queryClient.clear()
    setToken(null)
  }

  if (!ready) {
    return (
      <Screen style={styles.centered}>
        <ActivityIndicator color={colors.accent} />
      </Screen>
    )
  }

  if (!client || !token) {
    return (
      <LoginScreen
        initialServerUrl={serverUrl}
        busy={loginBusy}
        error={loginError}
        onSubmit={(url, password) => void handleLogin(url, password)}
      />
    )
  }

  return (
    <AuthenticatedApp
      client={client}
      initialBanner={storageWarning}
      onSignOut={() => void handleSignOut()}
    />
  )
}

function AuthenticatedApp({
  client,
  onSignOut,
  initialBanner = null,
}: {
  client: Client
  onSignOut: () => void
  initialBanner?: string | null
}) {
  const [sessionID, setSessionID] = useState<string | null>(null)
  const [workspaceID, setWorkspaceID] = useState<string | null>(null)
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
  // App-level settings modal (Appearance, Providers, Account).
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Set when the user switches workspace: drop the open session and open the
  // new workspace's most recent one once its session list arrives.
  const pendingWorkspaceAutoOpenRef = useRef(false)
  const styles = useThemedStyles(createStyles)
  const { mode, setMode, palette, setPalette } = useTheme()

  useEffect(() => {
    void loadAutoAcceptSessions().then((ids) => {
      setAutoAcceptSessions(ids)
      autoAcceptLoaded.current = true
    })
  }, [])

  useEffect(() => {
    if (!autoAcceptLoaded.current) return
    void saveAutoAcceptSessions(autoAcceptSessions)
  }, [autoAcceptSessions])

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

  /** Answers a permission request automatically ("once", reversible). */
  const answerAuto = useCallback(
    async (permission: Permission, retry = false) => {
      if (answeringRef.current.has(permission.id)) return
      // A retry only applies while auto-accept still owns an unanswered request.
      if (
        retry &&
        (!autoPendingRef.current.has(permission.id) ||
          !autoAcceptSessionsRef.current.includes(permission.sessionID))
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

  useEffect(() => {
    void loadWorkspaceID().then(setWorkspaceID)
  }, [])

  const workspacesQuery = useWorkspaces(client, true)
  const workspaces = workspacesQuery.data ?? []
  const workspace = workspaces.find((item) => item.id === workspaceID) ?? null
  const workspacePath = workspace?.path ?? null
  const directoriesQuery = useSessionDirectories(client, true, workspaceID)

  useEffect(() => {
    if (!workspacesQuery.data) return
    if (workspaceID && workspacesQuery.data.some((item) => item.id === workspaceID)) return
    const next = workspacesQuery.data[0]?.id ?? null
    setWorkspaceID(next)
    if (next) void saveWorkspaceID(next)
    else void clearWorkspaceID()
  }, [workspacesQuery.data, workspaceID])

  const sessionsQuery = useSessions(client, true, 10_000, workspaceID)
  const statusesQuery = useSessionStatuses(client, true, connected)
  const statuses = statusesQuery.data ?? {}
  const sessions = sessionsQuery.data ?? []
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
    const next = [...sessions].sort((a, b) => b.time.updated - a.time.updated)[0]?.id ?? null
    if (next !== sessionID) setSessionID(next)
  }, [sessionsQuery.isSuccess, sessions, sessionID])

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
          autoPendingRef.current.delete(permissionID)
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
    void saveWorkspaceID(created.id)
  }

  async function removeWorkspace(id: string, options: { deleteFiles: boolean }) {
    try {
      await client.workspaces.remove(id, options)
      if (workspaceID === id) {
        setWorkspaceID(null)
        void clearWorkspaceID()
      }
      await queryClient.invalidateQueries({ queryKey: ["workspaces"] })
    } catch {
      setBanner("Could not remove the workspace")
    }
  }

  function selectWorkspace(id: string) {
    setWorkspaceID(id)
    void saveWorkspaceID(id)
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
          onSignOut={onSignOut}
          onOpenSettings={() => setSettingsOpen(true)}
          onSelectWorkspace={switchWorkspace}
          onAddWorkspace={addWorkspace}
          onRemoveWorkspace={(id, options) => void removeWorkspace(id, options)}
          onDeleteSession={(id) => void deleteSession(id)}
        />
      )}

      <SettingsModal
        visible={settingsOpen}
        client={client}
        mode={mode}
        onSelectMode={setMode}
        palette={palette}
        onSelectPalette={setPalette}
        onClose={() => setSettingsOpen(false)}
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
