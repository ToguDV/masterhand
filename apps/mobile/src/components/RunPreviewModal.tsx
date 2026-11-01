import { useEffect, useRef, useState } from "react"
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native"
import { WebView } from "react-native-webview"
import { SafeAreaView } from "react-native-safe-area-context"
import { useQueryClient } from "@tanstack/react-query"
import {
  isAmbiguousError,
  previewErrorMessage,
  queryKeys,
  useBffStatus,
  usePreview,
  useSessionRun,
  useWorkspaceRun,
  type Client,
  type PreviewStatus,
  type RunCandidate,
  type RunStatus,
} from "@masterhand/client-core"
import { useTheme, useThemedStyles, type Fonts, type Palette } from "../theme"

const STOPPED_RUN: RunStatus = { status: "stopped", command: null, args: [], port: null, pid: null, error: null }
const STOPPED_PREVIEW: PreviewStatus = { status: "stopped", url: null, port: null, error: null }

type PanelTab = "run" | "preview"

/** What the WebView actually tried to load, kept after the status flips. */
type WebViewFailure = {
  url: string
  code: number | null
  description: string
  status: number | null
}

function stoppedPreview(lastUrl: string | null, port: number | null): PreviewStatus {
  return { status: "stopped", url: null, lastUrl, port, error: null }
}

/**
 * Only http(s) URLs may be handed to the OS. The preview body is untrusted
 * workspace content, and a WebView failure event reports whatever URL it
 * tried — including `javascript:` or `file:` schemes.
 */
export function previewExternalUrl(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? url : null
  } catch {
    return null
  }
}

/**
 * One modal for the whole dev-server lifecycle (issue #99): the run command
 * starts the server on the session's reserved port and the preview is the
 * tunnel that exposes it, so both live as internal tabs of a single control.
 * Opening lands on Preview when the tunnel is running, otherwise on Run, and
 * starting/stopping never forces a tab switch.
 */
export function RunPreviewModal({
  client,
  sessionID,
  workspaceID,
  onClose,
}: {
  client: Client
  sessionID: string
  workspaceID: string | null
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const statusQuery = useBffStatus(client)
  const previewEnabled = statusQuery.data?.preview?.enabled === true
  const availability = statusQuery.data?.preview
  const runQuery = useSessionRun(client, sessionID, workspaceID)
  const configQuery = useWorkspaceRun(client, workspaceID)
  const previewQuery = usePreview(client, sessionID, previewEnabled)
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()

  const run = runQuery.data ?? STOPPED_RUN
  const preview = previewQuery.data ?? STOPPED_PREVIEW
  const previewKey = queryKeys.preview(sessionID)
  const liveUrl = preview.status === "running" ? preview.url : null

  const [tab, setTab] = useState<PanelTab>(() =>
    previewQuery.data?.status === "running" ? "preview" : "run",
  )
  const tabTouched = useRef(false)
  useEffect(() => {
    if (tabTouched.current || !previewEnabled) return
    if (previewQuery.data?.status === "running") setTab("preview")
  }, [previewEnabled, previewQuery.data?.status])
  const selectTab = (value: PanelTab): void => {
    tabTouched.current = true
    setTab(value)
  }

  // Run tab state.
  const [runBusy, setRunBusy] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [runNotice, setRunNotice] = useState<string | null>(null)
  const previousRunStatus = useRef<RunStatus["status"]>("stopped")
  const [editing, setEditing] = useState(false)
  const [command, setCommand] = useState("")
  const [argsText, setArgsText] = useState("")
  const [detected, setDetected] = useState<RunCandidate | null>(null)

  // Preview tab state.
  const [previewBusy, setPreviewBusy] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewNotice, setPreviewNotice] = useState<string | null>(null)
  const [webviewFailure, setWebviewFailure] = useState<WebViewFailure | null>(null)
  const [webviewReload, setWebviewReload] = useState(0)
  const [lastSeen, setLastSeen] = useState<{ sessionID: string; url: string } | null>(null)
  const previousPreviewStatus = useRef<PreviewStatus["status"]>("stopped")
  // Gate the remembered URL by session: the modal can be reused for another
  // session without unmounting, and the previous tunnel must not be shown or
  // opened for the new one.
  const lastSeenUrl = lastSeen?.sessionID === sessionID ? lastSeen.url : null
  const lastPreviewUrl = preview.lastUrl ?? lastSeenUrl ?? null
  const failureBrowserUrl = webviewFailure?.url || liveUrl || preview.lastUrl || lastSeenUrl || null

  // A different session must not inherit the previous one's errors, failure
  // panel or lifecycle notices. The remembered URL is gated during render.
  useEffect(() => {
    setRunError(null)
    setRunNotice(null)
    setPreviewError(null)
    setPreviewNotice(null)
    setWebviewFailure(null)
    setWebviewReload(0)
    previousRunStatus.current = "stopped"
    previousPreviewStatus.current = "stopped"
  }, [sessionID])

  useEffect(() => {
    const before = previousRunStatus.current
    previousRunStatus.current = run.status
    if (before === "running" && run.status === "stopped") setRunNotice("The dev server stopped.")
    else if (before === "running" && run.status === "error") setRunNotice(run.error ?? "The dev server stopped.")
    else if (run.status === "running") setRunNotice(null)
  }, [run.status, run.error])

  useEffect(() => {
    const before = previousPreviewStatus.current
    previousPreviewStatus.current = preview.status
    if (before === "running" && preview.status === "error") {
      setPreviewNotice(preview.error ?? "The preview tunnel stopped.")
    } else if (before === "running" && preview.status === "stopped") {
      setPreviewNotice("The preview tunnel stopped.")
    } else if (preview.status === "running" || preview.status === "starting") {
      setPreviewNotice(null)
    }
  }, [preview.status, preview.error])

  // Track the newest URL seen this session and clear a WebView failure only
  // when a *different* live URL arrives. A status flip to error/stopped says
  // nothing about the failed URL (the BFF nulls `url`), so it must keep the
  // failure panel and the URL the WebView actually tried visible.
  useEffect(() => {
    if (!liveUrl) return
    setLastSeen({ sessionID, url: liveUrl })
    setWebviewFailure((failure) => (failure && failure.url !== liveUrl ? null : failure))
  }, [liveUrl, sessionID])

  if (!workspaceID) return null

  const config = configQuery.data ?? null
  const running = run.status === "running"
  const shownCommand = run.command ?? config?.command ?? null
  const shownArgs = run.args.length > 0 ? run.args : (config?.args ?? [])
  const unavailable = availability ? !availability.available : false
  const timedOut = previewQuery.timedOut && preview.status === "starting"
  const port = run.port ?? preview.port

  function openEditor() {
    setCommand(config?.command ?? "")
    setArgsText((config?.args ?? []).join("\n"))
    setRunError(null)
    setEditing(true)
  }

  /** Reconciles a start/stop whose response was lost against a fresh status. */
  async function reconcileRun(): Promise<RunStatus | null> {
    const fresh = await runQuery.refetch().catch(() => null)
    return fresh?.data ?? null
  }

  async function startRun() {
    setRunBusy(true)
    setRunError(null)
    setRunNotice(null)
    try {
      queryClient.setQueryData(
        queryKeys.sessionRun(sessionID),
        await client.api.startSessionRun(sessionID, workspaceID!),
      )
    } catch (startError) {
      const fresh = await reconcileRun()
      if (fresh?.status === "running" || fresh?.status === "starting") {
        setRunError(null)
      } else if (isAmbiguousError(startError)) {
        setRunError("The server did not answer in time — the run may still start. Check the status before retrying.")
      } else {
        setRunError("Could not start the run server. Check the command, then try again.")
      }
    } finally {
      setRunBusy(false)
    }
  }

  async function stopRun() {
    setRunBusy(true)
    setRunError(null)
    try {
      await client.api.stopSessionRun(sessionID, workspaceID!)
      queryClient.setQueryData(queryKeys.sessionRun(sessionID), STOPPED_RUN)
    } catch (stopError) {
      const fresh = await reconcileRun()
      if (fresh?.status === "stopped") {
        queryClient.setQueryData(queryKeys.sessionRun(sessionID), fresh)
      } else if (isAmbiguousError(stopError)) {
        setRunError("The server did not answer in time — the dev server may still be stopping. Check the status.")
      } else {
        setRunError("Could not stop the run server")
      }
    } finally {
      setRunBusy(false)
    }
  }

  async function save() {
    setRunBusy(true)
    setRunError(null)
    try {
      const saved = await client.api.saveRun(workspaceID!, {
        command: command.trim(),
        args: argsText
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
      })
      queryClient.setQueryData(queryKeys.run(workspaceID), saved)
      setEditing(false)
    } catch {
      setRunError("Could not save the run command. Check the executable and arguments.")
    } finally {
      setRunBusy(false)
    }
  }

  async function detect() {
    setRunBusy(true)
    setRunError(null)
    try {
      setDetected(await client.api.detectRun(workspaceID!))
    } catch {
      setRunError("No valid .masterhand/run.json found in the workspace.")
    } finally {
      setRunBusy(false)
    }
  }

  async function applyDetected() {
    if (!detected) return
    setRunBusy(true)
    setRunError(null)
    try {
      const saved = await client.api.saveRun(workspaceID!, {
        command: detected.command,
        args: detected.args,
        cwd: detected.cwd,
      })
      queryClient.setQueryData(queryKeys.run(workspaceID), saved)
      setDetected(null)
    } catch {
      setRunError("Could not save the detected run command.")
    } finally {
      setRunBusy(false)
    }
  }

  async function reconcilePreview(): Promise<PreviewStatus | null> {
    const fresh = await previewQuery.refetch().catch(() => null)
    return fresh?.data ?? null
  }

  /** Opens an external URL; selectable text is the fallback if this fails. */
  function openInBrowser(url: string | null | undefined): void {
    const target = previewExternalUrl(url ?? liveUrl ?? lastPreviewUrl)
    if (!target) return
    void Linking.openURL(target).catch(() => {})
  }

  function failWebView(failure: WebViewFailure): void {
    console.warn("[preview]", failure)
    setWebviewFailure(failure)
    void previewQuery.refetch().catch(() => {})
  }

  function retryPreview(): void {
    if (liveUrl) {
      setWebviewFailure(null)
      setWebviewReload((value) => value + 1)
      return
    }
    // No live URL to remount yet: poll until the BFF publishes a new one and
    // keep the panel (with the failing URL) visible meanwhile.
    void previewQuery.refetch().catch(() => {})
  }

  async function startPreview() {
    setPreviewBusy(true)
    setPreviewError(null)
    try {
      await queryClient.cancelQueries({ queryKey: previewKey, exact: true })
      const started = await client.api.startPreview(sessionID)
      // A poll/refetch that started while the mutation was in flight may still
      // resolve with the previous tunnel (or with `starting`); discard it so it
      // can never overwrite the URL this start just published.
      await queryClient.cancelQueries({ queryKey: previewKey, exact: true })
      queryClient.setQueryData(previewKey, started)
    } catch (startError) {
      const fresh = await reconcilePreview()
      if (fresh?.status === "running" || fresh?.status === "starting") {
        setPreviewError(null)
      } else if (isAmbiguousError(startError)) {
        setPreviewError("The server did not answer in time — the tunnel may still start. Check the status before retrying.")
      } else {
        setPreviewError(previewErrorMessage(startError))
      }
    } finally {
      setPreviewBusy(false)
    }
  }

  async function stopPreview() {
    setPreviewBusy(true)
    setPreviewError(null)
    const lastUrl = liveUrl ?? lastPreviewUrl
    try {
      await queryClient.cancelQueries({ queryKey: previewKey, exact: true })
      await client.api.stopPreview(sessionID)
      await queryClient.cancelQueries({ queryKey: previewKey, exact: true })
      // Keep the URL in the stopped state: the tunnel is gone, but it stays
      // available for diagnosis and for opening/copying.
      queryClient.setQueryData(previewKey, stoppedPreview(lastUrl, preview.port))
    } catch (stopError) {
      const fresh = await reconcilePreview()
      if (fresh?.status === "stopped") {
        queryClient.setQueryData(previewKey, fresh)
      } else if (isAmbiguousError(stopError)) {
        setPreviewError("The server did not answer in time — the tunnel may still be stopping. Check the status.")
      } else {
        setPreviewError("Could not stop the preview")
      }
    } finally {
      setPreviewBusy(false)
    }
  }

  /**
   * A quick tunnel URL is ephemeral: once it dies the WebView can only show
   * the OS error page (Android renders `Domain: undefined` for any lookup
   * failure). Restarting is the only recovery that gets a fresh hostname.
   */
  async function restartPreview() {
    setPreviewBusy(true)
    setPreviewError(null)
    const lastUrl = liveUrl ?? lastPreviewUrl
    try {
      await queryClient.cancelQueries({ queryKey: previewKey, exact: true })
      try {
        await client.api.stopPreview(sessionID)
      } catch (stopError) {
        // An explicit restart must not start a second tunnel over a live one:
        // stop first, and surface the failure when that is not possible.
        setPreviewError(
          isAmbiguousError(stopError)
            ? "The server did not answer in time — the tunnel may still be stopping. Check the status."
            : "Could not stop the preview",
        )
        return
      }
      setWebviewFailure(null)
      await queryClient.cancelQueries({ queryKey: previewKey, exact: true })
      queryClient.setQueryData(previewKey, stoppedPreview(lastUrl, preview.port))
      await queryClient.cancelQueries({ queryKey: previewKey, exact: true })
      const started = await client.api.startPreview(sessionID)
      await queryClient.cancelQueries({ queryKey: previewKey, exact: true })
      queryClient.setQueryData(previewKey, started)
    } catch (restartError) {
      setPreviewError(previewErrorMessage(restartError))
    } finally {
      setPreviewBusy(false)
    }
  }

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.container} edges={["top", "bottom", "left", "right"]}>
        <KeyboardAvoidingView style={styles.container} behavior="padding">
          <View style={styles.header}>
            <View style={styles.headerText}>
              <Text style={styles.heading} numberOfLines={1}>
                Run &amp; preview
              </Text>
              {port !== null ? <Text style={styles.port}>port {port}</Text> : null}
            </View>
            <View style={styles.spacer} />
          {tab === "run" ? (
            runBusy ? (
              <ActivityIndicator color={colors.accent} />
            ) : running ? (
              <Pressable
                style={styles.button}
                accessibilityRole="button"
                accessibilityLabel="Stop run"
                hitSlop={6}
                onPress={() => void stopRun()}
              >
                <Text style={styles.buttonText}>Stop</Text>
              </Pressable>
            ) : (
              <Pressable
                style={[styles.button, styles.primary, !config ? styles.disabled : null]}
                disabled={!config}
                accessibilityRole="button"
                accessibilityLabel="Start run"
                hitSlop={6}
                onPress={() => void startRun()}
              >
                <Text style={[styles.buttonText, styles.primaryText]}>Start</Text>
              </Pressable>
            )
          ) : previewBusy ? (
            <ActivityIndicator color={colors.accent} />
          ) : preview.status === "running" ? (
            <Pressable
              style={styles.button}
              accessibilityRole="button"
              accessibilityLabel="Stop preview"
              hitSlop={6}
              onPress={() => void stopPreview()}
            >
              <Text style={styles.buttonText}>Stop</Text>
            </Pressable>
          ) : unavailable ? null : (
            <Pressable
              style={[styles.button, styles.primary]}
              accessibilityRole="button"
              accessibilityLabel="Start preview"
              hitSlop={6}
              onPress={() => void startPreview()}
            >
              <Text style={[styles.buttonText, styles.primaryText]}>Start</Text>
            </Pressable>
          )}
          <Pressable
            style={styles.button}
            accessibilityRole="button"
            accessibilityLabel="Close run and preview"
            hitSlop={6}
            onPress={onClose}
          >
            <Text style={styles.buttonText}>Close</Text>
          </Pressable>
        </View>

        <View style={styles.tabs} accessibilityRole="tablist">
          {(["run", "preview"] as PanelTab[])
            .filter((value) => value === "run" || previewEnabled)
            .map((value) => {
              const selected = tab === value
              return (
                <Pressable
                  key={value}
                  style={[styles.tab, selected && styles.tabActive]}
                  accessibilityRole="tab"
                  accessibilityState={{ selected }}
                  accessibilityLabel={value === "run" ? "Run" : "Preview"}
                  onPress={() => selectTab(value)}
                >
                  <Text style={[styles.tabText, selected && styles.tabTextActive]}>
                    {value === "run" ? "Run" : "Preview"}
                  </Text>
                </Pressable>
              )
            })}
        </View>

        {tab === "run" ? (
          <>
            {runError ? <Text style={styles.error}>{runError}</Text> : null}
            {!runError && (runNotice || (run.status === "error" && run.error)) ? (
              <Text style={styles.notice}>{runNotice ?? run.error}</Text>
            ) : null}

            <ScrollView contentContainerStyle={styles.body}>
              {shownCommand ? (
                <Text style={styles.command}>
                  {shownCommand} {shownArgs.join(" ")}
                </Text>
              ) : (
                <Text style={styles.placeholderText}>
                  No run command configured. Let the agent declare .masterhand/run.json, or edit it here.
                </Text>
              )}

              {detected ? (
                <View style={styles.detected}>
                  <Text style={styles.detectedLabel}>Detected in .masterhand/run.json:</Text>
                  <Text style={styles.command}>
                    {detected.command} {detected.args.join(" ")}
                  </Text>
                  <Pressable
                    style={[styles.button, styles.primary]}
                    accessibilityRole="button"
                    accessibilityLabel="Apply detected run command"
                    onPress={() => void applyDetected()}
                  >
                    <Text style={[styles.buttonText, styles.primaryText]}>Apply</Text>
                  </Pressable>
                </View>
              ) : null}

              {editing ? (
                <View style={styles.editor}>
                  <Text style={styles.fieldLabel}>Executable (argv, no shell)</Text>
                  <TextInput
                    value={command}
                    onChangeText={setCommand}
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder="npm"
                    placeholderTextColor={colors.textFaint}
                    style={styles.input}
                  />
                  <Text style={styles.fieldLabel}>Arguments (one per line; {"{port}"} is replaced)</Text>
                  <TextInput
                    value={argsText}
                    onChangeText={setArgsText}
                    autoCapitalize="none"
                    autoCorrect={false}
                    multiline
                    numberOfLines={6}
                    placeholder={"run\ndev\n--\n--port\n{port}"}
                    placeholderTextColor={colors.textFaint}
                    style={[styles.input, styles.textarea]}
                  />
                  <View style={styles.row}>
                    <Pressable
                      style={[styles.button, styles.primary]}
                      accessibilityRole="button"
                      accessibilityLabel="Save run command"
                      onPress={() => void save()}
                    >
                      <Text style={[styles.buttonText, styles.primaryText]}>Save</Text>
                    </Pressable>
                    <Pressable
                      style={styles.button}
                      accessibilityRole="button"
                      accessibilityLabel="Cancel run command edit"
                      onPress={() => setEditing(false)}
                    >
                      <Text style={styles.buttonText}>Cancel</Text>
                    </Pressable>
                  </View>
                </View>
              ) : (
                <View style={styles.row}>
                  <Pressable
                    style={styles.button}
                    accessibilityRole="button"
                    accessibilityLabel="Edit command"
                    onPress={openEditor}
                  >
                    <Text style={styles.buttonText}>Edit command</Text>
                  </Pressable>
                  <Pressable
                    style={styles.button}
                    accessibilityRole="button"
                    accessibilityLabel="Detect"
                    onPress={() => void detect()}
                  >
                    <Text style={styles.buttonText}>Detect</Text>
                  </Pressable>
                </View>
              )}
            </ScrollView>
          </>
        ) : (
          <>
            {previewError ? <Text style={styles.error}>{previewError}</Text> : null}
            {!previewError && (previewNotice || (preview.status === "error" && preview.error)) ? (
              <Text style={styles.notice}>{previewNotice ?? preview.error}</Text>
            ) : null}

            {liveUrl ? (
              <View style={styles.urlBar} testID="preview-url-bar">
                <Text selectable style={styles.urlText} testID="preview-url">
                  {liveUrl}
                </Text>
                <Pressable
                  style={styles.button}
                  accessibilityRole="button"
                  accessibilityLabel="Open preview in browser"
                  hitSlop={6}
                  onPress={() => openInBrowser(liveUrl)}
                >
                  <Text style={styles.buttonText}>Open</Text>
                </Pressable>
              </View>
            ) : lastPreviewUrl ? (
              <View style={styles.urlBar} testID="preview-last-url-bar">
                <View style={styles.urlTextBlock}>
                  <Text style={styles.urlLabel}>Last preview URL</Text>
                  <Text selectable style={styles.urlText} testID="preview-last-url">
                    {lastPreviewUrl}
                  </Text>
                </View>
                <Pressable
                  style={styles.button}
                  accessibilityRole="button"
                  accessibilityLabel="Open last preview URL in browser"
                  hitSlop={6}
                  onPress={() => openInBrowser(lastPreviewUrl)}
                >
                  <Text style={styles.buttonText}>Open</Text>
                </Pressable>
              </View>
            ) : null}

            {webviewFailure ? (
              <ScrollView contentContainerStyle={styles.previewError} testID="preview-failure-panel">
                <Text style={styles.error}>Could not load the preview.</Text>
                {webviewFailure.status !== null ? (
                  <Text style={styles.placeholderText} testID="preview-failure-status">
                    The tunnel answered HTTP {webviewFailure.status}. {webviewFailure.description}
                  </Text>
                ) : (
                  <Text style={styles.placeholderText} testID="preview-failure-description">
                    {webviewFailure.description}
                  </Text>
                )}
                {webviewFailure.code !== null ? (
                  <Text style={styles.placeholderText} testID="preview-failure-code">
                    Error code {webviewFailure.code}
                  </Text>
                ) : null}
                {failureBrowserUrl ? (
                  <Text selectable style={styles.previewErrorUrl} testID="preview-failure-url">
                    {failureBrowserUrl}
                  </Text>
                ) : null}
                <Text style={styles.placeholderText}>
                  If the URL cannot be resolved, check the phone&apos;s internet, VPN/Private DNS, or a
                  DNS filter that blocks *.trycloudflare.com. The quick tunnel may have expired; restart it.
                </Text>
                <View style={styles.previewErrorActions}>
                  <Pressable
                    style={[styles.button, styles.primary]}
                    accessibilityRole="button"
                    accessibilityLabel="Retry preview"
                    onPress={retryPreview}
                  >
                    <Text style={[styles.buttonText, styles.primaryText]}>Retry</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.button, previewBusy && styles.disabled]}
                    disabled={previewBusy}
                    accessibilityRole="button"
                    accessibilityLabel="Restart preview"
                    onPress={() => void restartPreview()}
                  >
                    <Text style={styles.buttonText}>Restart preview</Text>
                  </Pressable>
                  <Pressable
                    style={styles.button}
                    accessibilityRole="button"
                    accessibilityLabel="Open failing URL in browser"
                    onPress={() => openInBrowser(failureBrowserUrl)}
                  >
                    <Text style={styles.buttonText}>Open in browser</Text>
                  </Pressable>
                </View>
              </ScrollView>
            ) : liveUrl ? (
              <WebView
                key={`${liveUrl}:${webviewReload}`}
                source={{ uri: liveUrl }}
                style={styles.webview}
                startInLoadingState
                onError={(event) => {
                  const { url, code, description } = event.nativeEvent
                  failWebView({
                    url: url || liveUrl,
                    code,
                    description: description || "The preview URL could not be loaded.",
                    status: null,
                  })
                }}
                onHttpError={(event) => {
                  const { url, statusCode, description } = event.nativeEvent
                  failWebView({
                    url: url || liveUrl,
                    code: null,
                    description: description || "The tunnel could not serve the preview.",
                    status: statusCode,
                  })
                }}
              />
            ) : (
              <View style={styles.placeholder}>
                <Text style={styles.placeholderText}>
                  {unavailable
                    ? "cloudflared is not available on the server. Install it, or run MasterHand with Docker (the image bundles it)."
                    : preview.status === "error"
                      ? preview.error ?? "The preview tunnel stopped."
                      : timedOut
                        ? "The tunnel is taking longer than expected. Check the server logs, then retry the preview."
                        : preview.status === "starting"
                          ? "Starting the tunnel…"
                          : `Ask the agent to start the web server on port ${
                              preview.port ?? availability?.portRange.min ?? ""
                            }, then press Start.`}
                </Text>
              </View>
            )}
          </>
        )}
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  )
}

function createStyles(colors: Palette, fonts: Fonts) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.canvas },
    header: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.hairline,
    },
    headerText: {
      flexShrink: 1,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      minWidth: 0,
    },
    heading: {
      flexShrink: 1,
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 15,
      fontWeight: "600",
    },
    port: {
      color: colors.textMuted,
      fontFamily: fonts.mono,
      fontSize: 11,
      backgroundColor: colors.surfaceMuted,
      borderRadius: 6,
      paddingHorizontal: 6,
      paddingVertical: 2,
    },
    spacer: { flex: 1 },
    button: {
      minHeight: 34,
      justifyContent: "center",
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairlineStrong,
      backgroundColor: colors.surface,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 6,
    },
    primary: {
      backgroundColor: colors.accent,
      borderColor: colors.accent,
    },
    disabled: { opacity: 0.4 },
    buttonText: {
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 12,
      fontWeight: "500",
    },
    primaryText: {
      color: colors.onAccent,
    },
    tabs: {
      flexDirection: "row",
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.hairline,
      paddingHorizontal: 12,
    },
    tab: {
      minHeight: 44,
      minWidth: 72,
      alignItems: "center",
      justifyContent: "center",
      borderBottomWidth: 2,
      borderBottomColor: "transparent",
      paddingHorizontal: 10,
    },
    tabActive: {
      borderBottomColor: colors.accent,
    },
    tabText: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 13,
      fontWeight: "500",
    },
    tabTextActive: {
      color: colors.text,
      fontWeight: "600",
    },
    error: {
      color: colors.danger,
      fontFamily: fonts.ui,
      fontSize: 12,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    notice: {
      color: colors.warning,
      fontFamily: fonts.ui,
      fontSize: 12,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    body: { padding: 16, gap: 12 },
    command: {
      color: colors.text,
      fontFamily: fonts.mono,
      fontSize: 12,
    },
    placeholderText: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 14,
    },
    detected: {
      gap: 8,
      borderRadius: 16,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.accentLine,
      padding: 12,
    },
    detectedLabel: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 12,
    },
    editor: { gap: 8 },
    fieldLabel: {
      color: colors.textSoft,
      fontFamily: fonts.ui,
      fontSize: 12,
    },
    input: {
      color: colors.text,
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairlineStrong,
      borderRadius: 12,
      paddingHorizontal: 10,
      paddingVertical: 8,
      fontFamily: fonts.mono,
      fontSize: 12,
    },
    textarea: { minHeight: 96, textAlignVertical: "top" },
    row: { flexDirection: "row", gap: 8, alignItems: "center" },
    webview: {
      flex: 1,
      backgroundColor: "#fff",
    },
    urlBar: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.hairline,
      backgroundColor: colors.surface,
    },
    urlTextBlock: { flex: 1, gap: 2 },
    urlLabel: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 11,
    },
    urlText: {
      flex: 1,
      color: colors.text,
      fontFamily: fonts.mono,
      fontSize: 11,
    },
    previewError: { flexGrow: 1, padding: 16, gap: 10 },
    previewErrorUrl: {
      color: colors.textFaint,
      fontFamily: fonts.mono,
      fontSize: 11,
    },
    previewErrorActions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 },
    placeholder: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: 24,
    },
  })
}
