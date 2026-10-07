import * as SecureStore from "expo-secure-store"

export interface StoredDevice {
  id: string
  name: string
}

export interface SessionPreferences {
  agent: string
  model: string
  variant: string
}

const SERVER_URL_KEY = "masterhand.serverUrl"
const TOKEN_KEY = "masterhand.token"
const DEVICE_KEY = "masterhand.device"
const WORKSPACE_KEY = "masterhand.workspaceID"
const AUTO_ACCEPT_KEY = "masterhand.autoAcceptSessions"
const PREFERENCES_KEY = "masterhand.sessionPreferences"
const THEME_KEY = "masterhand.theme"
const PALETTE_KEY = "masterhand.palette"

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

export function loadWorkspaceID(): Promise<string | null> {
  return SecureStore.getItemAsync(WORKSPACE_KEY)
}

export function saveWorkspaceID(id: string): Promise<void> {
  return SecureStore.setItemAsync(WORKSPACE_KEY, id)
}

export function clearWorkspaceID(): Promise<void> {
  return SecureStore.deleteItemAsync(WORKSPACE_KEY)
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

/** Stored palette choice, or null when unset/corrupted (emerald decides). */
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

/** Clears the stored palette: the accent goes back to emerald. */
export function clearPalette(): Promise<void> {
  return SecureStore.deleteItemAsync(PALETTE_KEY)
}

export async function loadAutoAcceptSessions(): Promise<string[]> {
  const raw = await SecureStore.getItemAsync(AUTO_ACCEPT_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []
  } catch {
    return []
  }
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
