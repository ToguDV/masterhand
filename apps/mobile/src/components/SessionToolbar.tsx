import type { ReactNode } from "react"
import { StyleSheet, View } from "react-native"
import type { CreateWorkspaceInput, WorkspaceRecord } from "@masterhand/client-core"
import { WorkspacePicker } from "./WorkspacePicker"
import { useThemedStyles } from "../theme"

/**
 * The composer's top bar: the workspace menu, an optional branch viewer and
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
  /** Read-only branch viewer. */
  branch?: ReactNode
  trailing?: ReactNode
}) {
  const styles = useThemedStyles(createStyles)

  return (
    <View style={styles.row}>
      <View style={styles.workspace}>
        <WorkspacePicker
          workspaces={workspaces}
          workspaceID={workspaceID}
          onSelect={onSelectWorkspace}
          onAdd={onAddWorkspace}
          onRemove={onRemoveWorkspace}
        />
      </View>
      {branch ? <View style={styles.branch}>{branch}</View> : null}
      {trailing ? <View style={styles.trailing}>{trailing}</View> : null}
    </View>
  )
}

function createStyles() {
  return StyleSheet.create({
    /** Chips never wrap: they shrink in place, stats drop to their own line. */
    row: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      columnGap: 8,
      rowGap: 6,
    },
    workspace: {
      flexShrink: 1,
      maxWidth: "60%",
    },
    /** Fills the leftover width so a long branch truncates only when needed. */
    branch: {
      flexGrow: 1,
      flexShrink: 1,
      flexBasis: 0,
      minWidth: 0,
      alignItems: "flex-start",
    },
    trailing: {
      flexBasis: "100%",
      alignItems: "flex-start",
    },
  })
}
