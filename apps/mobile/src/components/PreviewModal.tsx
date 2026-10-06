import { useEffect, useRef, useState } from "react"
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from "react-native"
import { WebView } from "react-native-webview"
import { useQueryClient } from "@tanstack/react-query"
import {
  isAmbiguousError,
  previewErrorMessage,
  queryKeys,
  useBffStatus,
  usePreview,
  type Client,
  type PreviewStatus,
} from "@masterhand/client-core"
import { useTheme, useThemedStyles, type Fonts, type Palette } from "../theme"

const STOPPED: PreviewStatus = { status: "stopped", url: null, port: null, error: null }

export function PreviewModal({
  client,
  sessionID,
  onClose,
}: {
  client: Client
  sessionID: string
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const statusQuery = useBffStatus(client)
  const previewQuery = usePreview(client, sessionID, statusQuery.data?.preview?.enabled === true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A tunnel that dies on its own must not keep claiming "running" (#89).
  const [notice, setNotice] = useState<string | null>(null)
  const previousStatus = useRef<PreviewStatus["status"]>("stopped")
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()

  const availability = statusQuery.data?.preview
  const preview = previewQuery.data ?? STOPPED
  const unavailable = availability ? !availability.available : false
  const key = queryKeys.preview(sessionID)

  useEffect(() => {
    const before = previousStatus.current
    previousStatus.current = preview.status
    if (before === "running" && preview.status === "error") {
      setNotice(preview.error ?? "The preview tunnel stopped.")
    } else if (before === "running" && preview.status === "stopped") {
      setNotice("The preview tunnel stopped.")
    } else if (preview.status === "running" || preview.status === "starting") {
      setNotice(null)
    }
  }, [preview.status, preview.error])

  const timedOut = previewQuery.timedOut && preview.status === "starting"

  /** Reconciles a start/stop whose response was lost against a fresh status. */
  async function reconcile(): Promise<PreviewStatus | null> {
    const fresh = await previewQuery.refetch().catch(() => null)
    return fresh?.data ?? null
  }

  async function start() {
    setBusy(true)
    setError(null)
    try {
      queryClient.setQueryData(key, await client.api.startPreview(sessionID))
    } catch (startError) {
      const fresh = await reconcile()
      if (fresh?.status === "running" || fresh?.status === "starting") {
        setError(null)
      } else if (isAmbiguousError(startError)) {
        setError("The server did not answer in time — the tunnel may still start. Check the status before retrying.")
      } else {
        setError(previewErrorMessage(startError))
      }
    } finally {
      setBusy(false)
    }
  }

  async function stop() {
    setBusy(true)
    setError(null)
    try {
      await client.api.stopPreview(sessionID)
      queryClient.setQueryData(key, STOPPED)
    } catch (stopError) {
      const fresh = await reconcile()
      if (fresh?.status === "stopped") {
        queryClient.setQueryData(key, fresh)
      } else if (isAmbiguousError(stopError)) {
        setError("The server did not answer in time — the tunnel may still be stopping. Check the status.")
      } else {
        setError("Could not stop the preview")
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.heading}>Preview</Text>
          {preview.port !== null ? <Text style={styles.port}>port {preview.port}</Text> : null}
          <View style={styles.spacer} />
          {busy ? (
            <ActivityIndicator color={colors.accent} />
          ) : preview.status === "running" ? (
            <Pressable style={styles.button} onPress={() => void stop()}>
              <Text style={styles.buttonText}>Stop</Text>
            </Pressable>
          ) : unavailable ? null : (
            <Pressable style={[styles.button, styles.primary]} onPress={() => void start()}>
              <Text style={[styles.buttonText, styles.primaryText]}>Start</Text>
            </Pressable>
          )}
          <Pressable style={styles.button} onPress={onClose}>
            <Text style={styles.buttonText}>Close</Text>
          </Pressable>
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}
        {!error && (notice || (preview.status === "error" && preview.error)) ? (
          <Text style={styles.notice}>{notice ?? preview.error}</Text>
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
      </View>
    </Modal>
  )
}

function createStyles(colors: Palette, fonts: Fonts) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.canvas,
    },
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
    spacer: {
      flex: 1,
    },
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
    placeholderText: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 14,
      textAlign: "center",
    },
  })
}
