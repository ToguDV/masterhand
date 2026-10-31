import {
  agentActivityKindEnabled,
  decideAgentActivity,
  type AgentActivityDecision,
  type AgentActivityKind,
  type AgentActivitySession,
} from "@masterhand/client-core"
import type { NotificationPreferences } from "./notifications"

/** Same copy as mobile so the platforms stay recognizable. */
export const AGENT_NOTIFICATION_TITLES: Record<AgentActivityKind, string> = {
  finished: "Agent finished",
  failed: "Agent failed",
  permission: "Permission needed",
  question: "Question waiting",
}

export interface AgentActivityObserverOptions {
  /** False while the window is focused: in-app banners already cover it. */
  isActive: () => boolean
  /** Live preferences (master switch + per-kind switches). */
  preferences: () => NotificationPreferences
  sessions: () => readonly AgentActivitySession[]
  notify: (decision: AgentActivityDecision) => void
  /** A new turn supersedes the previous finished/failed banner. */
  dismissSession?: (sessionID: string) => void
}

export interface AgentActivityObserver {
  observe: (event: unknown) => void
  /** Seeds the busy set from a statuses() snapshot (page loaded mid-run). */
  markBusy: (sessionID: string) => void
  isBusy: (sessionID: string) => boolean
}

/**
 * Tracks busy sessions and turns SSE frames into notification decisions.
 * Platform-free on purpose (the Notification API stays in `notifications.ts`)
 * so the whole gating matrix is unit-testable.
 */
export function createAgentActivityObserver(
  options: AgentActivityObserverOptions,
): AgentActivityObserver {
  const busy = new Set<string>()
  const notifiedPermissions = new Set<string>()
  const notifiedForms = new Set<string>()

  function sessionOf(sessionID: string): AgentActivitySession | null {
    return options.sessions().find((session) => session.id === sessionID) ?? null
  }

  return {
    observe(raw) {
      if (!raw || typeof raw !== "object") return
      const event = raw as { type?: unknown; data?: Record<string, unknown> }
      const type = typeof event.type === "string" ? event.type : ""
      if (!type) return
      const data = (event.data ?? {}) as Record<string, unknown>
      const form = data.form as { id?: unknown; sessionID?: unknown; metadata?: { kind?: string } } | undefined
      const sessionID =
        (typeof data.sessionID === "string" && data.sessionID) ||
        (typeof form?.sessionID === "string" && form.sessionID) ||
        ""

      if (type === "session.execution.started") {
        if (!sessionID) return
        busy.add(sessionID)
        options.dismissSession?.(sessionID)
        return
      }
      if (type === "session.status") {
        const status = data.status as { type?: string } | string | undefined
        const kind = typeof status === "string" ? status : status?.type
        if (sessionID && kind === "busy") busy.add(sessionID)
        return
      }
      if (type === "session.execution.interrupted") {
        if (sessionID) busy.delete(sessionID)
        return
      }
      if (type === "permission.replied") {
        const requestID = typeof data.requestID === "string" ? data.requestID : ""
        if (requestID) notifiedPermissions.delete(requestID)
        return
      }
      if (type === "form.replied" || type === "form.cancelled") {
        const formID =
          (typeof data.id === "string" && data.id) ||
          (typeof form?.id === "string" && form.id) ||
          ""
        if (formID) notifiedForms.delete(formID)
        return
      }
      if (
        type !== "session.idle" &&
        type !== "session.execution.succeeded" &&
        type !== "session.execution.failed" &&
        type !== "permission.asked" &&
        type !== "form.created"
      ) {
        return
      }

      const session = sessionID ? sessionOf(sessionID) : null
      const wasBusy = sessionID ? busy.has(sessionID) : false
      if (
        type === "session.idle" ||
        type === "session.execution.succeeded" ||
        type === "session.execution.failed"
      ) {
        if (sessionID) busy.delete(sessionID)
      }

      const preferences = options.preferences()
      if (!preferences.enabled || options.isActive()) return

      const permissionID =
        type === "permission.asked"
          ? (typeof data.id === "string" && data.id) ||
            (typeof data.requestID === "string" && data.requestID) ||
            ""
          : ""
      if (permissionID && notifiedPermissions.has(permissionID)) return
      const formID =
        type === "form.created" && typeof form?.id === "string" ? form.id : ""
      if (formID && notifiedForms.has(formID)) return

      const decision = decideAgentActivity(
        {
          type,
          data: {
            ...(sessionID ? { sessionID } : {}),
            ...(permissionID ? { id: permissionID } : {}),
            ...(type === "form.created"
              ? { form: { ...(formID ? { id: formID } : {}), metadata: form?.metadata } }
              : {}),
          },
        },
        {
          isAppActive: false,
          wasBusy,
          session: session ?? (sessionID ? { id: sessionID } : null),
          alreadyNotified: Boolean(
            (permissionID && notifiedPermissions.has(permissionID)) ||
              (formID && notifiedForms.has(formID)),
          ),
        },
      )
      if (!decision) return
      if (!agentActivityKindEnabled(preferences.kinds, decision.kind)) return

      if (decision.kind === "permission" && decision.permissionID) {
        notifiedPermissions.add(decision.permissionID)
      }
      if (decision.kind === "question" && decision.formID) {
        notifiedForms.add(decision.formID)
      }
      options.notify(decision)
    },

    markBusy(sessionID) {
      if (sessionID) busy.add(sessionID)
    },

    isBusy(sessionID) {
      return busy.has(sessionID)
    },
  }
}

/** True only while the window is visible and focused. */
export function isWindowActive(): boolean {
  return document.visibilityState === "visible" && document.hasFocus()
}
