import { useEffect, useState } from "react"
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
 * before a run pauses for a user decision. Persisted through the BFF.
 */
export function GoalReviewSection({ client }: { client: Client }) {
  const queryClient = useQueryClient()
  const settings = useGoalSettings(client)
  const models = useModels(client)
  const [criticModel, setCriticModel] = useState("")
  const [judgeModel, setJudgeModel] = useState("")
  const [maxRounds, setMaxRounds] = useState("5")
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [picker, setPicker] = useState<"critic" | "judge" | null>(null)
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()
  // A refetch that resolves after the user started editing must not clobber
  // the form (rule 3: never overwrite edits made while a request was in flight).
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    if (!settings.data || dirty) return
    setCriticModel(settings.data.criticModel ?? "")
    setJudgeModel(settings.data.judgeModel ?? "")
    setMaxRounds(String(settings.data.maxRounds))
  }, [settings.data, dirty])

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

  async function save(): Promise<void> {
    if (saving) return
    const rounds = Number.parseInt(maxRounds, 10)
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > 50) {
      setError("Max rounds must be a whole number between 1 and 50.")
      return
    }
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      await client.api.goal.saveSettings({
        maxRounds: rounds,
        criticModel: criticModel || null,
        judgeModel: judgeModel || null,
      })
      await queryClient.invalidateQueries({ queryKey: queryKeys.goalSettings })
      setDirty(false)
      setNotice("Saved.")
    } catch (saveError) {
      setError(goalErrorMessage(saveError))
    } finally {
      setSaving(false)
    }
  }

  return (
    <View accessibilityLabel="Goal review">
      <Text style={styles.sectionTitle}>Goal review</Text>
      <Text style={styles.hint}>
        A goal run is challenged by an adversarial critic and decided by an impartial judge. Leave a model empty
        to use the session&apos;s own model.
      </Text>

      <Text style={styles.label}>Critic model</Text>
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

      <Text style={styles.label}>Max rounds</Text>
      <TextInput
        value={maxRounds}
        onChangeText={(value) => {
          setMaxRounds(value)
          setDirty(true)
        }}
        keyboardType="numeric"
        accessibilityLabel="Max rounds before pausing"
        style={styles.input}
        testID="goal-max-rounds"
      />

      <View style={styles.actions}>
        <Pressable
          onPress={() => void save()}
          disabled={saving}
          accessibilityRole="button"
          accessibilityLabel="Save"
          style={[styles.primary, saving && styles.disabled]}
        >
          <Text style={styles.primaryText}>{saving ? "Saving…" : "Save"}</Text>
        </Pressable>
        {notice ? <Text style={styles.notice}>{notice}</Text> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>

      <ChoiceModal
        visible={picker === "critic"}
        title="Critic model"
        options={modelOptions}
        selected={criticModel}
        onSelect={(value) => {
          setCriticModel(value)
          setDirty(true)
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
    label: {
      marginTop: 12,
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 12,
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
    actions: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      marginTop: 14,
    },
    primary: {
      minHeight: 44,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.accent,
      borderRadius: 12,
      paddingHorizontal: 16,
    },
    disabled: {
      opacity: 0.5,
    },
    primaryText: {
      color: colors.onAccent,
      fontFamily: fonts.ui,
      fontSize: 14,
      fontWeight: "500",
    },
    notice: {
      color: colors.textMuted,
      fontFamily: fonts.ui,
      fontSize: 12,
    },
    error: {
      flexShrink: 1,
      color: colors.danger,
      fontFamily: fonts.ui,
      fontSize: 12,
    },
  })
}
