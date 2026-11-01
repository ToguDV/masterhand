import type { ReactNode } from "react"
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from "react-native"
// The section slot scrolls through the gesture-handler ScrollView so a card
// drag (long-press pan, #164) negotiates with scrolling instead of fighting
// it; the stock ScrollView would scroll and drag at once on device.
import { ScrollView } from "react-native-gesture-handler"
import {
  directoryName,
  formatRelative,
  rootSessions,
  type CreateWorkspaceInput,
  type Session,
  type SessionStatuses,
  type WorkspaceRecord,
} from "@masterhand/client-core"
import { Screen } from "../components/Screen"
import { BottomNav, type HomeSection } from "../components/BottomNav"
import { NewSessionMenu } from "../components/NewSessionMenu"
import { WorkspacePicker } from "../components/WorkspacePicker"
import { Deco } from "../components/Deco"
import { useTheme, useThemedStyles, type Fonts, type Palette } from "../theme"

export type { HomeSection }

const SECTION_TITLES: Record<HomeSection, string> = {
  sessions: "Sessions",
  board: "Board",
  scheduler: "Scheduler",
}

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
  onOpenSettings,
  serverSwitcher = null,
  onSelectWorkspace,
  onAddWorkspace,
  onRemoveWorkspace,
  onDeleteSession,
  section = "sessions",
  onSelectSection = () => {},
  board = null,
  scheduler = null,
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
  onNew: () => void
  /** Opens the app-level settings modal (owned by App). */
  onOpenSettings: () => void
  /** Server chip + switcher sheet rendered in the header (owned by App). */
  serverSwitcher?: ReactNode
  onSelectWorkspace: (id: string) => void
  onAddWorkspace: (input: CreateWorkspaceInput) => Promise<void>
  onRemoveWorkspace: (id: string, options: { deleteFiles: boolean }) => void
  onDeleteSession: (id: string) => void
  /** Active home section; the bottom nav shows Board/Scheduler when their slots are provided. */
  section?: HomeSection
  onSelectSection?: (section: HomeSection) => void
  /** Kanban board rendered in place of the session list. */
  board?: ReactNode
  /** Scheduler task manager rendered in place of the session list. */
  scheduler?: ReactNode
}) {
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()
  // Subagent children are reachable from their parent's card, not the list.
  const visible = rootSessions(sessions)

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
          <Text style={styles.title} testID="screen-title">
            {SECTION_TITLES[section]}
          </Text>
          {section === "sessions" ? (
            <NewSessionMenu
              creating={creating}
              disabled={!canCreate}
              onCreate={onNew}
            />
          ) : null}
        </View>
        <View style={styles.headerRight}>
          {serverSwitcher}
          <View style={[styles.dot, { backgroundColor: connected ? colors.success : colors.warning }]} />
        </View>
      </View>

      {section === "board" && board ? (
        <ScrollView contentContainerStyle={styles.list} keyboardShouldPersistTaps="handled">
          {board}
        </ScrollView>
      ) : section === "scheduler" && scheduler ? (
        <ScrollView contentContainerStyle={styles.list} keyboardShouldPersistTaps="handled">
          {scheduler}
        </ScrollView>
      ) : (
      <>
      <View style={styles.workspaceBar}>
        <WorkspacePicker
          workspaces={workspaces}
          workspaceID={workspaceID}
          onSelect={onSelectWorkspace}
          onAdd={onAddWorkspace}
          onRemove={confirmRemoveWorkspace}
        />
      </View>

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
                  ? "No sessions yet."
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
      </>
      )}

      <BottomNav
        section={section}
        onSelectSection={onSelectSection}
        onOpenSettings={onOpenSettings}
        showBoard={Boolean(board)}
        showScheduler={Boolean(scheduler)}
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
    workspaceBar: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.hairline,
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
  })
}
