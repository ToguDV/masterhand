/**
 * Release manifest behind `GET /api/update` (#131). The BFF fetches the
 * `version.json` published with the latest GitHub release, normalizes it
 * tolerantly and caches it in memory behind a 10–15 min TTL. Every failure —
 * network, timeout, non-200, malformed JSON, unusable version — degrades to
 * `latest: null`, never to an error state: an unknown upstream means "no
 * notice", and old clients simply never call the route.
 */

export interface VersionRelease {
  version: string
  tag: string
  publishedAt: string | null
  notes: string | null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null
}

function parseSemver(version: string): [number, number, number] | null {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?[^0-9]*.*$/.exec(version.trim())
  if (!match) return null
  const parts = [match[1] ?? "0", match[2] ?? "0", match[3] ?? "0"].map((part) => Number.parseInt(part, 10))
  if (parts.some((part) => !Number.isFinite(part) || part < 0)) return null
  return parts as [number, number, number]
}

/**
 * Tolerant `version.json` normalizer (mirrors `normalizeVersionManifest` in
 * `client-core`: the BFF does not depend on client-core). Drops invalid
 * extras instead of rejecting; null when there is no usable version.
 */
export function normalizeVersionManifest(value: unknown): VersionRelease | null {
  const record = asRecord(value)
  const text = record ? asText(record.version) : null
  const parsed = text ? parseSemver(text) : null
  if (!parsed) return null
  const version = `${parsed[0]}.${parsed[1]}.${parsed[2]}`
  const tag = (record ? asText(record.tag) : null) ?? `v${version}`
  const publishedRaw = asText(record?.publishedAt)
  const publishedTime = publishedRaw ? Date.parse(publishedRaw) : Number.NaN
  return {
    version,
    tag,
    publishedAt: publishedRaw && Number.isFinite(publishedTime) ? new Date(publishedTime).toISOString() : null,
    notes:
      typeof record?.notes === "string" && record.notes.trim() !== "" ? record.notes.trim() : null,
  }
}

export interface UpdateCheckerOptions {
  manifestUrl: string
  /** TTL of the in-memory cache; 0 disables caching (tests). */
  cacheMs: number
  fetchImpl?: typeof fetch
  /** Per-attempt budget so a wedged upstream cannot hold the route. */
  timeoutMs?: number
}

export interface UpdateCheckResult {
  latest: VersionRelease | null
  checkedAt: number
}

/**
 * Fetches and caches the release manifest. Concurrent misses share one
 * in-flight fetch; failures resolve to `{ latest: null }` and are NOT cached
 * as long as successes (a short 60 s negative TTL keeps a downed upstream
 * from being hammered by every poll while still recovering quickly).
 */
export function createUpdateChecker(options: UpdateCheckerOptions): () => Promise<UpdateCheckResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 10_000
  let cached: { at: number; result: UpdateCheckResult } | null = null
  let negativeUntil = 0
  let inFlight: Promise<UpdateCheckResult> | null = null

  async function fetchManifest(): Promise<UpdateCheckResult> {
    try {
      const response = await fetchImpl(options.manifestUrl, { signal: AbortSignal.timeout(timeoutMs) })
      if (!response.ok) return { latest: null, checkedAt: Date.now() }
      const body: unknown = await response.json().catch(() => null)
      return { latest: normalizeVersionManifest(body), checkedAt: Date.now() }
    } catch {
      return { latest: null, checkedAt: Date.now() }
    }
  }

  return async () => {
    const now = Date.now()
    if (cached && now - cached.at < options.cacheMs) return cached.result
    if (now < negativeUntil && cached) return cached.result
    inFlight ??= fetchManifest().then((result) => {
      inFlight = null
      if (result.latest) {
        cached = { at: Date.now(), result }
      } else {
        // Negative result: keep serving the last good value (if any) for a
        // minute without caching the miss as truth.
        negativeUntil = Date.now() + 60_000
        if (!cached) cached = { at: 0, result }
      }
      return cached.result
    })
    return inFlight
  }
}
