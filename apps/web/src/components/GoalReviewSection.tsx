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
 * run pauses for a user decision. Persisted through the BFF. Every change
 * saves automatically, like the other settings sections — there is no Save
 * button.
 */
export function GoalReviewSection() {
  const queryClient = useQueryClient()
  const settings = useGoalSettings(client)
  const models = useModels(client)
  const [criticModel, setCriticModel] = useState("")
  const [judgeModel, setJudgeModel] = useState("")
  const [maxRounds, setMaxRounds] = useState("5")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
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
  }, [settings.data, dirty, saving, criticModel, judgeModel, maxRounds, queryClient])

  const modelOptions = [
    { value: "", label: "Use the session model" },
    ...flattenModels(models.data?.models ?? [], models.data?.providers ?? []).map((option) => ({
      value: option.value,
      label: option.label,
    })),
  ]

  return (
    <section aria-labelledby="settings-goal">
      <h3 id="settings-goal" className="mh-settings__title">
        Goal review
      </h3>
      <p className="mh-settings__desc">
        A goal run is challenged by an adversarial critic and decided by an impartial judge. Leave a model empty to
        use the session&apos;s own model. Changes save automatically.
      </p>

      {settings.isLoading && <p className="mt-4 text-xs text-ink-muted">Loading goal settings…</p>}
      {settings.error && <p className="mt-4 text-xs text-danger">Could not load the goal settings.</p>}

      <p className="mh-caption mh-muted mt-4">Models</p>
      <div className="mt-2 rounded-md border border-hairline bg-surface p-3">
        <p className="mh-caption mh-muted">Critic model</p>
        <div className="mt-1">
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
        </div>
        <p className="mh-caption mh-muted mt-3">Judge model</p>
        <div className="mt-1">
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
        </div>
        <p className="mt-2 text-[11px] text-ink-muted">Empty = the session model.</p>
      </div>

      <p className="mh-caption mh-muted mt-4">Budget</p>
      <div className="mt-2 rounded-md border border-hairline bg-surface p-3">
        <label className="flex flex-col gap-1 text-xs text-ink-muted">
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
        <p className="mt-2 text-[11px] text-ink-muted">Pauses for a decision after this many rounds (1–50).</p>
      </div>

      {saving && <p className="mt-2 text-xs text-ink-muted">Saving…</p>}
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
    </section>
  )
}
