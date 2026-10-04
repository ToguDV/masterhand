import { useState } from "react"
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
  queryKeys,
  useSessionRun,
  useWorkspaceRun,
  type Client,
  type RunCandidate,
  type RunStatus,
} from "@masterhand/client-core"
import { colors } from "../theme"

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

  const run = runQuery.data ?? STOPPED
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

  async function start() {
    setBusy(true)
    setError(null)
    try {
      queryClient.setQueryData(queryKeys.sessionRun(sessionID), await client.api.startSessionRun(sessionID, workspaceID))
    } catch {
      setError("Could not start the run server. Check the command, then try again.")
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
    } catch {
      setError("Could not stop the run server")
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
              <Text style={styles.buttonText}>Start</Text>
            </Pressable>
          )}
          <Pressable style={styles.button} onPress={onClose}>
            <Text style={styles.buttonText}>Close</Text>
          </Pressable>
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}

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
                <Text style={styles.buttonText}>Apply</Text>
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
                placeholderTextColor={colors.muted}
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
                placeholderTextColor={colors.muted}
                style={[styles.input, styles.textarea]}
              />
              <View style={styles.row}>
                <Pressable style={[styles.button, styles.primary]} onPress={() => void save()}>
                  <Text style={styles.buttonText}>Save</Text>
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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  heading: { color: colors.text, fontSize: 15, fontWeight: "700" },
  port: {
    color: colors.muted,
    fontSize: 11,
    backgroundColor: colors.surface,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  spacer: { flex: 1 },
  button: {
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: colors.surfaceMuted,
  },
  primary: { backgroundColor: colors.accent },
  disabled: { opacity: 0.4 },
  buttonText: { color: colors.text, fontSize: 12, fontWeight: "700" },
  error: { color: colors.danger, fontSize: 12, paddingHorizontal: 12, paddingVertical: 8 },
  body: { padding: 16, gap: 12 },
  command: { color: colors.text, fontFamily: "monospace", fontSize: 12 },
  placeholderText: { color: colors.muted, fontSize: 14 },
  detected: {
    gap: 8,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.accent,
    padding: 12,
  },
  detectedLabel: { color: colors.muted, fontSize: 12 },
  editor: { gap: 8 },
  fieldLabel: { color: colors.muted, fontSize: 12 },
  input: {
    color: colors.text,
    backgroundColor: colors.surface,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontFamily: "monospace",
    fontSize: 12,
  },
  textarea: { minHeight: 96, textAlignVertical: "top" },
  row: { flexDirection: "row", gap: 8, alignItems: "center" },
})
