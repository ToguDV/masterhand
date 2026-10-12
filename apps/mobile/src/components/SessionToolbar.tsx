import { useState, type ReactNode } from "react"
import { Pressable, StyleSheet, Text, View } from "react-native"
import type { CreateWorkspaceInput, WorkspaceRecord } from "@masterhand/client-core"
import { WorkspaceModal } from "./WorkspaceModal"
import { ChevronDownIcon, FolderIcon } from "./icons"
import { useTheme, useThemedStyles, type Fonts, type Palette } from "../theme"

/**
 * The composer's top bar: the workspace menu, an optional branch control and
 * an optional trailing slot (the session stats), mirroring the web
 * `SessionToolbar`. Rendered as the head of the composer dock card.
 */
export function SessionToolbar({
  workspaces,
  workspaceID,
  onSelectWorkspace,
  onAddWorkspace,
  onRemoveWorkspace,
  branch,
  trailing,
}: {
  workspaces: WorkspaceRecord[]
  workspaceID: string | null
  onSelectWorkspace: (id: string) => void
  onAddWorkspace: (input: CreateWorkspaceInput) => Promise<void>
  onRemoveWorkspace: (id: string, options: { deleteFiles: boolean }) => void
  /** Branch picker (standard sessions) or read-only chip (isolated sessions). */
  branch?: ReactNode
  trailing?: ReactNode
}) {
  const [workspaceOpen, setWorkspaceOpen] = useState(false)
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()
  const workspace = workspaces.find((item) => item.id === workspaceID) ?? null

  return (
    <View style={styles.row}>
      <Pressable
        style={styles.workspaceTrigger}
        onPress={() => setWorkspaceOpen(true)}
        accessibilityRole="button"
        accessibilityLabel="Workspace"
      >
        <FolderIcon size={14} color={colors.textMuted} />
        <Text style={styles.workspaceName} numberOfLines={1}>
          {workspace?.name ?? "No workspace"}
        </Text>
        <ChevronDownIcon size={14} color={colors.textMuted} />
      </Pressable>
      {branch}
      {trailing ? <View style={styles.trailing}>{trailing}</View> : null}

      <WorkspaceModal
        visible={workspaceOpen}
        workspaces={workspaces}
        selectedID={workspaceID}
        onSelect={(id) => onSelectWorkspace(id)}
        onAdd={async (input) => {
          await onAddWorkspace(input)
        }}
        onRemove={(id, options) => {
          setWorkspaceOpen(false)
          onRemoveWorkspace(id, options)
        }}
        onClose={() => setWorkspaceOpen(false)}
      />
    </View>
  )
}

function createStyles(colors: Palette, fonts: Fonts) {
  return StyleSheet.create({
    row: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      gap: 8,
    },
    workspaceTrigger: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      maxWidth: "100%",
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairlineStrong,
      backgroundColor: colors.surface,
      borderRadius: 999,
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    workspaceName: {
      flexShrink: 1,
      color: colors.textSoft,
      fontFamily: fonts.ui,
      fontSize: 12,
    },
    trailing: {
      flex: 1,
      flexBasis: "100%",
      alignItems: "flex-end",
    },
  })
}
