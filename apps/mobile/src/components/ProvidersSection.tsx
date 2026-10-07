import { useState } from "react"
import { ActivityIndicator, Alert, Image, Pressable, StyleSheet, Text, TextInput, View } from "react-native"
import { SvgXml } from "react-native-svg"
import { useQueryClient } from "@tanstack/react-query"
import {
  compareIntegrations,
  providerConnectErrorMessage,
  providerIcon,
  providerMonogram,
  queryKeys,
  useIntegrations,
  useProviderCredentials,
  type Client,
  type Integration,
} from "@masterhand/client-core"
import { useTheme, useThemedStyles, type Fonts, type Palette } from "../theme"

/** Providers shown before the "Show all" affordance. */
const PROVIDER_PAGE_SIZE = 5

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
  const [search, setSearch] = useState("")
  const [showAll, setShowAll] = useState(false)
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()

  const filtered = [...(integrationsQuery.data ?? [])]
    .sort(compareIntegrations)
    .filter((integration) => {
      const needle = search.trim().toLowerCase()
      if (!needle) return true
      return `${integration.name} ${integration.id}`.toLowerCase().includes(needle)
    })
  const visible = showAll ? filtered : filtered.slice(0, PROVIDER_PAGE_SIZE)
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
      {!integrationsQuery.isLoading && filtered.length === 0 && !integrationsQuery.error ? (
        <Text style={styles.hint}>
          {search.trim() ? "No provider matches that search." : "No provider integrations available."}
        </Text>
      ) : null}

      <TextInput
        value={search}
        onChangeText={(value) => {
          setSearch(value)
          setShowAll(false)
        }}
        placeholder="Search providers…"
        placeholderTextColor={colors.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel="Search providers"
        style={styles.search}
        testID="provider-search"
      />

      {visible.map((integration) => {
        const keyMethod = integration.methods.find((method) => method.type === "key")
        const credentialConnections = integration.connections.filter(
          (connection) => connection.type === "credential" && connection.credentialID,
        )
        const connected = integration.connections.length > 0
        const open = connectingID === integration.id
        return (
          <View key={integration.id} style={styles.card} testID={`integration-${integration.id}`}>
            <View style={styles.cardHeader}>
              <ProviderAvatar integration={integration} />
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
                  {/* The action sits where the Connect button was: first, on the left. */}
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

      {!showAll && filtered.length > PROVIDER_PAGE_SIZE ? (
        <Pressable
          onPress={() => setShowAll(true)}
          accessibilityRole="button"
          accessibilityLabel={`Show all ${filtered.length} providers`}
          style={styles.showAll}
        >
          <Text style={styles.showAllText}>Show all {filtered.length} providers</Text>
        </Pressable>
      ) : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  )
}

/**
 * Provider glyph: the original brand mark when vendored (models.dev), an
 * explicit `metadata.icon` URL when the backend provides one, and otherwise a
 * deterministic monogram.
 */
function ProviderAvatar({ integration }: { integration: Integration }) {
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()
  if (integration.icon) {
    return <Image source={{ uri: integration.icon }} style={styles.avatar} testID="provider-avatar" />
  }
  const icon = providerIcon(integration.id)
  if (icon) {
    return (
      <View style={[styles.avatar, styles.avatarBrand]} testID="provider-avatar" accessible={false}>
        <SvgXml xml={icon} width={16} height={16} color={colors.text} testID="provider-brand-icon" />
      </View>
    )
  }
  return (
    <View style={styles.avatar} testID="provider-avatar">
      <Text style={styles.avatarText}>{providerMonogram(integration.name)}</Text>
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
    search: {
      minHeight: 44,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairlineStrong,
      borderRadius: 10,
      backgroundColor: colors.canvas,
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 14,
      paddingHorizontal: 12,
      marginTop: 8,
    },
    avatar: {
      width: 28,
      height: 28,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.accentLine,
      borderRadius: 8,
      backgroundColor: colors.accentSoft,
    },
    avatarBrand: {
      borderColor: colors.hairline,
      backgroundColor: colors.canvas,
    },
    avatarText: {
      color: colors.accent,
      fontFamily: fonts.ui,
      fontSize: 13,
      fontWeight: "700",
    },
    showAll: {
      minHeight: 44,
      justifyContent: "center",
      marginTop: 8,
    },
    showAllText: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 13,
      fontWeight: "600",
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
