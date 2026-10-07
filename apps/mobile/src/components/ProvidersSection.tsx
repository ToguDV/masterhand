import { useState } from "react"
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native"
import { useQueryClient } from "@tanstack/react-query"
import {
  providerConnectErrorMessage,
  queryKeys,
  useIntegrations,
  useProviderCredentials,
  type Client,
  type Integration,
} from "@masterhand/client-core"
import { useTheme, useThemedStyles, type Fonts, type Palette } from "../theme"

/** OpenCode Go (and any other opencode integration) is pinned first. */
function integrationRank(integration: Integration): number {
  return /opencode/i.test(`${integration.id} ${integration.name}`) ? 0 : 1
}

/**
 * Settings > Providers (issue #128): connect an API key without host access.
 * Keys only transit this UI → BFF → opencode; they are never stored here, never
 * pre-filled and never echoed back. OAuth/command providers stay informational.
 */
export function ProvidersSection({ client }: { client: Client }) {
  const queryClient = useQueryClient()
  const integrationsQuery = useIntegrations(client)
  const credentialsQuery = useProviderCredentials(client)
  const [connectingID, setConnectingID] = useState<string | null>(null)
  const [key, setKey] = useState("")
  const [label, setLabel] = useState("")
  const [busy, setBusy] = useState(false)
  const [busyCredentialID, setBusyCredentialID] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()

  const integrations = [...(integrationsQuery.data ?? [])].sort(
    (a, b) => integrationRank(a) - integrationRank(b),
  )
  const credentials = credentialsQuery.data ?? []

  async function refresh(): Promise<void> {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.integrations }),
      queryClient.invalidateQueries({ queryKey: queryKeys.credentials }),
    ])
  }

  function openConnect(integrationID: string): void {
    setConnectingID(integrationID)
    setKey("")
    setLabel("")
    setError(null)
  }

  async function submitConnect(integrationID: string): Promise<void> {
    if (!key.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      // Write-only: the value lives in this component's state and is never
      // pre-filled or read back; connecting twice is not auto-retried.
      await client.api.connectIntegrationKey(integrationID, {
        key: key.trim(),
        ...(label.trim() ? { label: label.trim() } : {}),
      })
      setKey("")
      setLabel("")
      setConnectingID(null)
      await refresh()
    } catch (err) {
      setError(providerConnectErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  async function disconnect(credentialID: string): Promise<void> {
    setBusyCredentialID(credentialID)
    setError(null)
    try {
      await client.api.removeCredential(credentialID)
      await refresh()
    } catch {
      setError("Could not disconnect the credential")
    } finally {
      setBusyCredentialID(null)
    }
  }

  function confirmDisconnect(credentialID: string, name: string): void {
    Alert.alert("Disconnect provider", `Remove the stored key for ${name}?`, [
      { text: "Cancel", style: "cancel" },
      { text: "Disconnect", style: "destructive", onPress: () => void disconnect(credentialID) },
    ])
  }

  async function activate(credentialID: string): Promise<void> {
    setBusyCredentialID(credentialID)
    setError(null)
    try {
      await client.api.activateCredential(credentialID)
      await refresh()
    } catch {
      setError("Could not switch the active credential")
    } finally {
      setBusyCredentialID(null)
    }
  }

  return (
    <View accessibilityLabel="Providers">
      {integrationsQuery.isLoading && <Text style={styles.hint}>Loading providers…</Text>}
      {integrationsQuery.error ? (
        <Text style={styles.error}>Could not load the provider catalog.</Text>
      ) : null}
      {!integrationsQuery.isLoading && integrations.length === 0 && !integrationsQuery.error ? (
        <Text style={styles.hint}>No provider integrations available.</Text>
      ) : null}

      {integrations.map((integration) => {
        const keyMethod = integration.methods.find((method) => method.type === "key")
        const credentialConnections = integration.connections.filter(
          (connection) => connection.type === "credential" && connection.credentialID,
        )
        const connected = integration.connections.length > 0
        const open = connectingID === integration.id
        return (
          <View key={integration.id} style={styles.card} testID={`integration-${integration.id}`}>
            <View style={styles.cardHeader}>
              <Text style={styles.cardTitle} numberOfLines={1}>
                {integration.name}
              </Text>
              {connected ? <Text style={styles.connected}>Connected</Text> : null}
            </View>

            {credentialConnections.map((connection) => {
              const credentialID = connection.credentialID!
              const credential = credentials.find((entry) => entry.id === credentialID)
              const credentialBusy = busyCredentialID === credentialID
              return (
                <View key={credentialID} style={styles.credentialRow}>
                  <Text style={styles.credentialLabel} numberOfLines={1}>
                    {connection.label ?? "API key"}
                  </Text>
                  {credential?.active ? <Text style={styles.active}>Active</Text> : null}
                  {credential && !credential.active ? (
                    <Pressable
                      onPress={() => void activate(credentialID)}
                      disabled={credentialBusy}
                      accessibilityRole="button"
                      accessibilityLabel={`Use ${connection.label ?? "API key"}`}
                    >
                      <Text style={styles.action}>Use</Text>
                    </Pressable>
                  ) : null}
                  <Pressable
                    onPress={() => confirmDisconnect(credentialID, integration.name)}
                    disabled={credentialBusy}
                    accessibilityRole="button"
                    accessibilityLabel={`Disconnect ${connection.label ?? "API key"}`}
                  >
                    {credentialBusy ? (
                      <ActivityIndicator size="small" color={colors.textMuted} />
                    ) : (
                      <Text style={styles.danger}>Disconnect</Text>
                    )}
                  </Pressable>
                </View>
              )
            })}

            {keyMethod && credentialConnections.length === 0 && !open ? (
              <Pressable
                onPress={() => openConnect(integration.id)}
                accessibilityRole="button"
                accessibilityLabel={`Connect ${integration.name}`}
                style={styles.connectButton}
              >
                <Text style={styles.connectText}>Connect</Text>
              </Pressable>
            ) : null}

            {open ? (
              <View style={styles.form}>
                <TextInput
                  value={key}
                  onChangeText={setKey}
                  placeholder="API key"
                  placeholderTextColor={colors.textFaint}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  accessibilityLabel="API key"
                  style={styles.input}
                  testID="provider-key-input"
                />
                <TextInput
                  value={label}
                  onChangeText={setLabel}
                  placeholder="Label (optional)"
                  placeholderTextColor={colors.textFaint}
                  autoCapitalize="none"
                  autoCorrect={false}
                  accessibilityLabel="Key label"
                  style={styles.input}
                  testID="provider-label-input"
                />
                <View style={styles.formActions}>
                  <Pressable
                    onPress={() => setConnectingID(null)}
                    disabled={busy}
                    accessibilityRole="button"
                    accessibilityLabel="Cancel connect"
                    style={styles.secondary}
                  >
                    <Text style={styles.secondaryText}>Cancel</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => void submitConnect(integration.id)}
                    disabled={!key.trim() || busy}
                    accessibilityRole="button"
                    accessibilityLabel="Save key"
                    style={[styles.primary, (!key.trim() || busy) && styles.disabled]}
                  >
                    <Text style={styles.primaryText}>{busy ? "Connecting…" : "Connect"}</Text>
                  </Pressable>
                </View>
              </View>
            ) : null}

            {!keyMethod ? (
              <Text style={styles.hint}>
                {integration.methods.some((method) => method.type === "oauth")
                  ? "Connect this provider from the opencode CLI/TUI for now."
                  : "Set this provider's environment variable on the host for now."}
              </Text>
            ) : null}
          </View>
        )
      })}

      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  )
}

function createStyles(colors: Palette, fonts: Fonts) {
  return StyleSheet.create({
    hint: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 12,
      marginTop: 8,
    },
    error: {
      color: colors.danger,
      fontFamily: fonts.ui,
      fontSize: 12,
      marginTop: 8,
    },
    card: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      borderRadius: 12,
      backgroundColor: colors.surface,
      padding: 12,
      marginTop: 8,
    },
    cardHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    cardTitle: {
      flex: 1,
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 14,
      fontWeight: "600",
    },
    connected: {
      color: colors.accent,
      fontFamily: fonts.ui,
      fontSize: 11,
      fontWeight: "600",
    },
    credentialRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      marginTop: 8,
    },
    credentialLabel: {
      flex: 1,
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 12,
    },
    active: {
      color: colors.accent,
      fontFamily: fonts.ui,
      fontSize: 11,
      fontWeight: "600",
    },
    action: {
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 12,
      fontWeight: "600",
    },
    danger: {
      color: colors.danger,
      fontFamily: fonts.ui,
      fontSize: 12,
      fontWeight: "600",
    },
    connectButton: {
      alignSelf: "flex-start",
      minHeight: 40,
      justifyContent: "center",
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairlineStrong,
      borderRadius: 10,
      paddingHorizontal: 14,
      marginTop: 10,
    },
    connectText: {
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 13,
      fontWeight: "600",
    },
    form: {
      gap: 8,
      marginTop: 10,
    },
    input: {
      minHeight: 44,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairlineStrong,
      borderRadius: 10,
      backgroundColor: colors.canvas,
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 14,
      paddingHorizontal: 12,
    },
    formActions: {
      flexDirection: "row",
      justifyContent: "flex-end",
      gap: 8,
    },
    secondary: {
      minHeight: 40,
      justifyContent: "center",
      paddingHorizontal: 14,
    },
    secondaryText: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 13,
    },
    primary: {
      minHeight: 40,
      justifyContent: "center",
      backgroundColor: colors.accent,
      borderRadius: 10,
      paddingHorizontal: 16,
    },
    primaryText: {
      color: colors.onAccent,
      fontFamily: fonts.ui,
      fontSize: 13,
      fontWeight: "600",
    },
    disabled: {
      opacity: 0.5,
    },
  })
}
