import { useState } from "react"
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from "react-native"
import {
  directoryName,
  filterSessions,
  formatRelative,
  rootSessions,
  type CreateWorkspaceInput,
  type Session,
  type SessionFilter,
  type SessionStatuses,
  type WorkspaceRecord,
} from "@masterhand/client-core"
import { Screen } from "../components/Screen"
import { NewSessionMenu } from "../components/NewSessionMenu"
import { WorkspaceModal } from "../components/WorkspaceModal"
import { GearIcon, LogOutIcon } from "../components/icons"
import { Deco } from "../components/Deco"
import { useTheme, useThemedStyles, type Fonts, type Palette } from "../theme"

export function SessionsScreen({
  sessions,
  loading,
  statuses,
  connected,
  creating,
  banner,
  workspaces,
  workspaceID,
  canCreate,
  activeSessionID = null,
  onOpen,
  onNew,
  onSignOut,
  onOpenSettings,
  onSelectWorkspace,
  onAddWorkspace,
  onRemoveWorkspace,
  onDeleteSession,
}: {
  sessions: Session[]
  loading: boolean
  statuses: SessionStatuses
  connected: boolean
  creating: boolean
  banner: string | null
  workspaces: WorkspaceRecord[]
  workspaceID: string | null
  canCreate: boolean
  /** The session currently open in the chat (highlighted with the accent bar). */
  activeSessionID?: string | null
  onOpen: (sessionID: string) => void
  onNew: (isolated: boolean) => void
  onSignOut: () => void
  /** Opens the app-level settings modal (owned by App). */
  onOpenSettings: () => void
  onSelectWorkspace: (id: string) => void
  onAddWorkspace: (input: CreateWorkspaceInput) => Promise<void>
  onRemoveWorkspace: (id: string, options: { deleteFiles: boolean }) => void
  onDeleteSession: (id: string) => void
}) {
  const [workspaceOpen, setWorkspaceOpen] = useState(false)
  const [filter, setFilter] = useState<SessionFilter>("all")
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()
  const workspace = workspaces.find((item) => item.id === workspaceID) ?? null
  // Subagent children are reachable from their parent's card, not the list.
  const visible = filterSessions(rootSessions(sessions), filter)

  const FILTERS: Array<{ value: SessionFilter; label: string }> = [
    { value: "all", label: "All" },
    { value: "isolated", label: "Isolated" },
    { value: "standard", label: "Standard" },
  ]

  function confirmDeleteSession(session: Session): void {
    Alert.alert("Delete session", `Delete "${session.title || "Untitled"}" and all its data?`, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => onDeleteSession(session.id) },
    ])
  }

  function confirmRemoveWorkspace(id: string, options: { deleteFiles: boolean }): void {
    Alert.alert(
      "Remove workspace",
      options.deleteFiles
        ? "The folder and all its files will be deleted. Sessions are kept."
        : "Files and sessions are not deleted.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Remove", style: "destructive", onPress: () => onRemoveWorkspace(id, options) },
      ],
    )
  }

  return (
    <Screen>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.title}>Sessions</Text>
          <NewSessionMenu
            creating={creating}
            disabled={!canCreate}
            onCreate={onNew}
          />
        </View>
        <View style={styles.headerRight}>
          <View style={[styles.dot, { backgroundColor: connected ? colors.success : colors.warning }]} />
        </View>
      </View>

      <View style={styles.filterRow}>
        <View style={styles.filters}>
          {FILTERS.map((option) => (
            <Pressable
              key={option.value}
              onPress={() => setFilter(option.value)}
              style={[styles.chip, filter === option.value && styles.chipActive]}
            >
              <Text style={[styles.chipText, filter === option.value && styles.chipTextActive]}>
                {option.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <Pressable style={styles.workspaceBar} onPress={() => setWorkspaceOpen(true)}>
        <Text style={styles.workspaceLabel}>Workspace</Text>
        <Text style={styles.workspaceName} numberOfLines={1}>
          {workspace ? workspace.name : "Add a workspace"}
        </Text>
        <Text style={styles.chevron}>▾</Text>
      </Pressable>

      {banner ? <Text style={styles.banner}>{banner}</Text> : null}
      {!connected ? <Text style={styles.banner}>Reconnecting to the server…</Text> : null}

      <FlatList
        data={visible}
        keyExtractor={(session) => session.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <View style={styles.empty}>
            {!loading ? <Deco variant="blob" style={styles.emptyBlob} /> : null}
            <Text style={loading ? styles.emptyLoading : styles.emptyTitle}>
              {loading
                ? "Loading…"
                : canCreate
                  ? filter === "all"
                    ? "No sessions yet."
                    : "No sessions match this filter."
                  : "Add a workspace to start working on a project."}
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <SessionRow
            session={item}
            status={statuses[item.id]?.type}
            active={item.id === activeSessionID}
            onPress={onOpen}
            onDelete={confirmDeleteSession}
          />
        )}
      />

      <View style={styles.optionsWrap}>
        <View style={styles.optionsBox}>
          <Pressable
            onPress={onOpenSettings}
            accessibilityRole="button"
            accessibilityLabel="Settings"
            testID="settings-button"
            hitSlop={4}
            style={styles.option}
          >
            <GearIcon size={20} color={colors.textMuted} />
          </Pressable>
          <Pressable
            onPress={onSignOut}
            accessibilityRole="button"
            accessibilityLabel="Sign out"
            hitSlop={4}
            style={styles.option}
          >
            <LogOutIcon size={18} color={colors.textMuted} />
            <Text style={styles.optionText}>Sign out</Text>
          </Pressable>
        </View>
      </View>

      <WorkspaceModal
        visible={workspaceOpen}
        workspaces={workspaces}
        selectedID={workspaceID}
        onSelect={onSelectWorkspace}
        onAdd={onAddWorkspace}
        onRemove={(id, options) => {
          setWorkspaceOpen(false)
          confirmRemoveWorkspace(id, options)
        }}
        onClose={() => setWorkspaceOpen(false)}
      />
    </Screen>
  )
}

function SessionRow({
  session,
  status,
  active,
  onPress,
  onDelete,
}: {
  session: Session
  status: string | undefined
  active: boolean
  onPress: (id: string) => void
  onDelete: (session: Session) => void
}) {
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()

  return (
    <View style={[styles.row, active && styles.rowActive]}>
      <Pressable
        style={[styles.rowMain, active && styles.rowMainActive]}
        onPress={() => onPress(session.id)}
      >
        <View style={styles.rowHeader}>
          <View style={[styles.dot, { backgroundColor: status === "busy" ? colors.warning : colors.hairlineStrong }]} />
          <Text style={styles.rowTitle} numberOfLines={1}>
            {session.title || "Untitled"}
          </Text>
          {session.isolation ? (
            <View style={styles.branchBadge}>
              <Text style={styles.branchText} numberOfLines={1}>
                {session.isolation.branch}
              </Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.rowMeta}>
          {directoryName(session.location.directory)} · {formatRelative(session.time.updated)}
        </Text>
      </Pressable>
      <Pressable
        style={styles.delete}
        onPress={() => onDelete(session)}
        accessibilityLabel="Delete session"
        hitSlop={4}
      >
        <Text style={styles.deleteText}>×</Text>
      </Pressable>
    </View>
  )
}

function createStyles(colors: Palette, fonts: Fonts) {
  return StyleSheet.create({
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 8,
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.hairline,
    },
    headerLeft: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    headerRight: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
    },
    title: {
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 15,
      fontWeight: "600",
    },
    dot: {
      width: 8,
      height: 8,
      borderRadius: 4,
    },
    optionsWrap: {
      alignItems: "flex-start",
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    optionsBox: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      borderRadius: 10,
      backgroundColor: colors.surface,
      padding: 4,
    },
    option: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      minHeight: 40,
      paddingHorizontal: 10,
      justifyContent: "center",
    },
    optionText: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 13,
    },
    workspaceBar: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.hairline,
    },
    workspaceLabel: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 11,
      letterSpacing: 0.8,
      textTransform: "uppercase",
      fontWeight: "600",
    },
    workspaceName: {
      flex: 1,
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 14,
      fontWeight: "600",
    },
    chevron: {
      color: colors.textMuted,
      fontSize: 12,
    },
    banner: {
      color: colors.warning,
      backgroundColor: colors.warningSoft,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.warningLine,
      fontFamily: fonts.ui,
      fontSize: 13,
      paddingHorizontal: 14,
      paddingVertical: 8,
    },
    list: {
      paddingHorizontal: 12,
      paddingTop: 10,
      paddingBottom: 24,
      gap: 8,
    },
    empty: {
      alignItems: "center",
      justifyContent: "center",
      minHeight: 260,
      paddingVertical: 48,
      paddingHorizontal: 24,
      overflow: "hidden",
    },
    emptyBlob: {
      position: "absolute",
      top: -70,
      right: -60,
    },
    emptyTitle: {
      color: colors.text,
      fontFamily: fonts.display,
      fontSize: 26,
      fontWeight: "500",
      lineHeight: 31,
      textAlign: "center",
    },
    emptyLoading: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 14,
      textAlign: "center",
    },
    row: {
      flexDirection: "row",
      alignItems: "stretch",
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      borderRadius: 12,
      backgroundColor: colors.surface,
      overflow: "hidden",
    },
    rowActive: {
      backgroundColor: colors.surfaceMuted,
    },
    rowMain: {
      flex: 1,
      gap: 4,
      borderLeftWidth: 2,
      borderLeftColor: "transparent",
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    rowMainActive: {
      borderLeftColor: colors.accent,
    },
    rowHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    rowTitle: {
      flex: 1,
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 15,
      fontWeight: "600",
    },
    branchBadge: {
      maxWidth: 130,
      backgroundColor: colors.accentSoft,
      borderRadius: 999,
      paddingHorizontal: 8,
      paddingVertical: 2,
    },
    branchText: {
      color: colors.accent,
      fontFamily: fonts.mono,
      fontSize: 10,
    },
    rowMeta: {
      color: colors.textMuted,
      fontFamily: fonts.mono,
      fontSize: 12,
      paddingLeft: 16,
    },
    delete: {
      justifyContent: "center",
      paddingHorizontal: 16,
    },
    deleteText: {
      color: colors.textMuted,
      fontSize: 20,
      lineHeight: 22,
    },
    filterRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.hairline,
    },
    filters: {
      flexDirection: "row",
      gap: 6,
    },
    chip: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      borderRadius: 999,
      paddingHorizontal: 10,
      paddingVertical: 4,
    },
    chipActive: {
      backgroundColor: colors.text,
      borderColor: colors.text,
    },
    chipText: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 12,
    },
    chipTextActive: {
      color: colors.canvas,
      fontWeight: "600",
    },
  })
}
