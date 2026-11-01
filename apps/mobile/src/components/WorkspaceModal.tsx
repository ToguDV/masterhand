import { useEffect, useMemo, useState } from "react"
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from "react-native"
import { ApiError, type CreateWorkspaceInput, type WorkspaceRecord } from "@masterhand/client-core"
import { ChoiceModal } from "./ChoiceModal"
import { useTheme, useThemedStyles, type Fonts, type Palette } from "../theme"

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409) return "That workspace already exists"
    if (error.status === 400) return "Enter a valid folder name (no slashes or leading dots)"
  }
  return "Could not add the workspace"
}

/**
 * Workspace selector and management sheet. The list follows the web model
 * picker: the five most recent workspaces (plus the selected one), a search
 * field when there are more, and a "Show all" action. Add/remove live below
 * the list so the sheet stays minimal.
 */
export function WorkspaceModal({
  visible,
  workspaces,
  selectedID,
  onSelect,
  onAdd,
  onRemove,
  onClose,
}: {
  visible: boolean
  workspaces: WorkspaceRecord[]
  selectedID: string | null
  onSelect: (id: string) => void
  onAdd: (input: CreateWorkspaceInput) => Promise<void>
  onRemove: (id: string, options: { deleteFiles: boolean }) => void
  onClose: () => void
}) {
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState("")
  const [deleteFiles, setDeleteFiles] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()

  useEffect(() => {
    if (visible) return
    setAdding(false)
    setName("")
    setDeleteFiles(false)
    setBusy(false)
    setError(null)
  }, [visible])

  const options = useMemo(
    () =>
      [...workspaces]
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((workspace) => ({ value: workspace.id, label: workspace.name })),
    [workspaces],
  )
  const selected = workspaces.find((workspace) => workspace.id === selectedID) ?? null

  async function submit(): Promise<void> {
    const trimmed = name.trim()
    if (!trimmed || busy) return
    setBusy(true)
    setError(null)
    try {
      await onAdd({ name: trimmed })
      onClose()
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  function remove(): void {
    if (!selectedID) return
    onRemove(selectedID, { deleteFiles })
    onClose()
  }

  const footer = adding ? (
    <View style={styles.form}>
      <Text style={styles.formHint}>A new folder with this name is created inside the workspaces root.</Text>
      <TextInput
        value={name}
        onChangeText={setName}
        placeholder="my-project"
        placeholderTextColor={colors.textFaint}
        autoCorrect={false}
        autoCapitalize="none"
        style={styles.input}
        testID="workspace-name-input"
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.formActions}>
        <Pressable style={styles.secondary} disabled={busy} onPress={() => setAdding(false)}>
          <Text style={styles.secondaryText}>Cancel</Text>
        </Pressable>
        <Pressable
          style={[styles.primary, (!name.trim() || busy) && styles.disabled]}
          disabled={!name.trim() || busy}
          onPress={() => void submit()}
        >
          <Text style={styles.primaryText}>{busy ? "Adding…" : "Add"}</Text>
        </Pressable>
      </View>
    </View>
  ) : (
    <View style={styles.actions}>
      {selected ? (
        <Pressable style={styles.deleteRow} onPress={() => setDeleteFiles((value) => !value)}>
          <Switch
            value={deleteFiles}
            onValueChange={setDeleteFiles}
            trackColor={{ true: colors.accent, false: colors.surfaceMuted }}
            thumbColor={colors.surface}
          />
          <Text style={styles.deleteLabel}>Also delete files from disk</Text>
        </Pressable>
      ) : null}
      <View style={styles.actionRow}>
        {selectedID ? (
          <Pressable style={styles.danger} onPress={remove} accessibilityRole="button">
            <Text style={styles.dangerText}>Remove workspace</Text>
          </Pressable>
        ) : null}
        <Pressable style={styles.primary} onPress={() => setAdding(true)} accessibilityRole="button">
          <Text style={styles.primaryText}>Add workspace</Text>
        </Pressable>
      </View>
    </View>
  )

  return (
    <ChoiceModal
      visible={visible}
      title="Workspaces"
      options={options}
      selected={selectedID ?? ""}
      onSelect={onSelect}
      onClose={onClose}
      previewCount={5}
      emptyLabel="No workspaces yet."
      showAllLabel={`Show all ${workspaces.length}`}
      footer={footer}
    />
  )
}

function createStyles(colors: Palette, fonts: Fonts) {
  return StyleSheet.create({
    form: {
      gap: 8,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.hairline,
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 4,
    },
    formHint: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 12,
    },
    input: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairlineStrong,
      backgroundColor: colors.surface,
      borderRadius: 12,
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 15,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    actions: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.hairline,
      paddingHorizontal: 16,
      paddingTop: 8,
      paddingBottom: 4,
      gap: 4,
    },
    deleteRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      minHeight: 44,
    },
    deleteLabel: {
      color: colors.textSoft,
      fontFamily: fonts.ui,
      fontSize: 13,
    },
    actionRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "flex-end",
      gap: 8,
      paddingBottom: 4,
    },
    formActions: {
      flexDirection: "row",
      justifyContent: "flex-end",
      gap: 8,
      paddingTop: 4,
    },
    primary: {
      backgroundColor: colors.accent,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    primaryText: {
      color: colors.onAccent,
      fontFamily: fonts.ui,
      fontSize: 14,
      fontWeight: "500",
    },
    secondary: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairlineStrong,
      backgroundColor: colors.surface,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    secondaryText: {
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 14,
      fontWeight: "500",
    },
    danger: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.dangerLine,
      backgroundColor: colors.dangerSoft,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 10,
      marginRight: "auto",
    },
    dangerText: {
      color: colors.danger,
      fontFamily: fonts.ui,
      fontSize: 14,
      fontWeight: "500",
    },
    error: {
      color: colors.danger,
      fontFamily: fonts.ui,
      fontSize: 12,
    },
    disabled: {
      opacity: 0.5,
    },
  })
}
