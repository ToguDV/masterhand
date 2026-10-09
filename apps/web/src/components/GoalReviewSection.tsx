import { useEffect, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  flattenModels,
  goalErrorMessage,
  queryKeys,
  useGoalSettings,
  useModels,
} from "@masterhand/client-core"
import { client } from "../client"
import { SearchSelect } from "./SearchSelect"

/**
 * Settings > Goal review: which models run the adversarial critic and the
 * impartial judge (empty = the session model) and the round budget before a
 * run pauses for a user decision. Persisted through the BFF.
 */
export function GoalReviewSection() {
  const queryClient = useQueryClient()
  const settings = useGoalSettings(client)
  const models = useModels(client)
  const [criticModel, setCriticModel] = useState("")
  const [judgeModel, setJudgeModel] = useState("")
  const [maxRounds, setMaxRounds] = useState("5")
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // A refetch that resolves after the user started editing must not clobber
  // the form (rule 3: never overwrite edits made while a request was in flight).
  const [dirty, setDirty] = useState(false)
  /** Bumped on every edit so a save that lands late can tell it is stale. */
  const editVersion = useRef(0)
  const savingRef = useRef(false)

  useEffect(() => {
    if (!settings.data || dirty) return
    setCriticModel(settings.data.criticModel ?? "")
    setJudgeModel(settings.data.judgeModel ?? "")
    setMaxRounds(String(settings.data.maxRounds))
  }, [settings.data, dirty])

  const modelOptions = [
    { value: "", label: "Use the session model" },
    ...flattenModels(models.data?.models ?? [], models.data?.providers ?? []).map((option) => ({
      value: option.value,
      label: option.label,
    })),
  ]

  async function save(): Promise<void> {
    if (savingRef.current) return
    const rounds = Number.parseInt(maxRounds, 10)
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > 50) {
      setError("Max rounds must be a whole number between 1 and 50.")
      return
    }
    savingRef.current = true
    setSaving(true)
    setError(null)
    setNotice(null)
    const version = editVersion.current
    try {
      await client.api.goal.saveSettings({
        maxRounds: rounds,
        criticModel: criticModel || null,
        judgeModel: judgeModel || null,
      })
      await queryClient.invalidateQueries({ queryKey: queryKeys.goalSettings })
      // Only clear the dirty flag when nothing changed while the save was in
      // flight; otherwise the user's newer edits stay (and can be saved again).
      if (editVersion.current === version) setDirty(false)
      setNotice("Saved.")
    } catch (saveError) {
      setError(goalErrorMessage(saveError))
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  return (
    <section aria-labelledby="settings-goal">
      <h3 id="settings-goal" className="mh-settings__title">
        Goal review
      </h3>
      <p className="mh-settings__desc">
        A goal run is challenged by an adversarial critic and decided by an impartial judge. Leave a model empty to
        use the session&apos;s own model.
      </p>

      <div className="mt-4 flex flex-col gap-2">
        <p className="mh-caption mh-muted">Critic model</p>
        <SearchSelect
          value={criticModel}
          options={modelOptions}
          onChange={(value) => {
            setCriticModel(value)
            setDirty(true)
            editVersion.current += 1
          }}
          ariaLabel="Critic model"
          placeholder="Use the session model"
        />
        <p className="mh-caption mh-muted mt-2">Judge model</p>
        <SearchSelect
          value={judgeModel}
          options={modelOptions}
          onChange={(value) => {
            setJudgeModel(value)
            setDirty(true)
            editVersion.current += 1
          }}
          ariaLabel="Judge model"
          placeholder="Use the session model"
        />
        <label className="mt-2 flex flex-col gap-1 text-xs text-ink-muted">
          Max rounds
          <input
            type="number"
            min={1}
            max={50}
            value={maxRounds}
            onChange={(event) => {
              setMaxRounds(event.target.value)
              setDirty(true)
              editVersion.current += 1
            }}
            className="mh-input w-24"
            aria-label="Max rounds before pausing"
          />
        </label>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button type="button" className="mh-btn mh-btn--secondary mh-btn--sm" disabled={saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save"}
        </button>
        {notice && <span className="text-xs text-ink-muted">{notice}</span>}
        {error && <span className="text-xs text-danger">{error}</span>}
      </div>
    </section>
  )
}
