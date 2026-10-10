/**
 * Web search sources and MasterHand's default selection (Settings > Web
 * search). opencode owns the sources; the selection lives in the config file
 * MasterHand already writes (`websearch.provider`) and each source's API key
 * stays in opencode's credential store (`connect/key`). These view models keep
 * the clients tolerant of missing/unknown fields.
 */

/**
 * Source that works without an API key. It is seeded as opencode's default so
 * agent web searches work out of the box, and it drives the "no API key" badge.
 */
export const KEYLESS_WEBSEARCH_PROVIDER = "tinyfish"

const KEYLESS_WEBSEARCH_IDS = new Set([KEYLESS_WEBSEARCH_PROVIDER])

/**
 * Built-in web search sources shipped by opencode v2 (verified against the
 * pinned 2.0.6). Used to keep them out of the model-provider catalog; the
 * settings section itself lists whatever opencode serves.
 */
export const WEBSEARCH_SOURCE_IDS: readonly string[] = ["exa", "firecrawl", "parallel", "tavily", "tinyfish"]

/** True when an integration id belongs to the built-in web search sources. */
export function isWebsearchSourceId(id: string): boolean {
  return WEBSEARCH_SOURCE_IDS.includes(id.trim().toLowerCase())
}

export interface WebsearchSource {
  id: string
  name: string
  /** True when the source works without connecting an API key. */
  keyless: boolean
}

/** True when the source is documented to work without an API key. */
export function isKeylessWebsearchSource(id: string): boolean {
  return KEYLESS_WEBSEARCH_IDS.has(id.trim().toLowerCase())
}

/**
 * Stored default selection: a source id, `"random"` (pick an available source
 * per query), `false` (disabled) or `null` (no selection; opencode prompts).
 */
export type WebsearchSelection = string | "random" | false | null

export interface WebsearchTestResult {
  /** Source that answered the test query. */
  providerID: string
  results: Array<{
    url: string
    title?: string
    content?: string
    /** Publish epoch ms, when the source reports one. */
    published?: number
  }>
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

/** Normalizes the sources list opencode serves (`{ id, name }` entries). */
export function normalizeWebsearchSources(raw: unknown): WebsearchSource[] {
  if (!Array.isArray(raw)) return []
  const sources: WebsearchSource[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    const record = asRecord(entry)
    const id = asString(record?.id)?.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    const name = asString(record?.name)?.trim() ?? id
    sources.push({ id, name, keyless: isKeylessWebsearchSource(id) })
  }
  return sources
}

/** Normalizes the BFF's `{ provider }` payload into the selection union. */
export function normalizeWebsearchSelection(raw: unknown): WebsearchSelection {
  const record = asRecord(raw)
  if (!record) return null
  const provider = record.provider
  if (provider === false) return false
  if (provider === "random") return "random"
  if (typeof provider === "string" && provider.trim().length > 0) return provider.trim()
  return null
}

/** Normalizes a `POST /api/websearch` response (`{ providerID, results }`). */
export function normalizeWebsearchTestResult(raw: unknown): WebsearchTestResult | null {
  const record = asRecord(raw)
  if (!record) return null
  const rawResults = record.results
  if (!Array.isArray(rawResults)) return null
  const results: WebsearchTestResult["results"] = []
  for (const entry of rawResults) {
    const item = asRecord(entry)
    const url = asString(item?.url)?.trim()
    if (!url) continue
    const title = asString(item?.title)?.trim()
    const content = asString(item?.content)
    const time = asRecord(item?.time)
    const published = typeof time?.published === "number" && Number.isFinite(time.published) ? time.published : undefined
    results.push({
      url,
      ...(title ? { title } : {}),
      ...(content ? { content } : {}),
      ...(published !== undefined ? { published } : {}),
    })
  }
  return { providerID: asString(record.providerID)?.trim() ?? "", results }
}
