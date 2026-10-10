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
      {/* Pinned above the cards, like Providers: saving never scrolls away. */}
      <div className="mh-settings__module-head">
        <div className="min-w-0">
          <h3 id="settings-goal" className="mh-settings__title">
            Goal review
          </h3>
          <p className="mh-settings__desc">
            A goal run is challenged by an adversarial critic and decided by an impartial judge. Leave a model empty
            to use the session&apos;s own model.
          </p>
        </div>
        <button
          type="button"
          className="mh-btn mh-btn--primary mh-btn--sm shrink-0"
          disabled={saving}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>

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

      {notice && <p className="mt-2 text-xs text-accent">{notice}</p>}
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
    </section>
  )
}
