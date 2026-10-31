import {
  browserOrigin,
  MAX_SERVER_PROFILES,
  normalizeServerLabel,
  normalizeServerUrl,
  serverAuthMode,
  type ServerAuthMode,
} from "@masterhand/client-core"
import { isBundledDesktop } from "./platform"

/**
 * Web/desktop multi-server registry.
 *
 * Profiles and secrets intentionally live under different localStorage keys:
 * a profile carries only routing/label/restore metadata, while a remote
 * server's device token is stored per profile. Same-origin servers never keep
 * a token (the HttpOnly session cookie is the only credential).
 */

export interface ServerProfile {
  id: string
  label: string
  /** Canonical origin, no trailing slash. */
  url: string
  authMode: ServerAuthMode
  lastUsedAt: number
  lastWorkspaceID: string | null
  lastSessionID: string | null
  /** Device row identity returned by this server's `POST /api/devices`. */
  deviceID: string | null
  /** Saved session needs a password again (401 from the server). */
  expired: boolean
}

export interface ServerRegistry {
  profiles: ServerProfile[]
  activeID: string | null
}

const PROFILES_KEY = "masterhand.servers"
const ACTIVE_KEY = "masterhand.servers.active"
const TOKEN_PREFIX = "masterhand.server.token."
const INSTALL_ID_KEY = "masterhand.installID"

function storageAvailable(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function newID(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  return crypto?.randomUUID?.() ?? `srv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function normalizeProfile(value: unknown): ServerProfile | null {
  if (!value || typeof value !== "object") return null
  const input = value as Partial<ServerProfile>
  if (typeof input.id !== "string" || !input.id) return null
  if (typeof input.url !== "string") return null
  // The serving origin may be plain http (LAN deployment, COOKIE_SECURE=false):
  // its cookie never leaves that origin. Remote profiles stay https-only,
  // except in the bundled desktop app, which has no cookie origin and keeps
  // the plain-http LAN servers the old shell accepted.
  const normalized = normalizeServerUrl(input.url, {
    allowInsecureOrigin: browserOrigin(),
    allowInsecure: isBundledDesktop(),
  })
  if (!normalized.ok) return null
  const url = normalized.server.url
  const label =
    typeof input.label === "string" && input.label.trim()
      ? normalizeServerLabel(input.label, url)
      : normalizeServerLabel(null, url)
  return {
    id: input.id.slice(0, 128),
    label,
    url,
    // Recompute: a profile saved on another origin may become same-origin.
    authMode: serverAuthMode(url),
    lastUsedAt: typeof input.lastUsedAt === "number" ? input.lastUsedAt : 0,
    lastWorkspaceID: typeof input.lastWorkspaceID === "string" ? input.lastWorkspaceID : null,
    lastSessionID: typeof input.lastSessionID === "string" ? input.lastSessionID : null,
    deviceID: typeof input.deviceID === "string" ? input.deviceID : null,
    expired: input.expired === true,
  }
}

export function loadRegistry(): ServerRegistry {
  const storage = storageAvailable()
  if (!storage) return { profiles: [], activeID: null }
  let raw: string | null = null
  try {
    raw = storage.getItem(PROFILES_KEY)
  } catch {
    return { profiles: [], activeID: null }
  }
  if (!raw) return { profiles: [], activeID: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { profiles: [], activeID: null }
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { profiles?: unknown }).profiles
  const profiles = Array.isArray(list)
    ? list
        .map(normalizeProfile)
        .filter((profile): profile is ServerProfile => profile !== null)
        .slice(0, MAX_SERVER_PROFILES)
    : []
  let activeID: string | null = null
  try {
    activeID = storage.getItem(ACTIVE_KEY)
  } catch {
    activeID = null
  }
  if (!activeID || !profiles.some((profile) => profile.id === activeID)) activeID = null
  return { profiles, activeID }
}

export function saveRegistry(registry: ServerRegistry): void {
  const storage = storageAvailable()
  if (!storage) return
  try {
    storage.setItem(PROFILES_KEY, JSON.stringify(registry.profiles))
    if (registry.activeID) storage.setItem(ACTIVE_KEY, registry.activeID)
    else storage.removeItem(ACTIVE_KEY)
  } catch {
    // Private mode/quota: the in-memory registry still works for this view.
  }
}

export function findProfileByUrl(profiles: ServerProfile[], url: string): ServerProfile | null {
  return profiles.find((profile) => profile.url === url) ?? null
}

export function createProfile(input: {
  url: string
  label?: string | null
  authMode?: ServerAuthMode
}): ServerProfile {
  return {
    id: newID(),
    label: normalizeServerLabel(input.label, input.url),
    url: input.url,
    authMode: input.authMode ?? serverAuthMode(input.url),
    lastUsedAt: Date.now(),
    lastWorkspaceID: null,
    lastSessionID: null,
    deviceID: null,
    expired: false,
  }
}


export function removeProfile(profiles: ServerProfile[], id: string): ServerProfile[] {
  return profiles.filter((profile) => profile.id !== id)
}

export function tokenKey(profileID: string): string {
  return `${TOKEN_PREFIX}${profileID}`
}

export function loadServerToken(profileID: string): string | null {
  const storage = storageAvailable()
  if (!storage) return null
  try {
    return storage.getItem(tokenKey(profileID))
  } catch {
    return null
  }
}

export function saveServerToken(profileID: string, token: string): void {
  const storage = storageAvailable()
  if (!storage) return
  try {
    storage.setItem(tokenKey(profileID), token)
  } catch {
    // The session stays usable in memory; a reload asks for the password.
  }
}

export function clearServerToken(profileID: string): void {
  const storage = storageAvailable()
  if (!storage) return
  try {
    storage.removeItem(tokenKey(profileID))
  } catch {
    // ignore
  }
}

let ephemeralInstallID: string | null = null

/** Stable per-installation identity for device registration (survives sign-out). */
export function getOrCreateInstallID(): string {
  const storage = storageAvailable()
  if (!storage) {
    ephemeralInstallID ??= newID()
    return ephemeralInstallID
  }
  try {
    const stored = storage.getItem(INSTALL_ID_KEY)
    if (stored) return stored
  } catch {
    ephemeralInstallID ??= newID()
    return ephemeralInstallID
  }
  const created = ephemeralInstallID ?? newID()
  try {
    storage.setItem(INSTALL_ID_KEY, created)
    ephemeralInstallID = null
  } catch {
    ephemeralInstallID = created
  }
  return created
}

/** Device label shown in the server's device list; never used for identity. */
export function webDeviceName(): string {
  return isBundledDesktop() ? "Desktop app" : "Web browser"
}

/** Copies the pre-multi-server global preferences to the first profile once. */
export function migrateLegacyPreferences(profileID: string): void {
  const storage = storageAvailable()
  if (!storage) return
  for (const key of ["masterhand.workspace", "masterhand.autoAcceptSessions", "masterhand.lastSeenSessions"]) {
    try {
      const value = storage.getItem(key)
      if (!value) continue
      const scoped = `${key}.${profileID}`
      if (!storage.getItem(scoped)) storage.setItem(scoped, value)
      storage.removeItem(key)
    } catch {
      // ignore a partial migration: the app still works without the old preferences
    }
  }
}

export function loadScopedJSON<T>(key: string, fallback: T): T {
  const storage = storageAvailable()
  if (!storage) return fallback
  try {
    const raw = storage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function saveScopedJSON(key: string, value: unknown): void {
  const storage = storageAvailable()
  if (!storage) return
  try {
    storage.setItem(key, JSON.stringify(value))
  } catch {
    // storage may be unavailable (private mode)
  }
}
