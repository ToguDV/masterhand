import { useMemo, useState } from "react"
import { Alert, Image, Linking, Pressable, StyleSheet, Text, TextInput, View } from "react-native"
import { SvgXml } from "react-native-svg"
import { useQueryClient } from "@tanstack/react-query"
import {
  RequestTimeoutError,
  providerConnectErrorMessage,
  providerIcon,
  providerMonogram,
  queryKeys,
  useIntegrations,
  useProviderCredentials,
  useWebsearchSettings,
  useWebsearchSources,
  websearchSaveErrorMessage,
  websearchTestErrorMessage,
  type Client,
  type Integration,
  type WebsearchTestResult,
} from "@masterhand/client-core"
import { useTheme, useThemedStyles, type Fonts, type Palette } from "../theme"
import { SearchIcon } from "./icons"

/**
 * Settings > Web search: pick the default source opencode uses for agent web
 * searches, connect an API key per source, and probe the current selection
 * with a real search. The selection lives in the config file MasterHand owns
 * (`websearch.provider`, hot-reloaded by opencode); the keys stay in opencode's
 * credential store. TinyFish is the keyless source, seeded as the default.
 */
export function WebSearchSection({ client }: { client: Client }) {
  const queryClient = useQueryClient()
  const settingsQuery = useWebsearchSettings(client)
  const sourcesQuery = useWebsearchSources(client)
  const integrationsQuery = useIntegrations(client)
  const credentialsQuery = useProviderCredentials(client)

  const [saving, setSaving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [connectingID, setConnectingID] = useState<string | null>(null)
  const [key, setKey] = useState("")
  const [label, setLabel] = useState("")
  const [busy, setBusy] = useState(false)
  const [busyCredentialID, setBusyCredentialID] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [testing, setTesting] = useState(false)
  const [testError, setTestError] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<WebsearchTestResult | null>(null)
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()

  const selection = settingsQuery.data ?? null
  const sources = sourcesQuery.data ?? []
  const credentials = credentialsQuery.data ?? []
  const integrationByID = useMemo(
    () => new Map((integrationsQuery.data ?? []).map((integration) => [integration.id, integration])),
    [integrationsQuery.data],
  )

  async function refresh(): Promise<void> {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.websearch }),
      queryClient.invalidateQueries({ queryKey: queryKeys.integrations }),
      queryClient.invalidateQueries({ queryKey: queryKeys.credentials }),
    ])
  }

  async function select(provider: string | "random"): Promise<void> {
    if (saving) return
    setSaving(provider)
    setError(null)
    try {
      await client.api.saveWebsearchSettings(provider)
    } catch (err) {
      setError(websearchSaveErrorMessage(err))
    } finally {
      setSaving(null)
      // Reconcile either way: the write is idempotent and may have landed even
      // when its response was lost (rule 4 in docs/past-mistakes.md).
      await queryClient.invalidateQueries({ queryKey: queryKeys.websearch })
    }
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
    } catch (err) {
      setError(
        err instanceof RequestTimeoutError
          ? "The server did not answer in time — the key may still be connected. Reopen settings to check."
          : "Could not disconnect the key",
      )
    } finally {
      setBusyCredentialID(null)
    }
  }

  function confirmDisconnect(credentialID: string, name: string): void {
    Alert.alert("Disconnect source", `Remove the stored key for ${name}?`, [
      { text: "Cancel", style: "cancel" },
      { text: "Disconnect", style: "destructive", onPress: () => void disconnect(credentialID) },
    ])
  }

  async function runTest(): Promise<void> {
    const text = query.trim()
    if (!text || testing) return
    setTesting(true)
    setTestError(null)
    setTestResult(null)
    try {
      setTestResult(await client.api.testWebsearch(text))
    } catch (err) {
      setTestError(websearchTestErrorMessage(err))
    } finally {
      setTesting(false)
    }
  }

  function sourceName(id: string): string {
    return sources.find((source) => source.id === id)?.name ?? id
  }

  function renderConnectForm(id: string) {
    if (connectingID !== id) return null
    return (
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
          testID="websearch-key-input"
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
          testID="websearch-label-input"
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
            onPress={() => void submitConnect(id)}
            disabled={!key.trim() || busy}
            accessibilityRole="button"
            accessibilityLabel="Save key"
            style={[styles.primary, (!key.trim() || busy) && styles.disabled]}
          >
            <Text style={styles.primaryText}>{busy ? "Connecting…" : "Connect"}</Text>
          </Pressable>
        </View>
      </View>
    )
  }

  return (
    <View accessibilityLabel="Web search">
      <Text style={styles.sectionTitle}>Web search</Text>
      <Text style={styles.hint}>
        The source opencode uses when the agent searches the web. Connect a source&apos;s API key to use it, or keep
        the keyless default.
      </Text>

      {settingsQuery.isLoading ? <Text style={styles.hint}>Loading…</Text> : null}
      {settingsQuery.error ? <Text style={styles.error}>Could not load the default source.</Text> : null}
      {settingsQuery.data !== undefined && selection === null ? (
        <Text style={styles.hint}>
          No default source is set — opencode would ask per search, which MasterHand cannot show. Pick one below.
        </Text>
      ) : null}
      {settingsQuery.data === false ? (
        <Text style={styles.hint}>
          Web search is disabled in opencode&apos;s config (websearch: false). Pick a source to enable it.
        </Text>
      ) : null}
      {sourcesQuery.error ? (
        <Text style={styles.error}>Could not load the web search sources from opencode.</Text>
      ) : null}

      <View style={styles.options}>
        <Pressable
          onPress={() => void select("random")}
          disabled={saving !== null}
          accessibilityRole="radio"
          accessibilityState={{ checked: selection === "random" }}
          accessibilityLabel="Automatic"
          style={[styles.option, selection === "random" && styles.optionSelected]}
        >
          <View style={[styles.mark, selection === "random" && styles.markSelected]} />
          <View style={styles.avatar} accessible={false}>
            <SearchIcon size={14} color={colors.text} />
          </View>
          <View style={styles.optionBody}>
            <Text style={styles.optionName}>Automatic</Text>
            <Text style={styles.optionHint}>Picks an available source per search, retrying another on rate limits.</Text>
          </View>
        </Pressable>

        {sources.map((source) => {
          const integration = integrationByID.get(source.id)
          const credentialConnections = (integration?.connections ?? []).filter(
            (connection) => connection.type === "credential" && connection.credentialID,
          )
          const envConnections = (integration?.connections ?? []).filter((connection) => connection.type === "env")
          const checked = selection === source.id
          return (
            <View key={source.id} testID={`websearch-source-${source.id}`}>
              <Pressable
                onPress={() => void select(source.id)}
                disabled={saving !== null}
                accessibilityRole="radio"
                accessibilityState={{ checked }}
                accessibilityLabel={source.name}
                style={[styles.option, checked && styles.optionSelected]}
              >
                <View style={[styles.mark, checked && styles.markSelected]} />
                <SourceAvatar integration={integration} name={source.name} />
                <View style={styles.optionBody}>
                  <Text style={styles.optionName}>{source.name}</Text>
                  {source.keyless ? <Text style={styles.keyless}>No API key required</Text> : null}
                  {credentialConnections.length > 0 || envConnections.length > 0 ? (
                    <Text style={styles.connected}>Connected</Text>
                  ) : null}
                </View>
              </Pressable>

              {credentialConnections.map((connection) => {
                const credentialID = connection.credentialID!
                const credential = credentials.find((entry) => entry.id === credentialID)
                const name = connection.label?.trim() || "API key"
                return (
                  <View key={credentialID} style={styles.credentialRow}>
                    <Pressable
                      onPress={() => confirmDisconnect(credentialID, source.name)}
                      disabled={busyCredentialID === credentialID}
                      accessibilityRole="button"
                      accessibilityLabel={`Disconnect ${source.name}`}
                      style={styles.secondary}
                    >
                      <Text style={styles.dangerText}>
                        {busyCredentialID === credentialID ? "Removing…" : "Disconnect"}
                      </Text>
                    </Pressable>
                    <Text style={styles.credentialLabel} numberOfLines={1}>
                      {name}
                    </Text>
                    {credential?.active ? <Text style={styles.connected}>Active</Text> : null}
                  </View>
                )
              })}
              {envConnections.length > 0 ? (
                <Text style={styles.credentialEnv} numberOfLines={1}>
                  Using {envConnections.map((connection) => connection.label).filter(Boolean).join(", ")}
                </Text>
              ) : null}

              {credentialConnections.length === 0 && connectingID !== source.id ? (
                <Pressable
                  onPress={() => openConnect(source.id)}
                  accessibilityRole="button"
                  accessibilityLabel={`Connect ${source.name}`}
                  style={styles.connect}
                >
                  <Text style={styles.connectText}>Connect</Text>
                </Pressable>
              ) : null}
              {renderConnectForm(source.id)}
            </View>
          )
        })}
      </View>

      {saving ? <Text style={styles.hint}>Saving…</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}

      <View style={styles.testBox}>
        <Text style={styles.testTitle}>Test the current source</Text>
        <View style={styles.testRow}>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search the web…"
            placeholderTextColor={colors.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel="Test search query"
            style={[styles.input, styles.testInput]}
            testID="websearch-test-input"
          />
          <Pressable
            onPress={() => void runTest()}
            disabled={testing || !query.trim()}
            accessibilityRole="button"
            accessibilityLabel="Run test search"
            style={[styles.primary, (testing || !query.trim()) && styles.disabled]}
          >
            <Text style={styles.primaryText}>{testing ? "Searching…" : "Test"}</Text>
          </Pressable>
        </View>
        {testError ? <Text style={styles.error}>{testError}</Text> : null}
        {testResult ? (
          testResult.results.length === 0 ? (
            <Text style={styles.hint}>No results.</Text>
          ) : (
            <View style={styles.testResults}>
              <Text style={styles.hint}>
                Answered by <Text style={styles.testProvider}>{sourceName(testResult.providerID)}</Text>
              </Text>
              {testResult.results.slice(0, 4).map((result) => (
                <Pressable
                  key={result.url}
                  onPress={() => void Linking.openURL(result.url).catch(() => undefined)}
                  accessibilityRole="link"
                  accessibilityLabel={result.title ?? result.url}
                >
                  <Text style={styles.testLink} numberOfLines={1}>
                    {result.title ?? result.url}
                  </Text>
                </Pressable>
              ))}
            </View>
          )
        ) : null}
      </View>
    </View>
  )
}

function SourceAvatar({
  integration,
  name,
}: {
  integration?: Pick<Integration, "id" | "name"> & Partial<Integration>
  name: string
}) {
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()
  if (integration?.icon) {
    return <Image source={{ uri: integration.icon }} style={styles.avatar} testID="source-avatar" />
  }
  const icon = providerIcon(integration?.id ?? name)
  if (icon) {
    return (
      <View style={[styles.avatar, styles.avatarBrand]} testID="source-avatar" accessible={false}>
        <SvgXml xml={icon} width={16} height={16} color={colors.text} testID="source-brand-icon" />
      </View>
    )
  }
  return (
    <View style={styles.avatar} testID="source-avatar">
      <Text style={styles.avatarText}>{providerMonogram(name)}</Text>
    </View>
  )
}

function createStyles(colors: Palette, fonts: Fonts) {
  return StyleSheet.create({
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
    sectionTitle: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 11,
      letterSpacing: 0.8,
      textTransform: "uppercase",
      fontWeight: "600",
    },
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
    options: {
      marginTop: 12,
      gap: 8,
    },
    option: {
      minHeight: 44,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairlineStrong,
      backgroundColor: colors.surface,
      borderRadius: 12,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    optionSelected: {
      borderColor: colors.accent,
      backgroundColor: colors.accentSoft,
    },
    mark: {
      width: 16,
      height: 16,
      borderRadius: 8,
      borderWidth: 1.5,
      borderColor: colors.hairlineStrong,
      backgroundColor: colors.surface,
    },
    markSelected: {
      borderColor: colors.accent,
      backgroundColor: colors.accent,
    },
    optionBody: {
      flex: 1,
      minWidth: 0,
    },
    optionName: {
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 14,
    },
    optionHint: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 11,
      marginTop: 2,
    },
    keyless: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 11,
      marginTop: 2,
    },
    connected: {
      color: colors.accent,
      fontFamily: fonts.ui,
      fontSize: 11,
      marginTop: 2,
    },
    credentialRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      marginTop: 6,
      paddingHorizontal: 4,
    },
    credentialLabel: {
      flex: 1,
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 12,
    },
    credentialEnv: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 12,
      marginTop: 6,
      paddingHorizontal: 4,
    },
    connect: {
      alignSelf: "flex-start",
      marginTop: 6,
      marginLeft: 4,
      paddingVertical: 6,
    },
    connectText: {
      color: colors.accent,
      fontFamily: fonts.ui,
      fontSize: 13,
    },
    form: {
      gap: 8,
      marginTop: 8,
      marginLeft: 4,
    },
    input: {
      minHeight: 44,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairlineStrong,
      backgroundColor: colors.surface,
      borderRadius: 12,
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 14,
      paddingHorizontal: 12,
    },
    formActions: {
      flexDirection: "row",
      gap: 12,
    },
    secondary: {
      minHeight: 40,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairlineStrong,
      borderRadius: 12,
      paddingHorizontal: 14,
    },
    secondaryText: {
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 13,
    },
    dangerText: {
      color: colors.danger,
      fontFamily: fonts.ui,
      fontSize: 13,
    },
    primary: {
      minHeight: 44,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.accent,
      borderRadius: 12,
      paddingHorizontal: 16,
    },
    disabled: {
      opacity: 0.5,
    },
    primaryText: {
      color: colors.onAccent,
      fontFamily: fonts.ui,
      fontSize: 14,
      fontWeight: "500",
    },
    testBox: {
      marginTop: 16,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      backgroundColor: colors.surface,
      borderRadius: 12,
      padding: 12,
    },
    testTitle: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 11,
      letterSpacing: 0.8,
      textTransform: "uppercase",
      fontWeight: "600",
    },
    testRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      marginTop: 8,
    },
    testInput: {
      flex: 1,
    },
    testResults: {
      marginTop: 8,
      gap: 4,
    },
    testProvider: {
      color: colors.text,
    },
    testLink: {
      color: colors.accent,
      fontFamily: fonts.ui,
      fontSize: 12,
    },
  })
}
