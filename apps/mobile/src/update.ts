import { Linking } from "react-native"
import * as Application from "expo-application"
import {
  androidVersionCode,
  compareSemver,
  isNewerVersion,
  type Client,
} from "@masterhand/client-core"

/**
 * Android update source (#133). The BFF manifest (`GET /api/update`, #131) is
 * preferred; when it is unknown (BFF unreachable or predating the route) the
 * client falls back to the self-hosted F-Droid index. Either way the UI only
 * ever deep-links into F-Droid — MasterHand never downloads or installs an
 * APK itself (no `REQUEST_INSTALL_PACKAGES`, no installer intent, no
 * `expo-updates`).
 */

export const FDROID_PACKAGE = "dev.togudv.masterhand"
/** Stable F-Droid repo URL, served from the `fdroid` branch (see `docs/runbooks/fdroid.md`). */
export const FDROID_REPO_URL = "https://togudv.github.io/masterhand/fdroid/"
export const FDROID_INDEX_URL = `${FDROID_REPO_URL}index-v2.json`
/** Deep link into the F-Droid client (`org.fdroid.fdroid` handles `market://`). */
export const FDROID_MARKET_URL = `market://details?id=${FDROID_PACKAGE}`

export interface InstalledVersion {
  versionName: string
  versionCode: number
}

const FALLBACK_INSTALLED: InstalledVersion = { versionName: "0.1.0", versionCode: 100 }

/**
 * Version of the installed build, from `expo-application`. Never throws:
 * under Jest (or a missing native module) it reports the `0.1.0` baseline.
 */
export function installedVersion(): InstalledVersion {
  try {
    const versionName =
      typeof Application.nativeApplicationVersion === "string" && Application.nativeApplicationVersion
        ? Application.nativeApplicationVersion
        : FALLBACK_INSTALLED.versionName
    const rawCode = Application.nativeBuildVersion
    const parsed = typeof rawCode === "string" ? Number.parseInt(rawCode, 10) : Number.NaN
    return {
      versionName,
      versionCode: Number.isFinite(parsed) && parsed > 0 ? parsed : androidVersionCode(versionName),
    }
  } catch {
    return FALLBACK_INSTALLED
  }
}

export type MobileUpdateSource = "bff" | "fdroid"

export interface MobileUpdate {
  source: MobileUpdateSource
  version: string
  tag: string
  notes: string | null
}

interface FdroidEntry {
  version: string
  versionCode: number
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * Tolerant `index-v2.json` reader: picks the highest `versionCode` of the
 * MasterHand package. Anything without a usable entry is null (no notice),
 * never an error.
 */
export function normalizeFdroidIndex(value: unknown): FdroidEntry | null {
  const packages = asRecord(asRecord(value)?.packages)?.[FDROID_PACKAGE]
  if (!Array.isArray(packages)) return null
  let best: FdroidEntry | null = null
  for (const entry of packages) {
    const record = asRecord(entry)
    const versionName = record && typeof record.versionName === "string" ? record.versionName.trim() : ""
    const versionCode =
      record && (typeof record.versionCode === "number" || typeof record.versionCode === "string")
        ? Number.parseInt(String(record.versionCode), 10)
        : Number.NaN
    if (!versionName || !Number.isFinite(versionCode)) continue
    if (!best || versionCode > best.versionCode) best = { version: versionName, versionCode }
  }
  return best
}

async function fdroidLatest(fetchImpl: typeof fetch): Promise<FdroidEntry | null> {
  const response = await fetchImpl(FDROID_INDEX_URL, { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) return null
  const body: unknown = await response.json().catch(() => null)
  return normalizeFdroidIndex(body)
}

/**
 * Resolves the Android update against the installed build. BFF first, F-Droid
 * index as fallback; every failure degrades to `{ update: null }`.
 */
export async function checkMobileUpdate(options: {
  client: Client
  installed: InstalledVersion
  fetchImpl?: typeof fetch
}): Promise<{ update: MobileUpdate | null; checkedAt: number }> {
  const { client, installed } = options
  const fetchImpl = options.fetchImpl ?? fetch
  try {
    const check = await client.api.update.check()
    if (check.latest && isNewerVersion(installed.versionName, check.latest.version)) {
      return {
        update: { source: "bff", version: check.latest.version, tag: check.latest.tag, notes: check.latest.notes },
        checkedAt: Date.now(),
      }
    }
    if (check.latest) return { update: null, checkedAt: Date.now() }
  } catch {
    // The client already degrades its own failures to latest:null; anything
    // escaping it (a foreign client shape in tests) still falls through.
  }
  try {
    const entry = await fdroidLatest(fetchImpl)
    if (!entry) return { update: null, checkedAt: Date.now() }
    const newer =
      entry.versionCode > installed.versionCode ||
      (entry.versionCode === installed.versionCode &&
        compareSemver(installed.versionName, entry.version) < 0)
    if (!newer) return { update: null, checkedAt: Date.now() }
    return {
      update: { source: "fdroid", version: entry.version, tag: `v${entry.version}`, notes: null },
      checkedAt: Date.now(),
    }
  } catch {
    return { update: null, checkedAt: Date.now() }
  }
}

/**
 * Opens the MasterHand listing in the F-Droid client (`market://` intent,
 * handled by `org.fdroid.fdroid`), falling back to the self-hosted repo
 * website when no handler is installed.
 */
export async function openFdroidListing(): Promise<void> {
  try {
    if (await Linking.canOpenURL(FDROID_MARKET_URL)) {
      await Linking.openURL(FDROID_MARKET_URL)
      return
    }
  } catch {
    // Fall through to the website.
  }
  await Linking.openURL(FDROID_REPO_URL)
}
