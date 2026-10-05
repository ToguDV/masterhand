import type { AgentInfo, ModelInfo, ModelRef, ProviderInfo, Session } from "./types"

export interface FlatModelOption {
  value: string
  label: string
  variants: string[]
}

export function selectableAgents(agents: AgentInfo[]): AgentInfo[] {
  return agents.filter((agent) => agent.mode !== "subagent" && agent.hidden !== true)
}

/** Flattens the v2 model catalog into the options the composer selectors use. */
export function flattenModels(models: ModelInfo[], providers: ProviderInfo[]): FlatModelOption[] {
  const providerNames = new Map(providers.map((provider) => [provider.id, provider.name]))
  const options = models
    .filter((model) => model.enabled !== false)
    .map((model) => ({
      value: `${model.providerID}/${model.id}`,
      label: `${providerNames.get(model.providerID) ?? model.providerID} · ${model.name || model.id}`,
      variants: model.variants.map((variant) => variant.id),
    }))
  return options.sort((a, b) => a.label.localeCompare(b.label))
}

const VARIANT_LABELS: Record<string, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Very high",
  max: "Max",
}

export function variantLabel(key: string): string {
  const known = VARIANT_LABELS[key.toLowerCase()]
  if (known) return known
  return key.charAt(0).toUpperCase() + key.slice(1)
}

/** True when the variant id names a reasoning-effort level (brain glyph in the composer). */
export function isEffortVariant(key: string): boolean {
  return VARIANT_LABELS[key.toLowerCase()] !== undefined
}

export function defaultModelValue(
  defaultModel: ModelInfo | null,
  options: FlatModelOption[],
  preferred?: string,
): string {
  if (preferred && options.some((option) => option.value === preferred)) return preferred
  if (defaultModel) {
    const value = `${defaultModel.providerID}/${defaultModel.id}`
    if (options.some((option) => option.value === value)) return value
  }
  return options[0]?.value ?? ""
}

/** The model a session ran with, if it is still an available option. */
export function sessionModelValue(session: Session | undefined, options: FlatModelOption[]): string | undefined {
  const model = session?.model
  if (!model) return undefined
  const value = `${model.providerID}/${model.id}`
  return options.some((option) => option.value === value) ? value : undefined
}

/** The model used by the most recently updated session, if it is still available. */
export function recentModelValue(sessions: Session[], options: FlatModelOption[]): string | undefined {
  let best: { updated: number; value: string } | undefined
  for (const session of sessions) {
    const value = sessionModelValue(session, options)
    if (!value) continue
    const updated = session.time?.updated ?? 0
    if (!best || updated > best.updated) best = { updated, value }
  }
  return best?.value
}

/** Parses a `provider/model` composer value; the variant travels separately. */
export function parseModel(value: string, variant?: string): ModelRef | undefined {
  const index = value.indexOf("/")
  if (index === -1) return undefined
  const model: ModelRef = { providerID: value.slice(0, index), id: value.slice(index + 1) }
  if (variant) model.variant = variant
  return model
}
