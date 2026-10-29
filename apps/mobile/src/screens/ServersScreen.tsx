import { useEffect, useState } from "react"
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native"
import {
  MAX_SERVER_LABEL_LENGTH,
  MAX_SERVER_URL_LENGTH,
  normalizeServerUrl,
  serverUrlErrorMessage,
} from "@masterhand/client-core"
import { Screen } from "../components/Screen"
import { Deco } from "../components/Deco"
import { BackIcon, EyeIcon, EyeOffIcon, GlobeIcon, PlusIcon } from "../components/icons"
import { ServerMonogram, ServerStatus } from "../components/ServerStatus"
import { useTheme, useThemedStyles, type Fonts, type Palette } from "../theme"
import type { StoredServerProfile } from "../storage"

export interface ServerFormValues {
  url: string
  label: string
  password: string
}

/**
 * Mobile Servers screen: first run, saved list, add form and re-auth. The root
 * owns profiles and credentials; this screen only validates form input.
 */
export function ServersScreen({
  profiles,
  activeID,
  initialUrl,
  busy,
  error,
  notice,
  reauthProfile,
  startAdding = false,
  draft = null,
  connecting = null,
  onSubmit,
  onSelect,
  onCancel,
  onCancelAdd,
  onCancelConnect = () => {},
}: {
  profiles: StoredServerProfile[]
  activeID: string | null
  initialUrl: string
  busy: boolean
  error: string | null
  notice: string | null
  reauthProfile: StoredServerProfile | null
  startAdding?: boolean
  draft?: { url: string; label: string } | null
  connecting?: { label: string; url: string } | null
  onSubmit: (
    mode: "first-run" | "add" | "reauth",
    values: ServerFormValues,
    profile?: StoredServerProfile,
  ) => void
  onSelect: (profile: StoredServerProfile) => void
  onCancel: () => void
  onCancelAdd: () => void
  onCancelConnect?: () => void
}) {
  const [adding, setAdding] = useState(startAdding)
  const firstRun = profiles.length === 0
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()

  useEffect(() => {
    if (startAdding) setAdding(true)
  }, [startAdding])

  const mode = reauthProfile ? "reauth" : firstRun ? "first-run" : adding ? "add" : "list"

  if (connecting) {
    return (
      <Screen style={styles.screen}>
        <View style={styles.decoWrap} pointerEvents="none">
          <Deco variant="blob" style={styles.blob} />
          <Deco variant="dots" style={styles.dots} />
        </View>
        <View style={styles.connectingWrap}>
          <View style={styles.connectingCard} testID="connecting-card">
            <ServerMonogram label={connecting.label} active size={48} />
            <Text style={styles.connectingTitle}>Connecting to {connecting.label}</Text>
            <Text style={styles.connectingHost}>{hostOf(connecting.url)}</Text>
            <ServerStatus status="connecting" size={24} showLabel={false} />
            <Text style={styles.connectingFine}>This can take a few seconds.</Text>
            <Pressable
              testID="cancel-connect"
              onPress={onCancelConnect}
              accessibilityRole="button"
              accessibilityLabel="Cancel connecting"
              style={styles.cancelButton}
            >
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Screen>
    )
  }

  return (
    <Screen style={styles.screen}>
      <View style={styles.decoWrap} pointerEvents="none">
        <Deco variant="blob" style={styles.blob} />
        <Deco variant="dots" style={styles.dots} />
      </View>

      {mode === "list" ? (
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.brandRow}>
            <Text style={styles.brand}>MasterHand</Text>
            <Text style={styles.count}>{profiles.length} saved</Text>
          </View>
          <Text style={styles.eyebrow}>Your workspace</Text>
          <Text style={styles.title}>Servers</Text>
          <Text style={styles.subtitle}>One connection at a time.</Text>

          {notice ? <Text style={styles.notice}>{notice}</Text> : null}
          {error ? <Text style={styles.error}>{error}</Text> : null}

          <View style={styles.list}>
            {profiles.map((profile) => {
              const active = profile.id === activeID
              return (
                <Pressable
                  key={profile.id}
                  testID={`server-row-${profile.id}`}
                  onPress={() => onSelect(profile)}
                  disabled={busy}
                  accessibilityRole="button"
                  accessibilityLabel={`${profile.label}, ${
                    active ? "Connected" : profile.expired ? "Expired" : "Saved"
                  }`}
                  style={[styles.row, active && styles.rowActive]}
                >
                  <ServerMonogram label={profile.label} active={active} />
                  <View style={styles.rowBody}>
                    <Text style={styles.rowName} numberOfLines={1}>
                      {profile.label}
                    </Text>
                    <Text style={styles.rowHost} numberOfLines={1}>
                      {hostOf(profile.url)}
                    </Text>
                  </View>
                  <ServerStatus status={active ? "connected" : profile.expired ? "expired" : "saved"} />
                </Pressable>
              )
            })}
          </View>

          <Pressable
            testID="add-server"
            onPress={() => setAdding(true)}
            accessibilityRole="button"
            accessibilityLabel="Add another server"
            style={styles.addRow}
          >
            <View style={styles.plusTile}>
              <PlusIcon size={14} color={colors.textMuted} />
            </View>
            <Text style={styles.addText}>Add another server</Text>
          </Pressable>
          <Text style={styles.note}>Only the active server sends live updates. The others keep working.</Text>
        </ScrollView>
      ) : (
        <ScrollView contentContainerStyle={styles.formContent} keyboardShouldPersistTaps="handled">
          {mode !== "first-run" ? (
            <Pressable
              onPress={() => {
                setAdding(false)
                onCancelAdd()
                onCancel()
              }}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Back to servers"
              style={styles.backRow}
            >
              <BackIcon size={18} color={colors.textMuted} />
              <Text style={styles.backText}>Servers</Text>
            </Pressable>
          ) : null}

          <Text style={styles.eyebrow}>{mode === "first-run" ? "First run" : mode === "reauth" ? "Session expired" : "New connection"}</Text>
          <Text style={styles.title}>
            {mode === "first-run"
              ? "Connect your first server"
              : mode === "reauth"
                ? `Reconnect to ${reauthProfile?.label ?? "server"}`
                : "Add a server"}
          </Text>
          <Text style={styles.subtitle}>
            {mode === "reauth"
              ? "The saved session expired. Enter this server's password again."
              : "URL, name and password. Each server keeps its own credential."}
          </Text>

          <ServerForm
            mode={mode}
            initialUrl={draft?.url ?? (mode === "first-run" ? initialUrl : "")}
            initialLabel={draft?.label ?? ""}
            profile={reauthProfile}
            profiles={profiles}
            busy={busy}
            error={error}
            onSubmit={(values) => onSubmit(mode, values, reauthProfile ?? undefined)}
          />
        </ScrollView>
      )}
    </Screen>
  )
}

function ServerForm({
  mode,
  initialUrl,
  initialLabel = "",
  profile,
  profiles,
  busy,
  error,
  onSubmit,
}: {
  mode: "first-run" | "add" | "reauth"
  initialUrl: string
  initialLabel?: string
  profile: StoredServerProfile | null
  profiles: StoredServerProfile[]
  busy: boolean
  error: string | null
  onSubmit: (values: ServerFormValues) => void
}) {
  const [url, setUrl] = useState(profile?.url ?? initialUrl)
  const [label, setLabel] = useState(initialLabel)
  const [password, setPassword] = useState("")
  const [reveal, setReveal] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()
  const showUrl = mode !== "reauth"

  function submit(): void {
    if (busy) return
    setLocalError(null)
    let normalizedUrl = profile?.url ?? ""
    if (showUrl) {
      const normalized = normalizeServerUrl(url)
      if (!normalized.ok) {
        setLocalError(serverUrlErrorMessage(normalized.error))
        return
      }
      normalizedUrl = normalized.server.url
      if (mode === "add" && profiles.some((item) => item.url === normalizedUrl)) {
        setLocalError("This server is already saved.")
        return
      }
    }
    if (!password) {
      setLocalError("Enter the password")
      return
    }
    onSubmit({
      url: normalizedUrl,
      label: label.trim().slice(0, MAX_SERVER_LABEL_LENGTH),
      password,
    })
  }

  const canSubmit = password.length > 0 && (!showUrl || url.trim().length > 0) && !busy

  return (
    <View style={styles.form}>
      {showUrl ? (
        <>
          <Text style={styles.label}>Server URL</Text>
          <View style={styles.inputWrap}>
            <View style={styles.inputLead}>
              <GlobeIcon size={16} color={colors.textFaint} />
            </View>
            <TextInput
              style={[styles.input, styles.inputWithLead]}
              testID="server-url-input"
              value={url}
              onChangeText={setUrl}
              placeholder="https://masterhand.example.com"
              placeholderTextColor={colors.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              inputMode="url"
              maxLength={MAX_SERVER_URL_LENGTH}
            />
          </View>
        </>
      ) : null}

      {showUrl ? (
        <>
          <Text style={styles.label}>Name (optional)</Text>
          <TextInput
            style={styles.input}
            testID="server-name-input"
            value={label}
            onChangeText={setLabel}
            placeholder="Home"
            placeholderTextColor={colors.textFaint}
            autoCapitalize="words"
            maxLength={MAX_SERVER_LABEL_LENGTH}
          />
        </>
      ) : null}

      <Text style={styles.label}>Password</Text>
      <View style={styles.inputWrap}>
        <TextInput
          style={[styles.input, styles.inputWithEnd]}
          testID="password-input"
          value={password}
          onChangeText={setPassword}
          placeholder="••••••••"
          placeholderTextColor={colors.textFaint}
          secureTextEntry={!reveal}
          autoComplete={mode === "reauth" ? "current-password" : "off"}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="go"
          onSubmitEditing={submit}
        />
        <Pressable
          onPress={() => setReveal((value) => !value)}
          accessibilityRole="button"
          accessibilityLabel={reveal ? "Hide password" : "Show password"}
          style={styles.inputEnd}
        >
          {reveal ? <EyeOffIcon size={18} color={colors.textMuted} /> : <EyeIcon size={18} color={colors.textMuted} />}
        </Pressable>
      </View>

      {localError || error ? <Text style={styles.error}>{localError ?? error}</Text> : null}

      <Pressable
        testID="connect-button"
        onPress={submit}
        disabled={!canSubmit}
        accessibilityRole="button"
        accessibilityLabel={mode === "reauth" ? "Reconnect" : "Connect"}
        style={[styles.button, !canSubmit && styles.buttonDisabled]}
      >
        {busy ? (
          <ActivityIndicator color={colors.onAccent} />
        ) : (
          <Text style={[styles.buttonText, !canSubmit && styles.buttonTextDisabled]}>
            {mode === "reauth" ? "Reconnect" : "Connect"}
          </Text>
        )}
      </Pressable>
      <Text style={styles.fine}>
        Your password is sent only to this server. This device stores a revocable token.
      </Text>
    </View>
  )
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function createStyles(colors: Palette, fonts: Fonts) {
  return StyleSheet.create({
    screen: {
      flex: 1,
    },
    decoWrap: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      overflow: "hidden",
    },
    blob: {
      position: "absolute",
      top: -70,
      right: -80,
    },
    dots: {
      position: "absolute",
      bottom: 16,
      left: -20,
      opacity: 0.5,
    },
    content: {
      padding: 16,
      paddingBottom: 32,
      gap: 8,
    },
    formContent: {
      padding: 16,
      paddingBottom: 32,
      gap: 6,
    },
    brandRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: 10,
    },
    brand: {
      color: colors.text,
      fontFamily: fonts.display,
      fontSize: 20,
      fontWeight: "600",
    },
    count: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 11,
    },
    eyebrow: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 11,
      fontWeight: "600",
      letterSpacing: 0.8,
      textTransform: "uppercase",
    },
    title: {
      color: colors.text,
      fontFamily: fonts.display,
      fontSize: 28,
      fontWeight: "500",
      lineHeight: 33,
    },
    subtitle: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 13,
      lineHeight: 19,
      marginBottom: 6,
    },
    list: {
      gap: 2,
      marginTop: 4,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      minHeight: 56,
      paddingHorizontal: 10,
      paddingVertical: 8,
      borderWidth: 1,
      borderColor: "transparent",
      borderRadius: 12,
    },
    rowActive: {
      borderColor: colors.hairline,
      backgroundColor: colors.surfaceMuted,
    },
    rowBody: {
      flex: 1,
      minWidth: 0,
      gap: 1,
    },
    rowName: {
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 14,
      fontWeight: "600",
    },
    rowHost: {
      color: colors.textFaint,
      fontFamily: fonts.mono,
      fontSize: 11,
    },
    addRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      minHeight: 52,
      paddingHorizontal: 10,
      paddingVertical: 8,
      marginTop: 6,
      borderWidth: 1,
      borderStyle: "dashed",
      borderColor: colors.hairlineStrong,
      borderRadius: 12,
    },
    addText: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 14,
    },
    plusTile: {
      width: 28,
      height: 28,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: colors.hairlineStrong,
      borderRadius: 8,
    },
    note: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 12,
      lineHeight: 17,
      marginTop: 4,
    },
    notice: {
      color: colors.warning,
      fontFamily: fonts.ui,
      fontSize: 12,
    },
    connectingWrap: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: 16,
    },
    connectingCard: {
      width: "100%",
      maxWidth: 340,
      alignItems: "center",
      gap: 10,
      paddingHorizontal: 24,
      paddingVertical: 28,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      borderRadius: 24,
      backgroundColor: colors.surface,
    },
    connectingTitle: {
      color: colors.text,
      fontFamily: fonts.display,
      fontSize: 24,
      fontWeight: "500",
      textAlign: "center",
    },
    connectingHost: {
      color: colors.textMuted,
      fontFamily: fonts.mono,
      fontSize: 12,
      textAlign: "center",
    },
    connectingFine: {
      color: colors.textFaint,
      fontFamily: fonts.ui,
      fontSize: 11,
      textAlign: "center",
    },
    cancelButton: {
      minHeight: 44,
      justifyContent: "center",
      paddingHorizontal: 14,
      borderRadius: 10,
    },
    cancelText: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 13,
    },
    backRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      minHeight: 44,
      marginBottom: 4,
    },
    backText: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 13,
    },
    form: {
      gap: 4,
    },
    label: {
      color: colors.textSoft,
      fontFamily: fonts.ui,
      fontSize: 13,
      fontWeight: "500",
      marginTop: 10,
      marginBottom: 6,
    },
    inputWrap: {
      position: "relative",
    },
    inputLead: {
      position: "absolute",
      top: 0,
      bottom: 0,
      left: 12,
      justifyContent: "center",
      zIndex: 1,
    },
    input: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairlineStrong,
      backgroundColor: colors.surface,
      borderRadius: 12,
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 15,
      minHeight: 44,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    inputWithLead: {
      paddingLeft: 38,
    },
    inputWithEnd: {
      paddingRight: 48,
    },
    inputEnd: {
      position: "absolute",
      top: 0,
      right: 0,
      bottom: 0,
      width: 44,
      alignItems: "center",
      justifyContent: "center",
    },
    error: {
      color: colors.danger,
      fontFamily: fonts.ui,
      fontSize: 13,
      marginTop: 10,
      lineHeight: 18,
    },
    button: {
      marginTop: 18,
      alignItems: "center",
      justifyContent: "center",
      minHeight: 44,
      borderRadius: 12,
      backgroundColor: colors.accent,
    },
    buttonDisabled: {
      backgroundColor: colors.surfaceMuted,
    },
    buttonText: {
      color: colors.onAccent,
      fontFamily: fonts.ui,
      fontSize: 14,
      fontWeight: "500",
    },
    buttonTextDisabled: {
      color: colors.textFaint,
    },
    fine: {
      color: colors.textFaint,
      fontFamily: fonts.ui,
      fontSize: 11,
      lineHeight: 15,
      marginTop: 4,
    },
  })
}
