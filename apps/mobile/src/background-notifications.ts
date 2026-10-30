import * as BackgroundTask from "expo-background-task"
import * as TaskManager from "expo-task-manager"
import { createClient } from "@masterhand/client-core"
import {
  loadBusySnapshot,
  loadNotificationsEnabled,
  loadServerRegistry,
  loadServerToken,
  saveBusySnapshot,
  type BusySnapshot,
} from "./storage"
import { notifyAgentActivity } from "./notifications"

/** WorkManager task name (single worker for the app). */
export const AGENT_ACTIVITY_TASK = "masterhand-agent-activity"
/** Maximum local notifications per background run (spam guard). */
export const MAX_BACKGROUND_NOTIFICATIONS = 5

/** Sessions in `previous` that are no longer busy. */
export function diffBusySnapshots(previous: BusySnapshot, currentBusy: Set<string>): string[] {
  return Object.keys(previous).filter((sessionID) => !currentBusy.has(sessionID))
}

interface ReconcileInput {
  enabled: boolean
  previous: BusySnapshot
  currentBusy: Set<string>
  titles: Record<string, { title: string; workspaceID?: string }>
  profile: { id: string }
  notify: (entry: { profileID: string; sessionID: string; title: string; workspaceID?: string }) => Promise<void>
  save: (snapshot: BusySnapshot) => Promise<void>
}

/**
 * Pure reconcile step (Jest-safe): notifies finished sessions, then persists
 * the new busy baseline. Never throws; notification failures are swallowed by
 * the caller-provided `notify`.
 */
export async function reconcileBusySnapshots(input: ReconcileInput): Promise<{ notified: string[] }> {
  if (!input.enabled) return { notified: [] }
  const finished = diffBusySnapshots(input.previous, input.currentBusy).slice(
    0,
    MAX_BACKGROUND_NOTIFICATIONS,
  )
  const notified: string[] = []
  for (const sessionID of finished) {
    const entry = input.previous[sessionID]
    if (!entry) continue
    try {
      await input.notify({
        profileID: input.profile.id,
        sessionID,
        title: entry.title,
        ...(entry.workspaceID ? { workspaceID: entry.workspaceID } : {}),
      })
      notified.push(sessionID)
    } catch {
      // Best-effort: one failed notification must not block the rest.
    }
  }
  const next: BusySnapshot = {}
  for (const sessionID of input.currentBusy) {
    const known = input.titles[sessionID] ?? input.previous[sessionID]
    next[sessionID] = {
      title: known?.title ?? sessionID,
      ...(known?.workspaceID ? { workspaceID: known.workspaceID } : {}),
    }
  }
  try {
    await input.save(next)
  } catch {
    // Storage failures must never crash the background task.
  }
  return { notified }
}

/**
 * Background run: active profile + token + statuses, then reconcile. All
 * failures are best-effort (returns empty, never throws) so WorkManager keeps
 * the schedule alive.
 */
export async function checkAgentActivityInBackground(): Promise<{ notified: string[] }> {
  try {
    if (!(await loadNotificationsEnabled())) return { notified: [] }
    const registry = await loadServerRegistry().catch(() => null)
    const activeID = registry?.activeID ?? null
    const profile = registry?.profiles.find((item) => item.id === activeID) ?? null
    if (!profile || !activeID) return { notified: [] }
    const token = await loadServerToken(profile.id).catch(() => null)
    if (!token) return { notified: [] }
    const client = createClient({
      baseUrl: profile.url,
      getToken: () => token,
      fetchImpl: fetch as unknown as typeof fetch,
      timeoutMs: 15_000,
    })
    const statuses = await client.api.statuses().catch(() => null)
    if (!statuses) return { notified: [] }
    const currentBusy = new Set(
      Object.entries(statuses)
        .filter(([, status]) => (status as { type?: string }).type === "busy")
        .map(([sessionID]) => sessionID),
    )
    const previous = await loadBusySnapshot(profile.id).catch(() => ({} as BusySnapshot))
    // Titles for new baselines: best-effort session listing across workspaces.
    const titles: Record<string, { title: string; workspaceID?: string }> = {}
    try {
      const workspaces = await client.workspaces.list().catch(() => [])
      for (const workspace of workspaces.slice(0, 10)) {
        if (currentBusy.size === 0) break
        const page = await client.api.sessions.list(workspace.id).catch(() => null)
        const sessions = (page as { sessions?: Array<{ id: string; title?: string }> } | null)?.sessions ?? []
        for (const session of sessions) {
          if (!currentBusy.has(session.id)) continue
          if (titles[session.id]) continue
          titles[session.id] = {
            title: typeof session.title === "string" && session.title ? session.title : session.id,
            workspaceID: workspace.id,
          }
        }
        if (Object.keys(titles).length >= currentBusy.size) break
      }
    } catch {
      // Titles stay best-effort: IDs are better than no baseline.
    }
    return reconcileBusySnapshots({
      enabled: true,
      previous,
      currentBusy,
      titles,
      profile: { id: profile.id },
      notify: async (entry) =>
        void (await notifyAgentActivity({
          title: "Agent finished",
          body: entry.title,
          data: {
            profileID: entry.profileID,
            sessionID: entry.sessionID,
            kind: "finished",
            ...(entry.workspaceID ? { workspaceID: entry.workspaceID } : {}),
          },
        })),
      save: (snapshot) => saveBusySnapshot(profile.id, snapshot),
    })
  } catch {
    return { notified: [] }
  }
}

/** Registers the periodic WorkManager task (minimum 15 min on Android). */
export async function registerAgentActivityTask(): Promise<void> {
  try {
    const registered = await TaskManager.isTaskRegisteredAsync(AGENT_ACTIVITY_TASK).catch(() => false)
    if (registered) return
    await BackgroundTask.registerTaskAsync(AGENT_ACTIVITY_TASK, { minimumInterval: 15 })
  } catch {
    // Best-effort: foreground SSE notifications still work without it.
  }
}

/** Unregisters the periodic task (notifications off / sign-out). */
export async function unregisterAgentActivityTask(): Promise<void> {
  try {
    await BackgroundTask.unregisterTaskAsync(AGENT_ACTIVITY_TASK).catch(() => {})
  } catch {
    // Best-effort.
  }
}
