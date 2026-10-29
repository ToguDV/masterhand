/**
 * Release/update contract (#131). The BFF serves `GET /api/update` as
 * `{ latest: VersionRelease | null }`, normalized from the `version.json`
 * manifest published with every GitHub release. Everything here is tolerant:
 * an unparsable manifest degrades to `latest: null` (no notice), never to an
 * error state. The semver helpers are pure and shared by web and mobile.
 */

/** Default `version.json` location: the file attached to the latest GitHub release. */
export const UPDATE_MANIFEST_URL =
  "https://github.com/togudv/masterhand/releases/latest/download/version.json"

/** One published release, as served by `GET /api/update`. */
export interface VersionRelease {
  /** Normalized `major.minor.patch` (no leading `v`). */
  version: string
  /** GitHub tag, e.g. `v0.2.0` (derived when the manifest omits it). */
  tag: string
  /** ISO timestamp of the release, when the manifest carries one. */
  publishedAt: string | null
  /** Release notes excerpt, when the manifest carries one. */
  notes: string | null
}

/** Shape of `GET /api/update`: a release or an explicit "unknown". */
export interface UpdateCheck {
  latest: VersionRelease | null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null
}

/** Numeric `major.minor.patch` triple, or null when unparseable. */
function parseSemver(version: string): [number, number, number] | null {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?[^0-9]*.*$/.exec(version.trim())
  if (!match) return null
  const parts = [match[1] ?? "0", match[2] ?? "0", match[3] ?? "0"].map((part) =>
    Number.parseInt(part, 10),
  )
  if (parts.some((part) => !Number.isFinite(part) || part < 0)) return null
  return parts as [number, number, number]
}

/**
 * Compares two version strings numerically (`0.10.0` beats `0.9.0`).
 * Unparseable input compares equal: an unknown version must never surface an
 * error or a phantom update — the notice simply stays hidden.
 */
export function compareSemver(a: string, b: string): number {
  const parsedA = parseSemver(a)
  const parsedB = parseSemver(b)
  if (!parsedA || !parsedB) return 0
  for (let index = 0; index < 3; index += 1) {
    const left = parsedA[index] ?? 0
    const right = parsedB[index] ?? 0
    if (left !== right) return left < right ? -1 : 1
  }
  return 0
}

/** True only when `latest` is strictly newer than `current`. */
export function isNewerVersion(current: string, latest: string): boolean {
  return compareSemver(current, latest) < 0
}

/**
 * Normalizes one `major.minor.patch` triple for display. Returns null when
 * the input carries no usable version.
 */
function normalizeVersion(version: unknown): string | null {
  const text = asText(version)
  if (!text) return null
  const parsed = parseSemver(text)
  if (!parsed) return null
  return `${parsed[0]}.${parsed[1]}.${parsed[2]}`
}

function normalizeDate(value: unknown): string | null {
  const text = asText(value)
  if (!text) return null
  const time = Date.parse(text)
  return Number.isFinite(time) ? new Date(time).toISOString() : null
}

/**
 * Tolerant `version.json` normalizer: keeps the version plus whatever valid
 * extras arrived, derives the tag, and drops invalid extras instead of
 * rejecting the manifest. Returns null when there is no usable version.
 */
export function normalizeVersionManifest(value: unknown): VersionRelease | null {
  const record = asRecord(value)
  const version = record ? normalizeVersion(record.version) : null
  if (!version) return null
  const tag = (record ? asText(record.tag) : null) ?? `v${version}`
  return {
    version,
    tag,
    publishedAt: normalizeDate(record?.publishedAt),
    notes: typeof record?.notes === "string" && record.notes.trim() !== "" ? record.notes.trim() : null,
  }
}

/**
 * Normalizes a `GET /api/update` body. Any shape without a usable `latest`
 * becomes `{ latest: null }`: an unknown upstream is "no notice", never an
 * error state (old BFFs predate the route entirely — the client treats that
 * the same way).
 */
export function normalizeUpdateCheck(value: unknown): UpdateCheck {
  const record = asRecord(value)
  if (!record) return { latest: null }
  if (record.latest === null || record.latest === undefined) return { latest: null }
  return { latest: normalizeVersionManifest(record.latest) }
}

/**
 * Monotonic Android `versionCode` derived from semver
 * (`major*10000 + minor*100 + patch`, #133). Unparseable input maps to the
 * `0.1.0` baseline so the code never decreases on a bad manifest.
 */
export function androidVersionCode(version: string): number {
  const parsed = parseSemver(version)
  if (!parsed) return 100
  return parsed[0] * 10000 + parsed[1] * 100 + parsed[2]
}
