import { useEffect, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  isAmbiguousError,
  queryKeys,
  useSessionRun,
  useWorkspaceRun,
  type RunCandidate,
  type RunStatus,
} from "@masterhand/client-core"
import { client } from "../client"
import { SidePanel } from "./SidePanel"

const STOPPED: RunStatus = { status: "stopped", command: null, args: [], port: null, pid: null, error: null }

/**
 * Managed dev-server lifecycle: MasterHand starts the workspace's run command
 * through opencode and stops that exact process, so the agent never kills
 * anything. The command can come from `.masterhand/run.json` (proposed by the
 * agent) or be edited here.
 */
export function RunTrigger({
  sessionID,
  workspaceID,
  onOpen,
  className = "",
}: {
  sessionID: string
  workspaceID: string | null
  onOpen: () => void
  className?: string
}) {
  const runQuery = useSessionRun(client, sessionID, workspaceID)
  if (!workspaceID) return null
  const run = runQuery.data ?? STOPPED
  const running = run.status === "running"

  return (
    <button type="button" onClick={onOpen} className={`mh-btn mh-btn--ghost ${className}`}>
      <span
        aria-hidden="true"
        className={`mh-dot ${running ? "mh-dot--connected" : run.status === "error" ? "mh-dot--danger" : ""}`}
      />
      Run
    </button>
  )
}

export function RunSheet({
  sessionID,
  workspaceID,
  onClose,
}: {
  sessionID: string
  workspaceID: string | null
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const runQuery = useSessionRun(client, sessionID, workspaceID)
  const configQuery = useWorkspaceRun(client, workspaceID)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A run that dies on its own (crashed dev server, killed PTY) must not keep
  // showing "running" until the next manual action (#89).
  const [notice, setNotice] = useState<string | null>(null)
  const previousStatus = useRef<RunStatus["status"]>("stopped")
  const [editing, setEditing] = useState(false)
  const [command, setCommand] = useState("")
  const [argsText, setArgsText] = useState("")
  const [detected, setDetected] = useState<RunCandidate | null>(null)

  const run = runQuery.data ?? STOPPED

  useEffect(() => {
    const before = previousStatus.current
    previousStatus.current = run.status
    if (before === "running" && run.status === "stopped") setNotice("The dev server stopped.")
    else if (before === "running" && run.status === "error") setNotice(run.error ?? "The dev server stopped.")
    else if (run.status === "running") setNotice(null)
  }, [run.status, run.error])

  if (!workspaceID) return null

  const config = configQuery.data ?? null
  const running = run.status === "running"
  const args = run.args.length > 0 ? run.args : (config?.args ?? [])
  const shownCommand = run.command ?? config?.command ?? null

  function openEditor() {
    setCommand(config?.command ?? "")
    setArgsText((config?.args ?? []).join("\n"))
    setError(null)
    setEditing(true)
  }

  /** Reconciles a start/stop whose response was lost against a fresh status. */
  async function reconcile(): Promise<RunStatus | null> {
    const fresh = await runQuery.refetch().catch(() => null)
    return fresh?.data ?? null
  }

  async function start() {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const next = await client.api.startSessionRun(sessionID, workspaceID!)
      queryClient.setQueryData(queryKeys.sessionRun(sessionID), next)
    } catch (startError) {
      // The start is not idempotent server-side (a PTY may have been created):
      // never report a hard failure without checking the live status first.
      const fresh = await reconcile()
      if (fresh?.status === "running" || fresh?.status === "starting") {
        setError(null)
      } else if (isAmbiguousError(startError)) {
        setError("The server did not answer in time — the run may still start. Check the status before retrying.")
      } else {
        setError("Could not start the run server. Check the command, then try again.")
      }
    } finally {
      setBusy(false)
    }
  }

  async function stop() {
    setBusy(true)
    setError(null)
    try {
      await client.api.stopSessionRun(sessionID, workspaceID!)
      queryClient.setQueryData(queryKeys.sessionRun(sessionID), STOPPED)
    } catch (stopError) {
      const fresh = await reconcile()
      if (fresh?.status === "stopped") {
        queryClient.setQueryData(queryKeys.sessionRun(sessionID), fresh)
      } else if (isAmbiguousError(stopError)) {
        setError("The server did not answer in time — the dev server may still be stopping. Check the status.")
      } else {
        setError("Could not stop the run server")
      }
    } finally {
      setBusy(false)
    }
  }

  async function save() {
    setBusy(true)
    setError(null)
    try {
      const saved = await client.api.saveRun(workspaceID!, {
        command: command.trim(),
        args: argsText
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
      })
      queryClient.setQueryData(queryKeys.run(workspaceID), saved)
      setEditing(false)
    } catch {
      setError("Could not save the run command. Check the executable and arguments.")
    } finally {
      setBusy(false)
    }
  }

  async function detect() {
    setBusy(true)
    setError(null)
    try {
      setDetected(await client.api.detectRun(workspaceID!))
    } catch {
      setError("No valid .masterhand/run.json found in the workspace.")
    } finally {
      setBusy(false)
    }
  }

  async function applyDetected() {
    if (!detected) return
    setBusy(true)
    setError(null)
    try {
      const saved = await client.api.saveRun(workspaceID!, {
        command: detected.command,
        args: detected.args,
        cwd: detected.cwd,
      })
      queryClient.setQueryData(queryKeys.run(workspaceID), saved)
      setDetected(null)
    } catch {
      setError("Could not save the detected run command.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <SidePanel
      title="Run server"
      closeLabel="Close run panel"
      onClose={onClose}
      actions={
        <>
          {run.port !== null && <span className="mh-chip mh-chip--mono">port {run.port}</span>}
          {busy ? (
            <span className="text-xs text-ink-muted">Working…</span>
          ) : running ? (
            <button type="button" onClick={() => void stop()} className="mh-btn mh-btn--secondary mh-btn--sm">
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void start()}
              disabled={!config}
              className="mh-btn mh-btn--primary mh-btn--sm"
            >
              Start
            </button>
          )}
        </>
      }
    >
      {error && (
        <p className="mh-banner mh-banner--danger" role="alert">
          {error}
        </p>
      )}
      {!error && (notice || (run.status === "error" && run.error)) && (
        <p className="mh-banner mh-banner--warning" role="status">
          {notice ?? run.error}
        </p>
      )}

      <div className="flex flex-col gap-3 p-3 text-sm">
        {shownCommand ? (
          <div className="mh-code">
            <p className="break-all px-3 py-2 font-mono text-xs text-code-text">
              {shownCommand} {args.join(" ")}
            </p>
          </div>
        ) : (
          <p className="text-ink-muted">
            No run command configured. Let the agent declare <code className="mh-mono-sm">.masterhand/run.json</code>,
            or edit it here.
          </p>
        )}

        {detected && (
          <div className="flex flex-col gap-2 rounded-md border border-accent-line bg-accent-soft px-3 py-2">
            <p className="text-xs text-accent">
              Detected in <code className="mh-mono-sm">.masterhand/run.json</code>:
            </p>
            <p className="break-all font-mono text-xs text-accent">
              {detected.command} {detected.args.join(" ")}
            </p>
            <button
              type="button"
              onClick={() => void applyDetected()}
              className="mh-btn mh-btn--secondary mh-btn--sm self-start"
            >
              Apply
            </button>
          </div>
        )}

        {editing ? (
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-xs text-ink-muted">
              Executable (argv, no shell)
              <input
                value={command}
                onChange={(event) => setCommand(event.target.value)}
                placeholder="npm"
                className="mh-input font-mono text-xs"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-ink-muted">
              Arguments (one per line; <code className="mh-mono-sm">{"{port}"}</code> is replaced by the reserved
              port)
              <textarea
                value={argsText}
                onChange={(event) => setArgsText(event.target.value)}
                rows={5}
                placeholder={"run\ndev\n--\n--host\n0.0.0.0\n--port\n{port}"}
                className="mh-textarea font-mono text-xs"
              />
            </label>
            <div className="flex gap-2">
              <button type="button" onClick={() => void save()} className="mh-btn mh-btn--primary mh-btn--sm">
                Save
              </button>
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="mh-btn mh-btn--secondary mh-btn--sm"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={openEditor} className="mh-btn mh-btn--secondary mh-btn--sm">
              Edit command
            </button>
            <button type="button" onClick={() => void detect()} className="mh-btn mh-btn--secondary mh-btn--sm">
              Detect from .masterhand/run.json
            </button>
          </div>
        )}
      </div>
    </SidePanel>
  )
}
