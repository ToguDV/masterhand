import * as SecureStore from "expo-secure-store"
import {
  MAX_SERVER_PROFILES,
  defaultServerLabel,
  normalizeAgentActivityPreferences,
  normalizeServerLabel,
  normalizeServerUrl,
  type AgentActivityPreferences,
} from "@masterhand/client-core"

export interface StoredDevice {
  id: string
  name: string
}

/** One saved server profile. Tokens live under their own SecureStore keys. */
export interface StoredServerProfile {
  id: string
  label: string
  /** Canonical origin (https unless loopback). */
  url: string
  /** Device row returned by this server's `POST /api/devices`. */
  device: StoredDevice | null
  lastWorkspaceID: string | null
  lastSessionID: string | null
  expired: boolean
  lastUsedAt: number
}

export interface ServerRegistry {
  profiles: StoredServerProfile[]
  activeID: string | null
}

export interface SessionPreferences {
  agent: string
  model: string
  variant: string
}

const SERVER_URL_KEY = "masterhand.serverUrl"
const TOKEN_KEY = "masterhand.token"
const DEVICE_KEY = "masterhand.device"
/** Own key on purpose: signing out clears the session, never the device identity. */
const INSTALL_ID_KEY = "masterhand.installID"
const WORKSPACE_KEY = "masterhand.workspaceID"
const AUTO_ACCEPT_KEY = "masterhand.autoAcceptSessions"
const PREFERENCES_KEY = "masterhand.sessionPreferences"
const THEME_KEY = "masterhand.theme"
const PALETTE_KEY = "masterhand.palette"
const NOTIFICATIONS_ENABLED_KEY = "masterhand.notifications.enabled"
const NOTIFICATION_KINDS_KEY = "masterhand.notifications.kinds"
const NOTIFY_BUSY_PREFIX = "masterhand.notifyBusy."

/** Named differently from the legacy single-server keys so migration is unambiguous. */
const SERVERS_KEY = "masterhand.servers.v2"
const TOKEN_PREFIX = "masterhand.server.token."

export function loadServerUrl(): Promise<string | null> {
  return SecureStore.getItemAsync(SERVER_URL_KEY)
}

export function saveServerUrl(url: string): Promise<void> {
  return SecureStore.setItemAsync(SERVER_URL_KEY, url)
}

export function loadToken(): Promise<string | null> {
  return SecureStore.getItemAsync(TOKEN_KEY)
}

export function saveToken(token: string): Promise<void> {
  return SecureStore.setItemAsync(TOKEN_KEY, token)
}

export function clearToken(): Promise<void> {
  return SecureStore.deleteItemAsync(TOKEN_KEY)
}

export async function loadDevice(): Promise<StoredDevice | null> {
  const raw = await SecureStore.getItemAsync(DEVICE_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as StoredDevice
  } catch {
    return null
  }
}

export function saveDevice(device: StoredDevice): Promise<void> {
  return SecureStore.setItemAsync(DEVICE_KEY, JSON.stringify(device))
}

export function clearDevice(): Promise<void> {
  return SecureStore.deleteItemAsync(DEVICE_KEY)
}

/** `crypto.randomUUID` where the runtime has it, with a small dependency-free fallback. */
function newID(prefix = "id"): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  const uuid = crypto?.randomUUID?.()
  if (uuid) return uuid
  return `${prefix}-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`
}

let installIDInFlight: Promise<string> | null = null
/** Kept for this process only when SecureStore is unavailable (login must not break). */
let ephemeralInstallID: string | null = null

async function resolveInstallID(): Promise<string> {
  let stored: string | null
  try {
    stored = await SecureStore.getItemAsync(INSTALL_ID_KEY)
  } catch {
    // Never write here: a transient read failure must not overwrite a real id.
    ephemeralInstallID ??= newID("install")
    return ephemeralInstallID
  }
  if (stored) {
    ephemeralInstallID = null
    return stored
  }
  // Reuse an id that only lived in memory (previous write failure) instead of
  // registering a new device on every retry.
  const created = ephemeralInstallID ?? newID("install")
  try {
    await SecureStore.setItemAsync(INSTALL_ID_KEY, created)
    ephemeralInstallID = null
  } catch {
    ephemeralInstallID = created
  }
  return created
}

/**
 * Stable per-installation identity for device registration (#193). Concurrent
 * callers share one read; a SecureStore failure falls back to an in-memory id
 * so a broken keychain can never block login (#82).
 */
export function getOrCreateInstallID(): Promise<string> {
  if (!installIDInFlight) {
    installIDInFlight = resolveInstallID().finally(() => {
      installIDInFlight = null
    })
  }
  return installIDInFlight
}

function normalizeProfile(value: unknown): StoredServerProfile | null {
  if (!value || typeof value !== "object") return null
  const input = value as Partial<StoredServerProfile>
  if (typeof input.id !== "string" || !input.id) return null
  if (typeof input.url !== "string") return null
  // Pre-multi-server installs may legitimately point at a plain-http LAN
  // address. New profiles still go through the https-only add form; this
  // allowance only keeps already-persisted sessions loadable.
  const normalized = normalizeServerUrl(input.url, { allowInsecure: true })
  if (!normalized.ok) return null
  const url = normalized.server.url
  const device =
    input.device &&
    typeof input.device === "object" &&
    typeof (input.device as StoredDevice).id === "string" &&
    typeof (input.device as StoredDevice).name === "string"
      ? { id: (input.device as StoredDevice).id, name: (input.device as StoredDevice).name }
      : null
  return {
    id: input.id.slice(0, 128),
    label: normalizeServerLabel(input.label, url),
    url,
    device,
    lastWorkspaceID: typeof input.lastWorkspaceID === "string" ? input.lastWorkspaceID : null,
    lastSessionID: typeof input.lastSessionID === "string" ? input.lastSessionID : null,
    expired: input.expired === true,
    lastUsedAt: typeof input.lastUsedAt === "number" ? input.lastUsedAt : 0,
  }
}

function parseRegistry(raw: string | null): ServerRegistry | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { profiles?: unknown; activeID?: unknown }
    const profiles = Array.isArray(parsed.profiles)
      ? parsed.profiles
          .map(normalizeProfile)
          .filter((profile): profile is StoredServerProfile => profile !== null)
          .slice(0, MAX_SERVER_PROFILES)
      : []
    const activeID =
      typeof parsed.activeID === "string" && profiles.some((profile) => profile.id === parsed.activeID)
        ? parsed.activeID
        : null
    return { profiles, activeID }
  } catch {
    return null
  }
}

/**
 * Reads the registry, migrating the legacy single-server keys exactly once.
 * Legacy keys are deleted only after the new entries are written, so a failed
 * migration cannot lose the session.
 */
export async function loadServerRegistry(): Promise<ServerRegistry> {
  const stored = parseRegistry(await SecureStore.getItemAsync(SERVERS_KEY))
  if (stored) return stored

  const [legacyUrl, legacyToken, legacyDevice, legacyWorkspace, legacyAutoAccept] = await Promise.all([
    SecureStore.getItemAsync(SERVER_URL_KEY),
    SecureStore.getItemAsync(TOKEN_KEY).catch(() => null),
    loadDevice().catch(() => null),
    SecureStore.getItemAsync(WORKSPACE_KEY).catch(() => null),
    SecureStore.getItemAsync(AUTO_ACCEPT_KEY).catch(() => null),
  ])
  const normalized = legacyUrl ? normalizeServerUrl(legacyUrl, { allowInsecure: true }) : null
  if (!legacyUrl || !normalized || !normalized.ok) return { profiles: [], activeID: null }

  const profile: StoredServerProfile = {
    id: newID("srv"),
    label: defaultServerLabel(normalized.server),
    url: normalized.server.url,
    device: legacyDevice,
    lastWorkspaceID: legacyWorkspace,
    lastSessionID: null,
    expired: false,
    lastUsedAt: Date.now(),
  }
  const registry: ServerRegistry = {
    profiles: [profile],
    // A saved URL without a token keeps the profile for re-auth but is not
    // auto-connected: the app opens the Servers screen.
    activeID: legacyToken ? profile.id : null,
  }
  await SecureStore.setItemAsync(SERVERS_KEY, JSON.stringify(registry))
  if (legacyToken) await SecureStore.setItemAsync(`${TOKEN_PREFIX}${profile.id}`, legacyToken)
  if (legacyAutoAccept) {
    await SecureStore.setItemAsync(`${AUTO_ACCEPT_KEY}.${profile.id}`, legacyAutoAccept).catch(() => {})
  }
  // Only now is it safe to forget the legacy keys.
  await Promise.all([
    SecureStore.deleteItemAsync(SERVER_URL_KEY),
    SecureStore.deleteItemAsync(TOKEN_KEY),
    SecureStore.deleteItemAsync(DEVICE_KEY),
    SecureStore.deleteItemAsync(WORKSPACE_KEY),
    SecureStore.deleteItemAsync(AUTO_ACCEPT_KEY),
  ])
  return registry
}

/**
 * Serialized read/write queue for the registry. Rapid connect/expire/update
 * calls must land in order: an older SecureStore write completing late used to
 * resurrect a stale `activeID` or profile list.
 */
let registryWrite: Promise<void> = Promise.resolve()

export function saveServerRegistry(registry: ServerRegistry): Promise<void> {
  const write = registryWrite.then(async () => {
    await SecureStore.setItemAsync(SERVERS_KEY, JSON.stringify(registry))
  })
  registryWrite = write.catch(() => {})
  return write
}

export function newServerID(): string {
  return newID("srv")
}

export function loadServerToken(profileID: string): Promise<string | null> {
  return SecureStore.getItemAsync(`${TOKEN_PREFIX}${profileID}`)
}

export function saveServerToken(profileID: string, token: string): Promise<void> {
  return SecureStore.setItemAsync(`${TOKEN_PREFIX}${profileID}`, token)
}

export async function clearServerToken(profileID: string): Promise<void> {
  await SecureStore.deleteItemAsync(`${TOKEN_PREFIX}${profileID}`)
}

export function loadAutoAcceptSessionsFor(profileID: string): Promise<string[]> {
  return readIDList(`${AUTO_ACCEPT_KEY}.${profileID}`)
}

export function saveAutoAcceptSessionsFor(profileID: string, ids: string[]): Promise<void> {
  return SecureStore.setItemAsync(`${AUTO_ACCEPT_KEY}.${profileID}`, JSON.stringify(ids))
}

export function loadWorkspaceID(): Promise<string | null> {
  return SecureStore.getItemAsync(WORKSPACE_KEY)
}

export function saveWorkspaceID(id: string): Promise<void> {
  return SecureStore.setItemAsync(WORKSPACE_KEY, id)
}

export function clearWorkspaceID(): Promise<void> {
  return SecureStore.deleteItemAsync(WORKSPACE_KEY)
}

async function readIDList(key: string): Promise<string[]> {
  const raw = await SecureStore.getItemAsync(key)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []
  } catch {
    return []
  }
}

/** Stored theme choice, or null when unset/corrupted (the system decides). */
export async function loadTheme(): Promise<"light" | "dark" | null> {
  try {
    const raw = await SecureStore.getItemAsync(THEME_KEY)
    return raw === "light" || raw === "dark" ? raw : null
  } catch {
    return null
  }
}

export function saveTheme(theme: "light" | "dark"): Promise<void> {
  return SecureStore.setItemAsync(THEME_KEY, theme)
}

/** Clears the stored choice: the theme goes back to following the system. */
export function clearTheme(): Promise<void> {
  return SecureStore.deleteItemAsync(THEME_KEY)
}

/** Stored palette choice, or null when unset/corrupted (paper decides). */
export async function loadPalette(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(PALETTE_KEY)
  } catch {
    return null
  }
}

export function savePalette(palette: string): Promise<void> {
  return SecureStore.setItemAsync(PALETTE_KEY, palette)
}

/** Clears the stored palette: the theme goes back to paper. */
export function clearPalette(): Promise<void> {
  return SecureStore.deleteItemAsync(PALETTE_KEY)
}

export async function loadAutoAcceptSessions(): Promise<string[]> {
  return readIDList(AUTO_ACCEPT_KEY)
}

export function saveAutoAcceptSessions(ids: string[]): Promise<void> {
  return SecureStore.setItemAsync(AUTO_ACCEPT_KEY, JSON.stringify(ids))
}

export async function loadSessionPreferences(sessionID: string): Promise<Partial<SessionPreferences>> {
  const raw = await SecureStore.getItemAsync(PREFERENCES_KEY)
  if (!raw) return {}
  try {
    const map = JSON.parse(raw) as Record<string, Partial<SessionPreferences>>
    const value = map[sessionID]
    if (!value || typeof value !== "object") return {}
    return {
      ...(typeof value.agent === "string" ? { agent: value.agent } : {}),
      ...(typeof value.model === "string" ? { model: value.model } : {}),
      ...(typeof value.variant === "string" ? { variant: value.variant } : {}),
    }
  } catch {
    return {}
  }
}

/**
 * Serialized read-modify-write queue for the preferences map: two concurrent
 * saves used to read the same JSON and clobber each other (issue #82). The
 * chain stays alive after a failure so one rejected write cannot poison every
 * later save; callers still observe their own rejection.
 */
let preferencesWrite: Promise<void> = Promise.resolve()

export function saveSessionPreferences(sessionID: string, preferences: SessionPreferences): Promise<void> {
  const write = preferencesWrite.then(async () => {
    let map: Record<string, SessionPreferences> = {}
    try {
      const raw = await SecureStore.getItemAsync(PREFERENCES_KEY)
      if (raw) map = JSON.parse(raw) as Record<string, SessionPreferences>
    } catch {
      map = {}
    }
    map[sessionID] = preferences
    await SecureStore.setItemAsync(PREFERENCES_KEY, JSON.stringify(map))
  })
  preferencesWrite = write.catch(() => {})
  return write
}

/** Local agent notifications: device-wide opt-in, off by default. */
export async function loadNotificationsEnabled(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(NOTIFICATIONS_ENABLED_KEY)) === "1"
  } catch {
    return false
  }
}

export function saveNotificationsEnabled(enabled: boolean): Promise<void> {
  return SecureStore.setItemAsync(NOTIFICATIONS_ENABLED_KEY, enabled ? "1" : "0")
}

/** Per-event switches; missing or malformed storage means everything on. */
export async function loadAgentActivityPreferences(): Promise<AgentActivityPreferences> {
  try {
    const raw = await SecureStore.getItemAsync(NOTIFICATION_KINDS_KEY)
    return normalizeAgentActivityPreferences(raw ? (JSON.parse(raw) as unknown) : null)
  } catch {
    return normalizeAgentActivityPreferences(null)
  }
}

export function saveAgentActivityPreferences(preferences: AgentActivityPreferences): Promise<void> {
  return SecureStore.setItemAsync(NOTIFICATION_KINDS_KEY, JSON.stringify(preferences))
}

export interface BusySnapshotEntry {
  title: string
  workspaceID?: string
}

export type BusySnapshot = Record<string, BusySnapshotEntry>

/** Sessions last seen busy per server profile (background-task baseline). */
export async function loadBusySnapshot(profileID: string): Promise<BusySnapshot> {
  try {
    const raw = await SecureStore.getItemAsync(`${NOTIFY_BUSY_PREFIX}${profileID}`)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    const snapshot: BusySnapshot = {}
    for (const [sessionID, entry] of Object.entries(parsed)) {
      if (!entry || typeof entry !== "object") continue
      const title = (entry as { title?: unknown }).title
      const workspaceID = (entry as { workspaceID?: unknown }).workspaceID
      snapshot[sessionID] = {
        title: typeof title === "string" && title ? title.slice(0, 120) : sessionID,
        ...(typeof workspaceID === "string" && workspaceID ? { workspaceID } : {}),
      }
    }
    return snapshot
  } catch {
    return {}
  }
}

export function saveBusySnapshot(profileID: string, snapshot: BusySnapshot): Promise<void> {
  const bounded = Object.fromEntries(Object.entries(snapshot).slice(0, 200))
  return SecureStore.setItemAsync(`${NOTIFY_BUSY_PREFIX}${profileID}`, JSON.stringify(bounded))
}
