import { useEffect, useState } from "react"
import { Modal, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native"
import { ApiError, type CreateWorkspaceInput, type WorkspaceRecord } from "@masterhand/client-core"
import { Deco } from "./Deco"
import { useTheme, useThemedStyles, type Fonts, type Palette } from "../theme"

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409) return "That workspace already exists"
    if (error.status === 400) return "Enter a valid folder name (no slashes or leading dots)"
  }
  return "Could not add the workspace"
}

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

  async function submit(): Promise<void> {
    const trimmed = name.trim()
    if (!trimmed || busy) return
    setBusy(true)
    setError(null)
    try {
      await onAdd({ name: trimmed })
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  const selected = workspaces.find((workspace) => workspace.id === selectedID) ?? null

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <Text style={styles.title}>Workspaces</Text>

          <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
            {workspaces.length === 0 && (
              <View style={styles.emptyWrap}>
                <Deco variant="hatch" style={styles.emptyDeco} />
                <Text style={styles.empty}>No workspaces yet.</Text>
              </View>
            )}
            {workspaces.map((workspace) => (
              <Pressable
                key={workspace.id}
                style={[styles.option, workspace.id === selectedID && styles.optionSelected]}
                onPress={() => {
                  onSelect(workspace.id)
                  onClose()
                }}
              >
                <Text style={[styles.optionText, workspace.id === selectedID && styles.optionTextSelected]}>
                  {workspace.name}
                </Text>
                <Text style={styles.optionMeta} numberOfLines={1}>
                  {workspace.path}
                </Text>
              </Pressable>
            ))}
          </ScrollView>

          {adding ? (
            <View style={styles.form}>
              <Text style={styles.formHint}>
                A new folder with this name is created inside the workspaces root.
              </Text>
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
            <View style={styles.form}>
              {selected ? (
                <Pressable style={styles.checkRow} onPress={() => setDeleteFiles((value) => !value)}>
                  <Switch
                    value={deleteFiles}
                    onValueChange={setDeleteFiles}
                    trackColor={{ true: colors.accent, false: colors.surfaceMuted }}
                    thumbColor={colors.surface}
                  />
                  <Text style={styles.checkLabel}>Also delete files from disk</Text>
                </Pressable>
              ) : null}
              <View style={styles.formActions}>
                {selectedID ? (
                  <Pressable
                    style={styles.danger}
                    onPress={() => onRemove(selectedID, { deleteFiles })}
                  >
                    <Text style={styles.dangerText}>Remove workspace</Text>
                  </Pressable>
                ) : null}
                <Pressable style={styles.primary} onPress={() => setAdding(true)}>
                  <Text style={styles.primaryText}>Add workspace</Text>
                </Pressable>
              </View>
            </View>
          )}

          {selected && !adding ? (
            <Text style={styles.hint} numberOfLines={1}>
              {selected.path}
            </Text>
          ) : null}
        </Pressable>
      </Pressable>
    </Modal>
  )
}

function createStyles(colors: Palette, fonts: Fonts) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      justifyContent: "flex-end",
      backgroundColor: colors.overlay,
    },
    sheet: {
      maxHeight: "80%",
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      backgroundColor: colors.surface,
      paddingBottom: 24,
    },
    title: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 11,
      fontWeight: "600",
      letterSpacing: 0.8,
      textTransform: "uppercase",
      paddingHorizontal: 16,
      paddingTop: 16,
      paddingBottom: 8,
    },
    list: {
      flexGrow: 0,
    },
    option: {
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.hairline,
      gap: 2,
    },
    optionSelected: {
      backgroundColor: colors.surfaceMuted,
    },
    optionText: {
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 15,
    },
    optionTextSelected: {
      color: colors.accent,
      fontWeight: "600",
    },
    optionMeta: {
      color: colors.textMuted,
      fontFamily: fonts.mono,
      fontSize: 12,
    },
    emptyWrap: {
      alignItems: "center",
      justifyContent: "center",
      paddingVertical: 32,
      paddingHorizontal: 16,
      overflow: "hidden",
    },
    emptyDeco: {
      position: "absolute",
      top: -6,
      right: -30,
    },
    empty: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 14,
    },
    form: {
      gap: 8,
      paddingHorizontal: 16,
      paddingTop: 12,
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
    checkRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
    },
    checkLabel: {
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 14,
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
    hint: {
      color: colors.textMuted,
      fontFamily: fonts.mono,
      fontSize: 12,
      paddingHorizontal: 16,
      paddingTop: 8,
    },
    disabled: {
      opacity: 0.5,
    },
  })
}
