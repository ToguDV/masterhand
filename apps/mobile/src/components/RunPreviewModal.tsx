import { useEffect, useRef, useState } from "react"
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native"
import { WebView } from "react-native-webview"
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
  const previousPreviewStatus = useRef<PreviewStatus["status"]>("stopped")

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

  async function startPreview() {
    setPreviewBusy(true)
    setPreviewError(null)
    try {
      queryClient.setQueryData(previewKey, await client.api.startPreview(sessionID))
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
    try {
      await client.api.stopPreview(sessionID)
      queryClient.setQueryData(previewKey, STOPPED_PREVIEW)
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

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.heading}>Run &amp; preview</Text>
          {port !== null ? <Text style={styles.port}>port {port}</Text> : null}
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

            {preview.status === "running" && preview.url ? (
              <WebView source={{ uri: preview.url }} style={styles.webview} startInLoadingState />
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
      </View>
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
    heading: {
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
    placeholder: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: 24,
    },
  })
}
