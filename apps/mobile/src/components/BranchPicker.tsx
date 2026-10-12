import { useMemo, useState } from "react"
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native"
import { useQueryClient } from "@tanstack/react-query"
import {
  branchErrorMessage,
  isAmbiguousError,
  queryKeys,
  useBranches,
  type Client,
  type GitBranches,
} from "@masterhand/client-core"
import { BranchIcon, CheckIcon, ChevronDownIcon } from "./icons"
import { useTheme, useThemedStyles, type Fonts, type Palette } from "../theme"

/**
 * Branch chip for standard (non-isolated) sessions: shows the workspace's
 * current branch and opens a sheet with search, switch and create-from-current
 * (mobile mirror of the web `BranchPicker`, issue #94). Isolated sessions get
 * the read-only `BranchChip` instead.
 *
 * `create`/`checkout` are non-idempotent: a timeout is surfaced as "may have
 * applied", the list is refetched to reconcile, and the action is never
 * retried automatically (docs/past-mistakes.md rule 4).
 */
export function BranchPicker({ client, workspaceID }: { client: Client; workspaceID: string }) {
  const queryClient = useQueryClient()
  const branchesQuery = useBranches(client, true, workspaceID)
  const info = branchesQuery.data
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()

  const branches = useMemo(() => {
    const needle = search.trim().toLowerCase()
    const list = info?.branches ?? []
    return needle ? list.filter((branch) => branch.toLowerCase().includes(needle)) : list
  }, [info, search])

  async function refresh(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: queryKeys.branches(workspaceID) })
  }

  async function run(action: () => Promise<GitBranches>, describe: (result: GitBranches) => string) {
    if (busy) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await action()
      setNotice(describe(result))
      setName("")
      await refresh()
    } catch (caught) {
      setError(branchErrorMessage(caught))
      // A timeout means the mutation may have applied: reconcile, don't retry.
      if (isAmbiguousError(caught)) await refresh()
    } finally {
      setBusy(false)
    }
  }

  const current = info?.current ?? null

  return (
    <>
      <Pressable
        style={styles.chip}
        onPress={() => setOpen(true)}
        disabled={!info}
        accessibilityRole="button"
        accessibilityLabel="Branch"
        accessibilityState={{ expanded: open }}
      >
        <BranchIcon size={14} color={colors.textMuted} />
        <Text style={styles.chipText} numberOfLines={1}>
          {current ?? "…"}
        </Text>
        <ChevronDownIcon size={14} color={colors.textMuted} />
      </Pressable>

      <Modal visible={open} animationType="slide" transparent onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <Pressable style={styles.sheet} onPress={() => {}}>
            <Text style={styles.title}>Branch</Text>
            <TextInput
              value={search}
              onChangeText={setSearch}
              placeholder="Search branches"
              placeholderTextColor={colors.textFaint}
              autoCorrect={false}
              autoCapitalize="none"
              style={styles.search}
            />
            <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
              {branches.map((branch) => {
                const active = branch === current
                return (
                  <Pressable
                    key={branch}
                    style={[styles.option, active && styles.optionActive]}
                    disabled={busy || active}
                    onPress={() =>
                      void run(() => client.api.branches.checkout(workspaceID, branch), () => `Switched to ${branch}`)
                    }
                    accessibilityRole="button"
                    accessibilityLabel={branch}
                    accessibilityState={{ selected: active }}
                  >
                    <Text style={[styles.optionText, active && styles.optionTextActive]} numberOfLines={1}>
                      {branch}
                    </Text>
                    {active ? <CheckIcon size={14} color={colors.accent} /> : null}
                  </Pressable>
                )
              })}
              {branches.length === 0 ? <Text style={styles.empty}>No matches</Text> : null}
            </ScrollView>

            <View style={styles.createRow}>
              <TextInput
                value={name}
                onChangeText={setName}
                placeholder="new-branch-name"
                placeholderTextColor={colors.textFaint}
                autoCorrect={false}
                autoCapitalize="none"
                style={styles.createInput}
              />
              <Pressable
                style={[styles.createButton, (!name.trim() || busy) && styles.disabled]}
                disabled={!name.trim() || busy}
                onPress={() => {
                  const value = name.trim()
                  if (!value) return
                  void run(() => client.api.branches.create(workspaceID, value), () => `Created and switched to ${value}`)
                }}
              >
                <Text style={styles.createText}>Create</Text>
              </Pressable>
            </View>
            {current ? <Text style={styles.hint}>Creates and switches from {current}</Text> : null}

            {error ? <Text style={styles.error}>{error}</Text> : null}
            {notice ? <Text style={styles.notice}>{notice}</Text> : null}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  )
}

/**
 * Read-only branch chip for isolated sessions: a plain view, never a
 * pressable — the branch cannot be switched and opens no picker.
 */
export function BranchChip({ branch }: { branch: string }) {
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()
  return (
    <View style={styles.chip} accessibilityLabel={`Branch ${branch}`}>
      <BranchIcon size={12} color={colors.textMuted} />
      <Text style={styles.chipText} numberOfLines={1}>
        {branch}
      </Text>
    </View>
  )
}

function createStyles(colors: Palette, fonts: Fonts) {
  return StyleSheet.create({
    chip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      maxWidth: 224,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairlineStrong,
      backgroundColor: colors.surface,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    chipText: {
      flexShrink: 1,
      color: colors.textSoft,
      fontFamily: fonts.mono,
      fontSize: 12,
    },
    backdrop: {
      flex: 1,
      justifyContent: "flex-end",
      backgroundColor: colors.overlay,
    },
    sheet: {
      maxHeight: "70%",
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
    search: {
      marginHorizontal: 16,
      marginBottom: 8,
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
    list: {
      flexGrow: 0,
      maxHeight: 280,
    },
    option: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.hairline,
    },
    optionActive: {
      backgroundColor: colors.surfaceMuted,
    },
    optionText: {
      flex: 1,
      color: colors.textSoft,
      fontFamily: fonts.mono,
      fontSize: 13,
    },
    optionTextActive: {
      color: colors.text,
    },
    empty: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 14,
      paddingHorizontal: 16,
      paddingVertical: 16,
    },
    createRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 16,
      paddingTop: 12,
    },
    createInput: {
      flex: 1,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairlineStrong,
      backgroundColor: colors.surface,
      borderRadius: 12,
      color: colors.text,
      fontFamily: fonts.mono,
      fontSize: 13,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    createButton: {
      backgroundColor: colors.surfaceMuted,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairlineStrong,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    createText: {
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 14,
      fontWeight: "500",
    },
    hint: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 11,
      paddingHorizontal: 16,
      paddingTop: 6,
    },
    error: {
      color: colors.danger,
      fontFamily: fonts.ui,
      fontSize: 12,
      paddingHorizontal: 16,
      paddingTop: 8,
    },
    notice: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 12,
      paddingHorizontal: 16,
      paddingTop: 8,
    },
    disabled: {
      opacity: 0.5,
    },
  })
}
