import { useState } from "react"
import { Pressable, StyleSheet, Text } from "react-native"
import type { CreateWorkspaceInput, WorkspaceRecord } from "@masterhand/client-core"
import { WorkspaceModal } from "./WorkspaceModal"
import { ChevronDownIcon, FolderIcon } from "./icons"
import { useTheme, useThemedStyles, type Fonts, type Palette } from "../theme"

/**
 * Condensed workspace switcher, mirroring the web `WorkspacePicker`: a single
 * minimal trigger (folder glyph + current name + chevron) that opens the
 * management sheet. Replaces the per-screen "WORKSPACE" label bars.
 */
export function WorkspacePicker({
  workspaces,
  workspaceID,
  onSelect,
  onAdd,
  onRemove,
}: {
  workspaces: WorkspaceRecord[]
  workspaceID: string | null
  onSelect: (id: string) => void
  onAdd: (input: CreateWorkspaceInput) => Promise<void>
  onRemove: (id: string, options: { deleteFiles: boolean }) => void
}) {
  const [open, setOpen] = useState(false)
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()
  const workspace = workspaces.find((item) => item.id === workspaceID) ?? null

  return (
    <>
      <Pressable
        style={styles.trigger}
        onPress={() => setOpen(true)}
        hitSlop={{ top: 5, bottom: 5 }}
        accessibilityRole="button"
        accessibilityLabel="Workspace"
        accessibilityValue={{ text: workspace?.name ?? "No workspace" }}
      >
        <FolderIcon size={14} color={colors.textMuted} />
        <Text style={[styles.name, !workspace && styles.nameEmpty]} numberOfLines={1}>
          {workspace?.name ?? "No workspace"}
        </Text>
        <ChevronDownIcon size={14} color={colors.textMuted} />
      </Pressable>

      <WorkspaceModal
        visible={open}
        workspaces={workspaces}
        selectedID={workspaceID}
        onSelect={onSelect}
        onAdd={onAdd}
        onRemove={(id, options) => {
          setOpen(false)
          onRemove(id, options)
        }}
        onClose={() => setOpen(false)}
      />
    </>
  )
}

function createStyles(colors: Palette, fonts: Fonts) {
  return StyleSheet.create({
    trigger: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      flexShrink: 1,
      maxWidth: 224,
      minHeight: 34,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairlineStrong,
      backgroundColor: colors.surface,
      borderRadius: 8,
      paddingHorizontal: 10,
    },
    name: {
      flexShrink: 1,
      color: colors.textSoft,
      fontFamily: fonts.ui,
      fontSize: 13,
      lineHeight: 17,
    },
    nameEmpty: {
      color: colors.textMuted,
    },
  })
}
