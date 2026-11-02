import { useEffect, useRef, useState } from "react"
import {
  KeyboardAvoidingView,
  Modal,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { ApiError, type CreateWorkspaceInput, type WorkspaceRecord } from "@masterhand/client-core"
import { CheckIcon, CloseIcon } from "./icons"
import { useTheme, useThemedStyles, type Fonts, type Palette } from "../theme"

export type WorkspaceDialogMode = "add" | "remove"

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409) return "That workspace already exists"
    if (error.status === 400) return "Enter a valid folder name (no slashes or leading dots)"
  }
  return "Could not add the workspace"
}

/**
 * Workspace management sheets (web `AddWorkspaceDialog` / `RemoveWorkspaceDialog`
 * parity): the picker menu only lists and switches workspaces; adding and
 * removing stay in the management dialog DESIGN.md reserves for bottom sheets.
 */
export function WorkspaceModal({
  visible,
  mode,
  workspace,
  onAdd,
  onRemove,
  onClose,
}: {
  visible: boolean
  mode: WorkspaceDialogMode
  /** The selected workspace the remove action targets. */
  workspace: WorkspaceRecord | null
  onAdd: (input: CreateWorkspaceInput) => Promise<void>
  onRemove: (id: string, options: { deleteFiles: boolean }) => void
  onClose: () => void
}) {
  const [name, setName] = useState("")
  const [deleteFiles, setDeleteFiles] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Synchronous guard: two taps in the same tick must not fire two DELETEs. */
  const removing = useRef(false)
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()

  useEffect(() => {
    if (visible) return
    setName("")
    setDeleteFiles(false)
    setBusy(false)
    setError(null)
    removing.current = false
  }, [visible])

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
    if (!workspace || removing.current) return
    removing.current = true
    setBusy(true)
    onRemove(workspace.id, { deleteFiles })
    onClose()
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={busy ? () => {} : onClose}
    >
      <KeyboardAvoidingView style={styles.root} behavior="padding">
        <Pressable style={styles.backdrop} onPress={busy ? undefined : onClose}>
          <Pressable
            style={[styles.sheet, { paddingBottom: Math.max(16, insets.bottom + 12) }]}
            onPress={() => {}}
          >
            <View style={styles.head}>
              <Text style={styles.title}>{mode === "add" ? "Add workspace" : "Remove workspace"}</Text>
              <Pressable
                onPress={onClose}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel="Close"
                style={styles.closeButton}
              >
                <CloseIcon size={18} color={colors.textMuted} />
              </Pressable>
            </View>

            {mode === "add" ? (
              <>
                <Text style={styles.body}>
                  A new folder with this name is created inside the workspaces root, isolated from the
                  others.
                </Text>
                <Text style={styles.label}>Name</Text>
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
                <View style={styles.actions}>
                  <Pressable
                    style={[styles.iconPrimary, (!name.trim() || busy) && styles.disabled]}
                    disabled={!name.trim() || busy}
                    onPress={() => void submit()}
                    accessibilityRole="button"
                    accessibilityLabel="Add"
                  >
                    <CheckIcon size={19} color={colors.accent} />
                  </Pressable>
                </View>
              </>
            ) : (
              <>
                <Text style={styles.body}>
                  Remove <Text style={styles.bodyStrong}>{workspace?.name ?? "this workspace"}</Text> from
                  MasterHand. Sessions are kept.
                </Text>
                <Pressable
                  style={styles.deleteRow}
                  onPress={() => setDeleteFiles((value) => !value)}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: deleteFiles }}
                >
                  <Switch
                    testID="workspace-delete-files"
                    value={deleteFiles}
                    onValueChange={setDeleteFiles}
                    trackColor={{ true: colors.accent, false: colors.surfaceMuted }}
                    thumbColor={colors.surface}
                    accessible={false}
                    importantForAccessibility="no"
                  />
                  <Text style={styles.deleteLabel}>
                    Also delete its folder and all files from disk. This cannot be undone.
                  </Text>
                </Pressable>
                <View style={styles.actions}>
                  <Pressable style={styles.secondary} onPress={onClose} accessibilityRole="button">
                    <Text style={styles.secondaryText}>Cancel</Text>
                  </Pressable>
                  <Pressable
                    style={styles.danger}
                    onPress={remove}
                    accessibilityRole="button"
                    accessibilityLabel="Remove"
                  >
                    <Text style={styles.dangerText}>Remove</Text>
                  </Pressable>
                </View>
              </>
            )}
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  )
}

function createStyles(colors: Palette, fonts: Fonts) {
  return StyleSheet.create({
    root: {
      flex: 1,
    },
    backdrop: {
      flex: 1,
      justifyContent: "flex-end",
      backgroundColor: colors.overlay,
    },
    sheet: {
      maxHeight: "85%",
      overflow: "hidden",
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      backgroundColor: colors.surface,
      paddingHorizontal: 18,
      paddingTop: 18,
    },
    head: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    title: {
      flex: 1,
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 17,
      fontWeight: "600",
    },
    closeButton: {
      minHeight: 44,
      minWidth: 44,
      alignItems: "center",
      justifyContent: "center",
      marginRight: -10,
    },
    body: {
      marginTop: 6,
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 13,
      lineHeight: 20,
    },
    bodyStrong: {
      color: colors.text,
      fontWeight: "500",
    },
    label: {
      marginTop: 16,
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 12,
    },
    input: {
      marginTop: 6,
      minHeight: 44,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: "transparent",
      backgroundColor: colors.surfaceMuted,
      borderRadius: 8,
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 15,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    actions: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "flex-end",
      gap: 8,
      marginTop: 18,
      paddingBottom: 4,
    },
    iconPrimary: {
      minHeight: 44,
      minWidth: 44,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.accentSoft,
      borderRadius: 10,
    },
    secondary: {
      minHeight: 44,
      justifyContent: "center",
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairlineStrong,
      borderRadius: 12,
      paddingHorizontal: 16,
    },
    secondaryText: {
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 14,
      fontWeight: "500",
    },
    danger: {
      minHeight: 44,
      justifyContent: "center",
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.dangerLine,
      backgroundColor: colors.dangerSoft,
      borderRadius: 12,
      paddingHorizontal: 16,
    },
    dangerText: {
      color: colors.danger,
      fontFamily: fonts.ui,
      fontSize: 14,
      fontWeight: "500",
    },
    deleteRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      marginTop: 16,
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      backgroundColor: colors.surfaceMuted,
      padding: 12,
    },
    deleteLabel: {
      flexShrink: 1,
      color: colors.textSoft,
      fontFamily: fonts.ui,
      fontSize: 12,
      lineHeight: 17,
    },
    error: {
      marginTop: 8,
      color: colors.danger,
      fontFamily: fonts.ui,
      fontSize: 12,
    },
    disabled: {
      opacity: 0.5,
    },
  })
}
