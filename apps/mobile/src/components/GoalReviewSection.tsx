import { useEffect, useRef, useState } from "react"
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native"
import { useQueryClient } from "@tanstack/react-query"
import {
  flattenModels,
  goalErrorMessage,
  queryKeys,
  useGoalSettings,
  useModels,
  type Client,
} from "@masterhand/client-core"
import { ChoiceModal, type ChoiceOption } from "./ChoiceModal"
import { ChevronDownIcon } from "./icons"
import { useTheme, useThemedStyles, type Fonts, type Palette } from "../theme"

/**
 * Settings > Goal review (issue #130): which models run the adversarial critic
 * and the impartial judge (empty = the session model) and the round budget
 * before a run pauses for a user decision. Persisted through the BFF. Every
 * change saves automatically, like the other settings sections — there is no
 * Save button.
 */
export function GoalReviewSection({ client }: { client: Client }) {
  const queryClient = useQueryClient()
  const settings = useGoalSettings(client)
  const models = useModels(client)
  const [criticModel, setCriticModel] = useState("")
  const [judgeModel, setJudgeModel] = useState("")
  const [maxRounds, setMaxRounds] = useState("5")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [picker, setPicker] = useState<"critic" | "judge" | null>(null)
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()
  // A refetch that resolves after the user started editing must not clobber
  // the form (rule 3: never overwrite edits made while a request was in flight).
  const [dirty, setDirty] = useState(false)
  /** Bumped on every edit so a save that lands late can tell it is stale. */
  const editVersion = useRef(0)
  const savingRef = useRef(false)
  /**
   * Version of the last failed save: a failed autosave must not retry on
   * every refetch — only a newer user edit (which bumps `editVersion`)
   * schedules another attempt.
   */
  const failedVersion = useRef(-1)

  useEffect(() => {
    if (!settings.data || dirty) return
    setCriticModel(settings.data.criticModel ?? "")
    setJudgeModel(settings.data.judgeModel ?? "")
    setMaxRounds(String(settings.data.maxRounds))
  }, [settings.data, dirty])

  // Autosave: every edit persists after a short debounce, like the other
  // settings sections. The settings write is idempotent, so a save that lands
  // late is reconciled by refetching instead of retrying blindly (rule 4).
  useEffect(() => {
    if (!settings.data || !dirty || saving) return
    const rounds = Number.parseInt(maxRounds, 10)
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > 50) {
      setError("Max rounds must be a whole number between 1 and 50.")
      return
    }
    // Already in sync with the server (e.g. a refetch confirmed the write):
    // nothing to save, and any earlier error is stale.
    if (
      (settings.data.criticModel ?? "") === criticModel &&
      (settings.data.judgeModel ?? "") === judgeModel &&
      settings.data.maxRounds === rounds
    ) {
      setDirty(false)
      setError(null)
      failedVersion.current = -1
      return
    }
    if (editVersion.current === failedVersion.current) return
    const version = editVersion.current
    const snapshot = {
      maxRounds: rounds,
      criticModel: criticModel || null,
      judgeModel: judgeModel || null,
    }
    const timer = setTimeout(() => {
      void (async () => {
        if (savingRef.current) return
        savingRef.current = true
        setSaving(true)
        setError(null)
        try {
          await client.api.goal.saveSettings(snapshot)
          await queryClient.invalidateQueries({ queryKey: queryKeys.goalSettings })
          // Only clear the dirty flag when nothing changed while the save was
          // in flight; otherwise the newer edits stay and save again.
          if (editVersion.current === version) setDirty(false)
          failedVersion.current = -1
        } catch (saveError) {
          setError(goalErrorMessage(saveError))
          failedVersion.current = version
          // A lost response may still have landed (rule 4): reconcile instead
          // of retrying. The write is idempotent, so refetching is safe.
          await queryClient.invalidateQueries({ queryKey: queryKeys.goalSettings })
        } finally {
          savingRef.current = false
          setSaving(false)
        }
      })()
    }, 500)
    return () => clearTimeout(timer)
  }, [settings.data, dirty, saving, criticModel, judgeModel, maxRounds, queryClient, client])

  const modelOptions: ChoiceOption[] = [
    { value: "", label: "Use the session model" },
    ...flattenModels(models.data?.models ?? [], models.data?.providers ?? []).map((option) => ({
      value: option.value,
      label: option.label,
    })),
  ]

  function optionLabel(value: string): string {
    return modelOptions.find((option) => option.value === value)?.label ?? (value || "Use the session model")
  }

  return (
    <View accessibilityLabel="Goal review">
      <Text style={styles.sectionTitle}>Goal review</Text>
      <Text style={styles.hint}>
        A goal run is challenged by an adversarial critic and decided by an impartial judge. Leave a model empty to
        use the session&apos;s own model. Changes save automatically.
      </Text>

      {settings.isLoading ? <Text style={styles.hint}>Loading goal settings…</Text> : null}
      {settings.error ? <Text style={styles.error}>Could not load the goal settings.</Text> : null}

      <Text style={styles.groupLabel}>Models</Text>
      <View style={styles.card}>
        <Text style={[styles.label, styles.labelFirst]}>Critic model</Text>
        <Pressable
          onPress={() => setPicker("critic")}
          accessibilityRole="button"
          accessibilityLabel="Critic model"
          style={styles.select}
        >
          <Text style={[styles.selectText, !criticModel && styles.selectPlaceholder]} numberOfLines={1}>
            {optionLabel(criticModel)}
          </Text>
          <ChevronDownIcon size={14} color={colors.textMuted} />
        </Pressable>

        <Text style={styles.label}>Judge model</Text>
        <Pressable
          onPress={() => setPicker("judge")}
          accessibilityRole="button"
          accessibilityLabel="Judge model"
          style={styles.select}
        >
          <Text style={[styles.selectText, !judgeModel && styles.selectPlaceholder]} numberOfLines={1}>
            {optionLabel(judgeModel)}
          </Text>
          <ChevronDownIcon size={14} color={colors.textMuted} />
        </Pressable>
        <Text style={styles.cardHint}>Empty = the session model.</Text>
      </View>

      <Text style={styles.groupLabel}>Budget</Text>
      <View style={styles.card}>
        <Text style={[styles.label, styles.labelFirst]}>Max rounds</Text>
        <TextInput
          value={maxRounds}
          onChangeText={(value) => {
            setMaxRounds(value)
            setDirty(true)
            editVersion.current += 1
          }}
          keyboardType="numeric"
          accessibilityLabel="Max rounds before pausing"
          style={styles.input}
          testID="goal-max-rounds"
        />
        <Text style={styles.cardHint}>Pauses for a decision after this many rounds (1–50).</Text>
      </View>

      {saving ? <Text style={styles.hint}>Saving…</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}

      <ChoiceModal
        visible={picker === "critic"}
        title="Critic model"
        options={modelOptions}
        selected={criticModel}
        onSelect={(value) => {
          setCriticModel(value)
          setDirty(true)
          editVersion.current += 1
        }}
        onClose={() => setPicker(null)}
      />
      <ChoiceModal
        visible={picker === "judge"}
        title="Judge model"
        options={modelOptions}
        selected={judgeModel}
        onSelect={(value) => {
          setJudgeModel(value)
          setDirty(true)
          editVersion.current += 1
        }}
        onClose={() => setPicker(null)}
      />
    </View>
  )
}

function createStyles(colors: Palette, fonts: Fonts) {
  return StyleSheet.create({
    sectionTitle: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 11,
      letterSpacing: 0.8,
      textTransform: "uppercase",
      fontWeight: "600",
    },
    hint: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 12,
      marginTop: 8,
    },
    cardHint: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 11,
      marginTop: 8,
    },
    groupLabel: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 11,
      letterSpacing: 0.6,
      textTransform: "uppercase",
      fontWeight: "600",
      marginTop: 14,
    },
    card: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      borderRadius: 12,
      backgroundColor: colors.surface,
      padding: 12,
      marginTop: 8,
    },
    label: {
      marginTop: 12,
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 12,
    },
    labelFirst: {
      marginTop: 2,
    },
    select: {
      minHeight: 44,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairlineStrong,
      backgroundColor: colors.surface,
      borderRadius: 12,
      paddingHorizontal: 12,
      marginTop: 6,
    },
    selectText: {
      flex: 1,
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 14,
    },
    selectPlaceholder: {
      color: colors.textMuted,
    },
    input: {
      minHeight: 44,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairlineStrong,
      backgroundColor: colors.surface,
      borderRadius: 12,
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: 14,
      paddingHorizontal: 12,
      marginTop: 6,
    },
    error: {
      flexShrink: 1,
      color: colors.danger,
      fontFamily: fonts.ui,
      fontSize: 12,
    },
  })
}
