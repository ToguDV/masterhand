import { useEffect, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Image, Linking, Pressable, StyleSheet, Text, TextInput, View } from "react-native"
import {
  ApiError,
  RequestTimeoutError,
  queryKeys,
  useGithubStatus,
  type Client,
  type GithubStatus,
} from "@masterhand/client-core"
import { useTheme, useThemedStyles, type Fonts, type Palette } from "../theme"
import { ExternalLinkIcon, GithubIcon } from "./icons"
import { Skeleton, SkeletonStatus } from "./Skeleton"

function errorCode(error: ApiError): string | null {
  try {
    const body = JSON.parse(error.message) as { error?: unknown }
    return typeof body.error === "string" ? body.error : null
  } catch {
    return null
  }
}

export function githubErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 400) return "GitHub rejected that token. Check that it is valid and not expired."
    if (error.status === 404) return "This server does not support GitHub integration yet. Update the server."
    if (error.status === 502) {
      return errorCode(error) === "github_rejected"
        ? "GitHub rejected the request. Check the token permissions, rate limit or organization SSO policy."
        : "Could not reach GitHub from the server. Check its Internet connection and try again."
    }
  }
  if (error instanceof RequestTimeoutError) {
    return "The server did not answer in time. Reopen settings to check whether the token was saved."
  }
  return "Could not update the GitHub integration."
}

function shortDate(value: string | null): string {
  if (!value) return "just now"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "just now" : date.toLocaleDateString()
}

/** Last known status per client for this process; picks the card vs form skeleton. */
const connectedHints = new WeakMap<Client, boolean>()

function GithubSkeleton({ connected }: { connected: boolean }) {
  const styles = useThemedStyles(createStyles)
  if (connected) {
    return (
      <View style={styles.card} testID="github-skeleton">
        <View style={styles.accountRow}>
          <Skeleton width={40} height={40} radius={20} />
          <View style={styles.accountText}>
            <Skeleton width={120} height={14} />
            <Skeleton width={180} height={12} style={{ marginTop: 6 }} />
          </View>
        </View>
        <View style={styles.actions}>
          <Skeleton width={110} height={44} radius={8} />
          <Skeleton width={96} height={44} radius={8} />
        </View>
      </View>
    )
  }
  return (
    <View style={styles.skeletonForm} testID="github-skeleton">
      <Skeleton width={160} height={12} />
      <Skeleton width="100%" height={44} radius={6} style={{ marginTop: 4 }} />
      <Skeleton width="100%" height={12} style={{ marginTop: 10 }} />
      <Skeleton width="80%" height={12} style={{ marginTop: 6 }} />
      <View style={styles.actions}>
        <Skeleton width={120} height={44} radius={8} />
        <Skeleton width={90} height={12} />
      </View>
      <View style={styles.skeletonLink}>
        <Skeleton width={100} height={12} />
      </View>
    </View>
  )
}

/**
 * Settings > GitHub. The token is write-only; the status only carries the
 * account identity and whether the agent container received the credential
 * files. Mirrors the web section.
 */
export function GithubSection({ client }: { client: Client }) {
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()
  const queryClient = useQueryClient()
  const statusQuery = useGithubStatus(client)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [token, setToken] = useState("")
  const [replacing, setReplacing] = useState(false)

  const status = statusQuery.data ?? null
  const loading = statusQuery.isPending
  const fetchError = statusQuery.isError && !status ? githubErrorMessage(statusQuery.error) : null
  const connectedHint = connectedHints.get(client)

  useEffect(() => {
    if (statusQuery.data) connectedHints.set(client, statusQuery.data.connected)
  }, [client, statusQuery.data])

  async function applyStatus(next: GithubStatus): Promise<void> {
    // A background refetch started before the mutation must not overwrite the
    // fresher status this request just returned.
    await queryClient.cancelQueries({ queryKey: queryKeys.github })
    queryClient.setQueryData(queryKeys.github, next)
  }

  async function connect(): Promise<void> {
    const value = token.trim()
    if (!value || busy) return
    setBusy(true)
    setError(null)
    try {
      await applyStatus(await client.github.connect(value))
      setToken("")
      setReplacing(false)
    } catch (err) {
      if (err instanceof RequestTimeoutError) {
        const reconciled = await client.github.status().catch(() => null)
        if (reconciled?.connected) {
          await applyStatus(reconciled)
          setToken("")
          setReplacing(false)
          return
        }
      }
      setError(githubErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  async function disconnect(): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await applyStatus(await client.github.disconnect())
      setToken("")
      setReplacing(false)
    } catch (err) {
      setError(githubErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const connected = status?.connected === true
  const showForm = !connected || replacing

  return (
    <View>
      <View style={styles.titleRow}>
        <GithubIcon size={18} color={colors.text} />
        <Text style={styles.sectionTitle}>GitHub</Text>
      </View>
      <Text style={styles.desc}>
        Connect a GitHub account so agents can create branches, push commits and open pull requests with git and gh
        inside the agent container.
      </Text>

      {loading ? <SkeletonStatus label="Loading GitHub status…" /> : null}
      {loading ? <GithubSkeleton connected={connectedHint === true} /> : null}
      {error ?? fetchError ? <Text style={styles.error}>{error ?? fetchError}</Text> : null}
      {!connected && status?.agentConfigError ? (
        <Text style={styles.warning}>Credential cleanup failed: {status.agentConfigError}</Text>
      ) : null}

      {connected && !replacing ? (
        <View style={styles.card}>
          <View style={styles.accountRow}>
            {status?.avatarUrl ? (
              <Image source={{ uri: status.avatarUrl }} style={styles.avatar} />
            ) : (
              <View style={styles.avatarFallback}>
                <GithubIcon size={18} color={colors.textMuted} />
              </View>
            )}
            <View style={styles.accountText}>
              <Text style={styles.accountName} numberOfLines={1}>
                {status?.name ?? `@${status?.login ?? "github"}`}
              </Text>
              <Text style={styles.accountMeta} numberOfLines={1}>
                @{status?.login} · connected {shortDate(status?.updatedAt ?? null)}
              </Text>
            </View>
          </View>

          {status && !status.injected ? (
            <Text style={styles.warning}>
              The token is saved, but the agent container has not received it.
              {status.agentConfigError ? ` ${status.agentConfigError}` : " Check the server's AGENT_CONFIG_DIR and shared volume."}
            </Text>
          ) : null}

          <View style={styles.actions}>
            <Pressable
              style={styles.secondaryButton}
              onPress={() => setReplacing(true)}
              accessibilityRole="button"
              accessibilityLabel="Replace GitHub token"
            >
              <Text style={styles.secondaryText}>Replace token</Text>
            </Pressable>
            <Pressable
              style={styles.dangerButton}
              disabled={busy}
              onPress={() => void disconnect()}
              accessibilityRole="button"
              accessibilityLabel="Disconnect GitHub"
            >
              <Text style={styles.dangerText}>{busy ? "Disconnecting…" : "Disconnect"}</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {showForm && !loading ? (
        <View>
          <Text style={styles.label}>Fine-grained personal access token</Text>
          <TextInput
            value={token}
            onChangeText={setToken}
            placeholder="github_pat_…"
            placeholderTextColor={colors.textFaint}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
            accessibilityLabel="Fine-grained personal access token"
          />
          <Text style={styles.hint}>
            The token is stored on the server and never shown again. Use an expiry and the minimum permissions.
          </Text>
          <View style={styles.actions}>
            <Pressable
              style={[styles.primaryButton, (!token.trim() || busy) && styles.buttonDisabled]}
              disabled={!token.trim() || busy}
              onPress={() => void connect()}
              accessibilityRole="button"
              accessibilityLabel={connected ? "Replace GitHub token" : "Connect GitHub"}
            >
              <Text style={styles.primaryText}>
                {busy ? "Connecting…" : connected ? "Replace token" : "Connect GitHub"}
              </Text>
            </Pressable>
            {replacing ? (
              <Pressable
                style={styles.secondaryButton}
                disabled={busy}
                onPress={() => {
                  setReplacing(false)
                  setToken("")
                  setError(null)
                }}
                accessibilityRole="button"
              >
                <Text style={styles.secondaryText}>Cancel</Text>
              </Pressable>
            ) : null}
          </View>
          <Pressable
            style={styles.linkRow}
            onPress={() => void Linking.openURL("https://github.com/settings/personal-access-tokens/new")}
            accessibilityRole="link"
            accessibilityLabel="Create a GitHub token"
          >
            <Text style={styles.link}>Create a token</Text>
            <ExternalLinkIcon size={12} color={colors.accent} />
          </Pressable>
        </View>
      ) : null}

      <Text style={styles.permissionsTitle}>Recommended token permissions</Text>
      <Text style={styles.permissions}>
        Repository access: the repos the agent should work in (or all repositories for repo creation). Contents and
        Pull requests: read and write. Metadata: read. Workflows: read and write only if the agent edits Actions
        files. Account permission Repository creation: read and write if the agent should create repos.
      </Text>
    </View>
  )
}

function createStyles(colors: Palette, fonts: Fonts) {
  return StyleSheet.create({
    titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    sectionTitle: { color: colors.text, fontFamily: fonts.ui, fontSize: 16, fontWeight: "600" },
    desc: { color: colors.textMuted, fontFamily: fonts.ui, fontSize: 13, marginTop: 6, marginBottom: 12 },
    skeletonForm: { marginTop: 12, marginBottom: 12 },
    skeletonLink: { minHeight: 32, marginTop: 12, justifyContent: "center" },
    error: { color: colors.danger, fontFamily: fonts.ui, fontSize: 12, marginBottom: 10 },
    card: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      backgroundColor: colors.surfaceMuted,
      borderRadius: 8,
      padding: 12,
      marginBottom: 12,
    },
    accountRow: { flexDirection: "row", alignItems: "center", gap: 12 },
    avatar: { width: 40, height: 40, borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline },
    avatarFallback: {
      width: 40,
      height: 40,
      borderRadius: 20,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      alignItems: "center",
      justifyContent: "center",
    },
    accountText: { flex: 1, minWidth: 0 },
    accountName: { color: colors.text, fontFamily: fonts.ui, fontSize: 14, fontWeight: "600" },
    accountMeta: { color: colors.textMuted, fontFamily: fonts.ui, fontSize: 12, marginTop: 2 },
    warning: {
      color: colors.textSoft,
      fontFamily: fonts.ui,
      fontSize: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.warningLine,
      backgroundColor: colors.warningSoft,
      borderRadius: 4,
      paddingHorizontal: 8,
      paddingVertical: 6,
      marginTop: 10,
    },
    actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12 },
    primaryButton: {
      backgroundColor: colors.accent,
      borderRadius: 8,
      minHeight: 44,
      paddingHorizontal: 14,
      justifyContent: "center",
    },
    primaryText: { color: colors.onAccent, fontFamily: fonts.ui, fontSize: 13, fontWeight: "600" },
    secondaryButton: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairlineStrong,
      borderRadius: 8,
      minHeight: 44,
      paddingHorizontal: 14,
      justifyContent: "center",
    },
    secondaryText: { color: colors.text, fontFamily: fonts.ui, fontSize: 13, fontWeight: "600" },
    dangerButton: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.dangerLine,
      borderRadius: 8,
      minHeight: 44,
      paddingHorizontal: 14,
      justifyContent: "center",
    },
    dangerText: { color: colors.danger, fontFamily: fonts.ui, fontSize: 13, fontWeight: "600" },
    buttonDisabled: { opacity: 0.5 },
    label: { color: colors.textSoft, fontFamily: fonts.ui, fontSize: 12, fontWeight: "600", marginBottom: 4 },
    input: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairlineStrong,
      borderRadius: 6,
      backgroundColor: colors.surface,
      color: colors.text,
      fontFamily: fonts.mono,
      fontSize: 12,
      minHeight: 44,
      paddingHorizontal: 10,
      paddingVertical: 8,
    },
    hint: { color: colors.textMuted, fontFamily: fonts.ui, fontSize: 12, marginTop: 6 },
    linkRow: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 12, minHeight: 32 },
    link: { color: colors.accent, fontFamily: fonts.ui, fontSize: 12, fontWeight: "600" },
    permissionsTitle: { color: colors.textSoft, fontFamily: fonts.ui, fontSize: 12, fontWeight: "600", marginTop: 20 },
    permissions: { color: colors.textMuted, fontFamily: fonts.ui, fontSize: 12, lineHeight: 18, marginTop: 4 },
  })
}
