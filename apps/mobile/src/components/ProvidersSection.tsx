import { useMemo, useRef, useState, type ReactNode } from "react"
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native"
import { SvgXml } from "react-native-svg"
import { useQueryClient } from "@tanstack/react-query"
import {
  compareIntegrations,
  customProviderErrorMessage,
  isValidProviderId,
  providerConnectErrorMessage,
  providerIcon,
  providerIdFromName,
  providerMonogram,
  queryKeys,
  useCustomProviders,
  useIntegrations,
  useProviderCredentials,
  type Client,
  type CustomProvider,
  type CustomProviderCreateResult,
  type CustomProviderPackage,
  type Integration,
} from "@masterhand/client-core"
import { useTheme, useThemedStyles, type Fonts, type Palette } from "../theme"

/** Providers shown before the "Show all" affordance. */
const PROVIDER_PAGE_SIZE = 5

/**
 * Settings > Providers (#128): connect an API key without host access and add
 * custom OpenAI-compatible providers. Keys only transit this UI → BFF →
 * opencode; they are never stored here, never pre-filled and never echoed
 * back. OAuth/command providers stay informational.
 */
export function ProvidersSection({ client }: { client: Client }) {
  const queryClient = useQueryClient()
  const integrationsQuery = useIntegrations(client)
  const credentialsQuery = useProviderCredentials(client)
  const customQuery = useCustomProviders(client)
  const [connectingID, setConnectingID] = useState<string | null>(null)
  const [key, setKey] = useState("")
  const [label, setLabel] = useState("")
  const [busy, setBusy] = useState(false)
  const [busyCredentialID, setBusyCredentialID] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [showAll, setShowAll] = useState(false)
  const [adding, setAdding] = useState(false)
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
  const customProviders = customQuery.data ?? []
  const integrationByID = useMemo(
    () => new Map((integrationsQuery.data ?? []).map((integration) => [integration.id, integration])),
    [integrationsQuery.data],
  )

  async function refresh(): Promise<void> {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.integrations }),
      queryClient.invalidateQueries({ queryKey: queryKeys.credentials }),
      queryClient.invalidateQueries({ queryKey: queryKeys.customProviders }),
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

  function confirmRemoveProvider(provider: CustomProvider): void {
    Alert.alert("Remove provider", `Remove ${provider.name} and its stored key?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () => void removeProvider(provider.id),
      },
    ])
  }

  async function removeProvider(id: string): Promise<void> {
    setBusyCredentialID(id)
    setError(null)
    try {
      await client.api.removeCustomProvider(id)
      await refresh()
    } catch (err) {
      setError(customProviderErrorMessage(err))
    } finally {
      setBusyCredentialID(null)
    }
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

  function renderConnectForm(id: string): ReactNode {
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
    <View accessibilityLabel="Providers">
      <Pressable
        onPress={() => {
          setAdding(true)
          setNotice(null)
        }}
        accessibilityRole="button"
        accessibilityLabel="Add provider"
        testID="add-custom-provider"
        style={styles.addButton}
      >
        <Text style={styles.addButtonText}>Add provider</Text>
      </Pressable>

      {customQuery.error ? <Text style={styles.error}>Could not load the custom providers.</Text> : null}
      {customQuery.isLoading ? <Text style={styles.hint}>Loading custom providers…</Text> : null}

      {customProviders.length > 0 ? (
        <>
          <Text style={styles.groupLabel}>Custom providers</Text>
          {customProviders.map((provider) => {
            const integration = integrationByID.get(provider.id)
            const credentialConnections = (integration?.connections ?? []).filter(
              (connection) => connection.type === "credential" && connection.credentialID,
            )
            const busyProvider = busyCredentialID === provider.id
            return (
              <View key={provider.id} style={styles.card} testID={`custom-provider-${provider.id}`}>
                <View style={styles.cardHeader}>
                  <ProviderAvatar integration={{ id: provider.id, name: provider.name }} />
                  <Text style={styles.cardTitle} numberOfLines={1}>
                    {provider.name}
                  </Text>
                  {credentialConnections.length > 0 ? <Text style={styles.connected}>Connected</Text> : null}
                </View>
                <Text style={styles.baseUrl} numberOfLines={1}>
                  {provider.baseURL}
                </Text>
                {credentialConnections.map((connection) => {
                  const credentialID = connection.credentialID!
                  const credential = credentials.find((entry) => entry.id === credentialID)
                  const credentialBusy = busyCredentialID === credentialID
                  const label = connection.label?.trim()
                  const displayLabel =
                    label && label.toLowerCase() !== provider.name.trim().toLowerCase() ? label : "API key"
                  return (
                    <View key={credentialID} style={styles.credentialRow}>
                      <Pressable
                        onPress={() => confirmDisconnect(credentialID, provider.name)}
                        disabled={credentialBusy}
                        accessibilityRole="button"
                        accessibilityLabel={`Disconnect ${displayLabel}`}
                      >
                        {credentialBusy ? (
                          <ActivityIndicator size="small" color={colors.textMuted} />
                        ) : (
                          <Text style={styles.danger}>Disconnect</Text>
                        )}
                      </Pressable>
                      <Text style={styles.credentialLabel} numberOfLines={1}>
                        {displayLabel}
                      </Text>
                      {credential?.active ? <Text style={styles.active}>Active</Text> : null}
                    </View>
                  )
                })}
                <View style={styles.customActions}>
                  {credentialConnections.length === 0 && connectingID !== provider.id ? (
                    <Pressable
                      onPress={() => openConnect(provider.id)}
                      accessibilityRole="button"
                      accessibilityLabel={`Connect ${provider.name}`}
                      style={styles.connectButton}
                    >
                      <Text style={styles.connectText}>Connect</Text>
                    </Pressable>
                  ) : null}
                  <Pressable
                    onPress={() => confirmRemoveProvider(provider)}
                    disabled={busyProvider}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${provider.name}`}
                  >
                    {busyProvider ? (
                      <ActivityIndicator size="small" color={colors.textMuted} />
                    ) : (
                      <Text style={styles.danger}>Remove</Text>
                    )}
                  </Pressable>
                </View>
                {renderConnectForm(provider.id)}
              </View>
            )
          })}
        </>
      ) : null}

      <Text style={styles.groupLabel}>Catalog</Text>
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
              // The label often defaults to the provider name already shown
              // in the card header — do not repeat it.
              const label = connection.label?.trim()
              const displayLabel = label && label.toLowerCase() !== integration.name.trim().toLowerCase()
                ? label
                : "API key"
              return (
                <View key={credentialID} style={styles.credentialRow}>
                  {/* The action sits where the Connect button was: first, on the left. */}
                  <Pressable
                    onPress={() => confirmDisconnect(credentialID, integration.name)}
                    disabled={credentialBusy}
                    accessibilityRole="button"
                    accessibilityLabel={`Disconnect ${displayLabel}`}
                  >
                    {credentialBusy ? (
                      <ActivityIndicator size="small" color={colors.textMuted} />
                    ) : (
                      <Text style={styles.danger}>Disconnect</Text>
                    )}
                  </Pressable>
                  <Text style={styles.credentialLabel} numberOfLines={1}>
                    {displayLabel}
                  </Text>
                  {credential?.active ? <Text style={styles.active}>Active</Text> : null}
                  {credential && !credential.active ? (
                    <Pressable
                      onPress={() => void activate(credentialID)}
                      disabled={credentialBusy}
                      accessibilityRole="button"
                      accessibilityLabel={`Use ${displayLabel}`}
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

            {renderConnectForm(integration.id)}

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

      {notice ? <Text style={styles.notice}>{notice}</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}

      {adding ? (
        <AddProviderModal
          client={client}
          onClose={() => setAdding(false)}
          onCreated={async (result) => {
            setAdding(false)
            await refresh()
            setError(null)
            setNotice(
              result.connected
                ? `${result.provider.name} added and connected.`
                : `${result.provider.name} added. Connect its API key to use it.`,
            )
          }}
        />
      ) : null}
    </View>
  )
}

/**
 * Provider glyph: the original brand mark when vendored (models.dev), an
 * explicit `metadata.icon` URL when the backend provides one, and otherwise a
 * deterministic monogram.
 */
function ProviderAvatar({ integration }: { integration: Pick<Integration, "id" | "name"> & Partial<Integration> }) {
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

interface ModelRow {
  key: number
  id: string
  name: string
  context: string
  output: string
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

function positiveInteger(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function AddProviderModal({
  client,
  onClose,
  onCreated,
}: {
  client: Client
  onClose: () => void
  onCreated: (result: CustomProviderCreateResult) => Promise<void>
}) {
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()
  const nextKey = useRef(1)
  const newRow = (): ModelRow => ({ key: nextKey.current++, id: "", name: "", context: "", output: "" })
  const [name, setName] = useState("")
  const [id, setID] = useState("")
  const [idTouched, setIDTouched] = useState(false)
  const [baseURL, setBaseURL] = useState("")
  const [key, setKey] = useState("")
  const [providerPackage, setProviderPackage] = useState<CustomProviderPackage>("openai-compatible")
  const [models, setModels] = useState<ModelRow[]>([newRow()])
  const [advanced, setAdvanced] = useState(false)
  const [headers, setHeaders] = useState<Array<{ key: number; name: string; value: string }>>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const validModels = models.filter((model) => model.id.trim().length > 0)
  const canSubmit =
    !busy &&
    Boolean(name.trim()) &&
    isValidProviderId(id.trim()) &&
    isHttpUrl(baseURL.trim()) &&
    validModels.length > 0

  function updateModel(rowKey: number, patch: Partial<ModelRow>): void {
    setModels((rows) => rows.map((row) => (row.key === rowKey ? { ...row, ...patch } : row)))
  }

  async function submit(): Promise<void> {
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    const headerObject: Record<string, string> = {}
    for (const header of headers) {
      if (header.name.trim()) headerObject[header.name.trim()] = header.value
    }
    try {
      const result = await client.api.createCustomProvider({
        id: id.trim(),
        name: name.trim(),
        baseURL: baseURL.trim(),
        package: providerPackage,
        models: validModels.map((model) => {
          const context = positiveInteger(model.context)
          const output = positiveInteger(model.output)
          return {
            id: model.id.trim(),
            ...(model.name.trim() ? { name: model.name.trim() } : {}),
            ...(context !== undefined && output !== undefined ? { context, output } : {}),
          }
        }),
        ...(Object.keys(headerObject).length > 0 ? { headers: headerObject } : {}),
        ...(key.trim() ? { key: key.trim() } : {}),
      })
      setKey("")
      await onCreated(result)
    } catch (err) {
      setError(customProviderErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard} accessibilityLabel="Add OpenAI-compatible provider">
          <ScrollView contentContainerStyle={styles.modalContent} keyboardShouldPersistTaps="handled">
            <Text style={styles.modalTitle}>Add OpenAI-compatible provider</Text>
            <Text style={styles.hint}>
              opencode gains the provider's models; the key stays in opencode's data volume.
            </Text>
            <TextInput
              value={name}
              onChangeText={(value) => {
                setName(value)
                if (!idTouched) setID(providerIdFromName(value))
              }}
              placeholder="Display name"
              placeholderTextColor={colors.textFaint}
              autoCapitalize="none"
              accessibilityLabel="Display name"
              style={styles.input}
            />
            <TextInput
              value={id}
              onChangeText={(value) => {
                setIDTouched(true)
                setID(value.toLowerCase())
              }}
              placeholder="Provider id"
              placeholderTextColor={colors.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="Provider id"
              style={styles.input}
            />
            <TextInput
              value={baseURL}
              onChangeText={setBaseURL}
              placeholder="Base URL (https://…/v1)"
              placeholderTextColor={colors.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="Base URL"
              style={styles.input}
            />
            <TextInput
              value={key}
              onChangeText={setKey}
              placeholder="API key (optional)"
              placeholderTextColor={colors.textFaint}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="API key"
              style={styles.input}
            />

            <Text style={styles.groupLabel}>Models</Text>
            {models.map((model) => (
              <View key={model.key} style={styles.modelRow}>
                <TextInput
                  value={model.id}
                  onChangeText={(value) => updateModel(model.key, { id: value })}
                  placeholder="model-id"
                  placeholderTextColor={colors.textFaint}
                  autoCapitalize="none"
                  autoCorrect={false}
                  accessibilityLabel="Model id"
                  style={styles.input}
                />
                <TextInput
                  value={model.name}
                  onChangeText={(value) => updateModel(model.key, { name: value })}
                  placeholder="Display name (optional)"
                  placeholderTextColor={colors.textFaint}
                  autoCapitalize="none"
                  accessibilityLabel="Model display name"
                  style={styles.input}
                />
                {advanced ? (
                  <View style={styles.modelLimits}>
                    <TextInput
                      value={model.context}
                      onChangeText={(value) => updateModel(model.key, { context: value })}
                      placeholder="Context tokens"
                      placeholderTextColor={colors.textFaint}
                      keyboardType="number-pad"
                      accessibilityLabel="Context tokens"
                      style={[styles.input, styles.halfInput]}
                    />
                    <TextInput
                      value={model.output}
                      onChangeText={(value) => updateModel(model.key, { output: value })}
                      placeholder="Output tokens"
                      placeholderTextColor={colors.textFaint}
                      keyboardType="number-pad"
                      accessibilityLabel="Output tokens"
                      style={[styles.input, styles.halfInput]}
                    />
                  </View>
                ) : null}
                {models.length > 1 ? (
                  <Pressable
                    onPress={() => setModels((rows) => rows.filter((row) => row.key !== model.key))}
                    accessibilityRole="button"
                    accessibilityLabel="Remove model"
                  >
                    <Text style={styles.action}>Remove model</Text>
                  </Pressable>
                ) : null}
              </View>
            ))}
            <Pressable
              onPress={() => setModels((rows) => [...rows, newRow()])}
              accessibilityRole="button"
              accessibilityLabel="Add model"
              style={styles.secondary}
            >
              <Text style={styles.secondaryText}>Add model</Text>
            </Pressable>

            <Pressable
              onPress={() => setAdvanced((value) => !value)}
              accessibilityRole="button"
              accessibilityLabel="Advanced"
              accessibilityState={{ expanded: advanced }}
              style={styles.secondary}
            >
              <Text style={styles.secondaryText}>{advanced ? "Hide advanced" : "Advanced"}</Text>
            </Pressable>

            {advanced ? (
              <View style={styles.advancedBox}>
                <Text style={styles.groupLabel}>Transport</Text>
                {(
                  [
                    ["openai-compatible", "Chat completions (/v1/chat/completions)"],
                    ["openai", "Responses (/v1/responses)"],
                  ] as const
                ).map(([value, text]) => (
                  <Pressable
                    key={value}
                    onPress={() => setProviderPackage(value)}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: providerPackage === value }}
                    accessibilityLabel={text}
                    style={styles.radioRow}
                  >
                    <View style={[styles.radioDot, providerPackage === value && styles.radioDotOn]} />
                    <Text style={styles.radioText}>{text}</Text>
                  </Pressable>
                ))}
                <Text style={styles.groupLabel}>Custom headers</Text>
                {headers.map((header) => (
                  <View key={header.key} style={styles.headerRow}>
                    <TextInput
                      value={header.name}
                      onChangeText={(value) =>
                        setHeaders((rows) => rows.map((row) => (row.key === header.key ? { ...row, name: value } : row)))
                      }
                      placeholder="Header"
                      placeholderTextColor={colors.textFaint}
                      autoCapitalize="none"
                      accessibilityLabel="Header name"
                      style={[styles.input, styles.halfInput]}
                    />
                    <TextInput
                      value={header.value}
                      onChangeText={(value) =>
                        setHeaders((rows) => rows.map((row) => (row.key === header.key ? { ...row, value } : row)))
                      }
                      placeholder="Value"
                      placeholderTextColor={colors.textFaint}
                      autoCapitalize="none"
                      accessibilityLabel="Header value"
                      style={[styles.input, styles.halfInput]}
                    />
                    <Pressable
                      onPress={() => setHeaders((rows) => rows.filter((row) => row.key !== header.key))}
                      accessibilityRole="button"
                      accessibilityLabel="Remove header"
                    >
                      <Text style={styles.danger}>Remove</Text>
                    </Pressable>
                  </View>
                ))}
                <Pressable
                  onPress={() => setHeaders((rows) => [...rows, { key: nextKey.current++, name: "", value: "" }])}
                  accessibilityRole="button"
                  accessibilityLabel="Add header"
                  style={styles.secondary}
                >
                  <Text style={styles.secondaryText}>Add header</Text>
                </Pressable>
              </View>
            ) : null}

            {error ? <Text style={styles.error}>{error}</Text> : null}
            <View style={styles.formActions}>
              <Pressable
                onPress={onClose}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel="Cancel add provider"
                style={styles.secondary}
              >
                <Text style={styles.secondaryText}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={() => void submit()}
                disabled={!canSubmit}
                accessibilityRole="button"
                accessibilityLabel="Save provider"
                style={[styles.primary, !canSubmit && styles.disabled]}
              >
                <Text style={styles.primaryText}>{busy ? "Adding…" : "Add provider"}</Text>
              </Pressable>
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
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
    notice: {
      color: colors.accent,
      fontFamily: fonts.ui,
      fontSize: 12,
      marginTop: 8,
    },
    groupLabel: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 11,
      letterSpacing: 0.6,
      textTransform: "uppercase",
      fontWeight: "600",
      marginTop: 14,
    },
    addButton: {
      minHeight: 44,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.accent,
      borderRadius: 10,
      paddingHorizontal: 16,
      marginTop: 4,
    },
    addButtonText: {
      color: colors.onAccent,
      fontFamily: fonts.ui,
      fontSize: 14,
      fontWeight: "600",
    },
    baseUrl: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 11,
      marginTop: 4,
    },
    customActions: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginTop: 10,
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
    halfInput: {
      flex: 1,
    },
    formActions: {
      flexDirection: "row",
      justifyContent: "flex-end",
      gap: 8,
      marginTop: 8,
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
    modalBackdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.45)",
      justifyContent: "flex-end",
    },
    modalCard: {
      maxHeight: "90%",
      backgroundColor: colors.surface,
      borderTopLeftRadius: 16,
      borderTopRightRadius: 16,
    },
    modalContent: {
      padding: 16,
      gap: 8,
    },
    modalTitle: {
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 16,
      fontWeight: "600",
    },
    modelRow: {
      gap: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      borderRadius: 10,
      padding: 8,
      marginTop: 8,
    },
    modelLimits: {
      flexDirection: "row",
      gap: 8,
    },
    advancedBox: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      borderRadius: 10,
      padding: 10,
      gap: 6,
      marginTop: 8,
    },
    radioRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      minHeight: 40,
    },
    radioDot: {
      width: 18,
      height: 18,
      borderRadius: 9,
      borderWidth: 2,
      borderColor: colors.hairlineStrong,
    },
    radioDotOn: {
      borderColor: colors.accent,
      backgroundColor: colors.accent,
    },
    radioText: {
      flex: 1,
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 13,
    },
    headerRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      marginTop: 8,
    },
  })
}
