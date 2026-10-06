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
import { useQueryClient } from "@tanstack/react-query"
import {
  isAmbiguousError,
  queryKeys,
  useSessionRun,
  useWorkspaceRun,
  type Client,
  type RunCandidate,
  type RunStatus,
} from "@masterhand/client-core"
import { useTheme, useThemedStyles, type Fonts, type Palette } from "../theme"

const STOPPED: RunStatus = { status: "stopped", command: null, args: [], port: null, pid: null, error: null }

/**
 * Managed dev-server lifecycle (mobile): MasterHand starts/stops the workspace
 * run command; the agent never kills processes.
 */
export function RunModal({
  client,
  sessionID,
  workspaceID,
  onClose,
}: {
  client: Client
  sessionID: string
  workspaceID: string
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const runQuery = useSessionRun(client, sessionID, workspaceID)
  const configQuery = useWorkspaceRun(client, workspaceID)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [command, setCommand] = useState("")
  const [argsText, setArgsText] = useState("")
  const [detected, setDetected] = useState<RunCandidate | null>(null)
  // A run that dies on its own must not keep showing "running" (#89).
  const [notice, setNotice] = useState<string | null>(null)
  const previousStatus = useRef<RunStatus["status"]>("stopped")
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()

  const run = runQuery.data ?? STOPPED

  useEffect(() => {
    const before = previousStatus.current
    previousStatus.current = run.status
    if (before === "running" && run.status === "stopped") setNotice("The dev server stopped.")
    else if (before === "running" && run.status === "error") setNotice(run.error ?? "The dev server stopped.")
    else if (run.status === "running") setNotice(null)
  }, [run.status, run.error])

  const config = configQuery.data ?? null
  const running = run.status === "running"
  const shownCommand = run.command ?? config?.command ?? null
  const shownArgs = run.args.length > 0 ? run.args : (config?.args ?? [])

  function openEditor() {
    setCommand(config?.command ?? "")
    setArgsText((config?.args ?? []).join("\n"))
    setError(null)
    setEditing(true)
  }

  /** Reconciles a start/stop whose response was lost against a fresh status. */
  async function reconcile(): Promise<RunStatus | null> {
    const fresh = await runQuery.refetch().catch(() => null)
    return fresh?.data ?? null
  }

  async function start() {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      queryClient.setQueryData(queryKeys.sessionRun(sessionID), await client.api.startSessionRun(sessionID, workspaceID))
    } catch (startError) {
      const fresh = await reconcile()
      if (fresh?.status === "running" || fresh?.status === "starting") {
        setError(null)
      } else if (isAmbiguousError(startError)) {
        setError("The server did not answer in time — the run may still start. Check the status before retrying.")
      } else {
        setError("Could not start the run server. Check the command, then try again.")
      }
    } finally {
      setBusy(false)
    }
  }

  async function stop() {
    setBusy(true)
    setError(null)
    try {
      await client.api.stopSessionRun(sessionID, workspaceID)
      queryClient.setQueryData(queryKeys.sessionRun(sessionID), STOPPED)
    } catch (stopError) {
      const fresh = await reconcile()
      if (fresh?.status === "stopped") {
        queryClient.setQueryData(queryKeys.sessionRun(sessionID), fresh)
      } else if (isAmbiguousError(stopError)) {
        setError("The server did not answer in time — the dev server may still be stopping. Check the status.")
      } else {
        setError("Could not stop the run server")
      }
    } finally {
      setBusy(false)
    }
  }

  async function save() {
    setBusy(true)
    setError(null)
    try {
      const saved = await client.api.saveRun(workspaceID, {
        command: command.trim(),
        args: argsText
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
      })
      queryClient.setQueryData(queryKeys.run(workspaceID), saved)
      setEditing(false)
    } catch {
      setError("Could not save the run command. Check the executable and arguments.")
    } finally {
      setBusy(false)
    }
  }

  async function detect() {
    setBusy(true)
    setError(null)
    try {
      setDetected(await client.api.detectRun(workspaceID))
    } catch {
      setError("No valid .masterhand/run.json found in the workspace.")
    } finally {
      setBusy(false)
    }
  }

  async function applyDetected() {
    if (!detected) return
    setBusy(true)
    setError(null)
    try {
      const saved = await client.api.saveRun(workspaceID, {
        command: detected.command,
        args: detected.args,
        cwd: detected.cwd,
      })
      queryClient.setQueryData(queryKeys.run(workspaceID), saved)
      setDetected(null)
    } catch {
      setError("Could not save the detected run command.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.heading}>Run server</Text>
          {run.port !== null ? <Text style={styles.port}>port {run.port}</Text> : null}
          <View style={styles.spacer} />
          {busy ? (
            <ActivityIndicator color={colors.accent} />
          ) : running ? (
            <Pressable style={styles.button} onPress={() => void stop()}>
              <Text style={styles.buttonText}>Stop</Text>
            </Pressable>
          ) : (
            <Pressable
              style={[styles.button, styles.primary, !config ? styles.disabled : null]}
              disabled={!config}
              onPress={() => void start()}
            >
              <Text style={[styles.buttonText, styles.primaryText]}>Start</Text>
            </Pressable>
          )}
          <Pressable style={styles.button} onPress={onClose}>
            <Text style={styles.buttonText}>Close</Text>
          </Pressable>
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}
        {!error && (notice || (run.status === "error" && run.error)) ? (
          <Text style={styles.notice}>{notice ?? run.error}</Text>
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
              <Pressable style={[styles.button, styles.primary]} onPress={() => void applyDetected()}>
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
                <Pressable style={[styles.button, styles.primary]} onPress={() => void save()}>
                  <Text style={[styles.buttonText, styles.primaryText]}>Save</Text>
                </Pressable>
                <Pressable style={styles.button} onPress={() => setEditing(false)}>
                  <Text style={styles.buttonText}>Cancel</Text>
                </Pressable>
              </View>
            </View>
          ) : (
            <View style={styles.row}>
              <Pressable style={styles.button} onPress={openEditor}>
                <Text style={styles.buttonText}>Edit command</Text>
              </Pressable>
              <Pressable style={styles.button} onPress={() => void detect()}>
                <Text style={styles.buttonText}>Detect</Text>
              </Pressable>
            </View>
          )}
        </ScrollView>
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
  })
}
