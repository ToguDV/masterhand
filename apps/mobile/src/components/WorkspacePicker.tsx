import { useMemo, useState } from "react"
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native"
import type { CreateWorkspaceInput, WorkspaceRecord } from "@masterhand/client-core"
import { Popover, usePopover } from "./Popover"
import { WorkspaceModal, type WorkspaceDialogMode } from "./WorkspaceModal"
import { CheckIcon, ChevronDownIcon, FolderIcon } from "./icons"
import { useTheme, useThemedStyles, type Fonts, type Palette } from "../theme"

/** How many recent workspaces the closed menu previews (web parity). */
const PREVIEW_COUNT = 5

/**
 * Condensed workspace switcher, mirroring the web `WorkspacePicker`: one
 * trigger showing the current workspace and an anchored menu with the five
 * most recent workspaces (plus the selected one), a search field when there
 * are more, a "Show all" action and the add/remove management actions. The
 * management dialogs stay bottom sheets (DESIGN.md) and open from the menu's
 * footer, not from the picker itself.
 */
export function WorkspacePicker({
  workspaces,
  workspaceID,
  onSelect,
  onAdd,
  onRemove,
  placement = "down",
}: {
  workspaces: WorkspaceRecord[]
  workspaceID: string | null
  onSelect: (id: string) => void
  onAdd: (input: CreateWorkspaceInput) => Promise<void>
  onRemove: (id: string, options: { deleteFiles: boolean }) => void
  placement?: "up" | "down"
}) {
  const [query, setQuery] = useState("")
  const [expanded, setExpanded] = useState(false)
  const [dialog, setDialog] = useState<WorkspaceDialogMode | null>(null)
  const popover = usePopover()
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()

  const recent = useMemo(
    () => [...workspaces].sort((a, b) => b.createdAt - a.createdAt),
    [workspaces],
  )
  const selected = recent.find((workspace) => workspace.id === workspaceID) ?? null
  const searchable = recent.length > PREVIEW_COUNT
  const term = query.trim().toLowerCase()
  const filtered = term
    ? recent.filter(
        (workspace) =>
          workspace.name.toLowerCase().includes(term) || workspace.path.toLowerCase().includes(term),
      )
    : recent
  const pinned =
    !term && selected
      ? [selected, ...filtered.filter((workspace) => workspace.id !== selected.id)]
      : filtered
  const truncated = searchable && !expanded && !term
  const visible = truncated ? pinned.slice(0, PREVIEW_COUNT) : filtered

  function close(): void {
    popover.hide()
    setQuery("")
    setExpanded(false)
  }

  // Presenting one native modal while another is still dismissing can race on
  // iOS; let the menu detach first, then open the management sheet.
  function openDialog(mode: WorkspaceDialogMode): void {
    close()
    setTimeout(() => setDialog(mode), 0)
  }

  return (
    <>
      <Pressable
        ref={popover.triggerRef}
        onPress={popover.toggle}
        onPressIn={popover.measure}
        onLayout={popover.measure}
        hitSlop={6}
        style={({ pressed }) => [styles.trigger, pressed && styles.triggerPressed]}
        accessibilityRole="button"
        accessibilityLabel="Workspace"
        accessibilityValue={{ text: selected?.name ?? "No workspace" }}
        accessibilityHint={selected?.path}
        accessibilityState={{ expanded: popover.open }}
      >
        <FolderIcon size={16} color={colors.textMuted} />
        <Text style={[styles.name, selected ? styles.nameSelected : styles.nameEmpty]} numberOfLines={1}>
          {selected?.name ?? "No workspace"}
        </Text>
        <ChevronDownIcon size={14} color={colors.textMuted} />
      </Pressable>

      <Popover open={popover.open} anchor={popover.anchor} placement={placement} onClose={close}>
        {searchable ? (
          <TextInput
            value={query}
            onChangeText={setQuery}
            onSubmitEditing={() => {
              const first = visible[0]
              if (!first) return
              onSelect(first.id)
              close()
            }}
            placeholder="Search…"
            placeholderTextColor={colors.textFaint}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            accessibilityLabel="Search workspace"
            style={styles.search}
          />
        ) : null}

        <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
          {visible.length === 0 ? (
            <Text style={styles.empty}>
              {workspaces.length === 0 ? "No workspaces yet." : "No matches"}
            </Text>
          ) : null}
          {visible.map((workspace) => (
            <Pressable
              key={workspace.id}
              testID={`workspace-option-${workspace.id}`}
              onPress={() => {
                onSelect(workspace.id)
                close()
              }}
              style={({ pressed }) => [styles.option, pressed && styles.optionPressed]}
              accessibilityRole="menuitem"
              accessibilityState={{ selected: workspace.id === workspaceID }}
              accessibilityHint={workspace.path}
            >
              <Text
                style={[styles.optionText, workspace.id === workspaceID && styles.optionTextSelected]}
                numberOfLines={1}
              >
                {workspace.name}
              </Text>
              {workspace.id === workspaceID ? <CheckIcon size={14} color={colors.accent} /> : null}
            </Pressable>
          ))}
          {truncated ? (
            <Pressable
              onPress={() => setExpanded(true)}
              style={styles.showAll}
              hitSlop={{ top: 6, bottom: 6 }}
              accessibilityRole="button"
              accessibilityLabel={`Show all ${recent.length}`}
            >
              <Text style={styles.showAllText}>Show all {recent.length}</Text>
            </Pressable>
          ) : null}
        </ScrollView>

        <View style={styles.divider} />
        <Pressable
          onPress={() => openDialog("add")}
          style={({ pressed }) => [styles.action, pressed && styles.optionPressed]}
          hitSlop={{ top: 6, bottom: 6 }}
          accessibilityRole="menuitem"
        >
          <Text style={styles.actionText}>Add workspace</Text>
        </Pressable>
        {selected ? (
          <Pressable
            onPress={() => openDialog("remove")}
            style={({ pressed }) => [styles.action, pressed && styles.optionPressed]}
            hitSlop={{ top: 6, bottom: 6 }}
            accessibilityRole="menuitem"
          >
            <Text style={styles.actionDanger}>Remove workspace</Text>
          </Pressable>
        ) : null}
      </Popover>

      <WorkspaceModal
        visible={dialog !== null}
        mode={dialog ?? "add"}
        workspace={selected}
        onAdd={onAdd}
        onRemove={onRemove}
        onClose={() => setDialog(null)}
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
      maxWidth: 256,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairlineStrong,
      backgroundColor: colors.surface,
      borderRadius: 6,
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    triggerPressed: {
      backgroundColor: colors.surfaceMuted,
    },
    name: {
      flexShrink: 1,
      fontFamily: fonts.ui,
      fontSize: 14,
    },
    nameSelected: {
      color: colors.text,
    },
    nameEmpty: {
      color: colors.textMuted,
    },
    search: {
      marginBottom: 8,
      minHeight: 32,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairlineStrong,
      borderRadius: 4,
      backgroundColor: colors.surface,
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 12,
      paddingHorizontal: 8,
      paddingVertical: 6,
    },
    list: {
      maxHeight: 240,
      flexShrink: 1,
    },
    option: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      minHeight: 32,
      borderRadius: 4,
      paddingHorizontal: 8,
      paddingVertical: 6,
    },
    optionPressed: {
      backgroundColor: colors.surfaceMuted,
    },
    optionText: {
      flex: 1,
      color: colors.textSoft,
      fontFamily: fonts.ui,
      fontSize: 12,
    },
    optionTextSelected: {
      color: colors.accent,
    },
    empty: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 12,
      paddingHorizontal: 8,
      paddingVertical: 12,
    },
    showAll: {
      marginTop: 4,
      minHeight: 32,
      justifyContent: "center",
      borderRadius: 4,
      paddingHorizontal: 8,
      paddingVertical: 6,
    },
    showAllText: {
      color: colors.accent,
      fontFamily: fonts.ui,
      fontSize: 12,
    },
    divider: {
      height: StyleSheet.hairlineWidth,
      marginVertical: 4,
      backgroundColor: colors.hairline,
    },
    action: {
      minHeight: 32,
      justifyContent: "center",
      borderRadius: 4,
      paddingHorizontal: 8,
      paddingVertical: 6,
    },
    actionText: {
      color: colors.textSoft,
      fontFamily: fonts.ui,
      fontSize: 12,
    },
    actionDanger: {
      color: colors.danger,
      fontFamily: fonts.ui,
      fontSize: 12,
    },
  })
}
