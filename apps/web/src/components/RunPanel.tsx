import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  queryKeys,
  useSessionRun,
  useWorkspaceRun,
  type RunCandidate,
  type RunStatus,
} from "@masterhand/client-core"
import { client } from "../client"

const STOPPED: RunStatus = { status: "stopped", command: null, args: [], port: null, pid: null, error: null }

/**
 * Managed dev-server lifecycle: MasterHand starts the workspace's run command
 * through opencode and stops that exact process, so the agent never kills
 * anything. The command can come from `.masterhand/run.json` (proposed by the
 * agent) or be edited here.
 */
export function RunPanel({ sessionID, workspaceID }: { sessionID: string; workspaceID: string | null }) {
  const queryClient = useQueryClient()
  const runQuery = useSessionRun(client, sessionID, workspaceID)
  const configQuery = useWorkspaceRun(client, workspaceID)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [command, setCommand] = useState("")
  const [argsText, setArgsText] = useState("")
  const [detected, setDetected] = useState<RunCandidate | null>(null)

  if (!workspaceID) return null

  const run = runQuery.data ?? STOPPED
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

  async function start() {
    setBusy(true)
    setError(null)
    try {
      const next = await client.api.startSessionRun(sessionID, workspaceID!)
      queryClient.setQueryData(queryKeys.sessionRun(sessionID), next)
    } catch {
      setError("Could not start the run server. Check the command, then try again.")
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
    } catch {
      setError("Could not stop the run server")
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
    <>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1.5 rounded-lg border border-zinc-700 px-2.5 py-1 text-xs font-medium text-zinc-300 hover:bg-zinc-800"
      >
        <span
          aria-hidden="true"
          className={`h-1.5 w-1.5 rounded-full ${
            running ? "bg-emerald-400" : run.status === "error" ? "bg-red-400" : "bg-zinc-600"
          }`}
        />
        Run
      </button>

      {open && (
        <div className="fixed inset-0 z-30 flex flex-col bg-zinc-950 p-4 md:inset-auto md:left-1/2 md:top-1/4 md:h-auto md:w-[min(560px,80vw)] md:-translate-x-1/2 md:rounded-xl md:border md:border-zinc-800">
          <div className="flex items-center gap-2 border-b border-zinc-800 pb-2">
            <h2 className="text-sm font-medium text-zinc-200">Run server</h2>
            {run.port !== null && (
              <span className="rounded bg-zinc-900 px-1.5 py-0.5 text-[11px] text-zinc-400">port {run.port}</span>
            )}
            <span className="flex-1" />
            {busy ? (
              <span className="text-xs text-zinc-500">Working…</span>
            ) : running ? (
              <button
                type="button"
                onClick={() => void stop()}
                className="rounded-lg border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
              >
                Stop
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void start()}
                disabled={!config}
                className="rounded-lg border border-indigo-500/40 bg-indigo-500/10 px-2.5 py-1 text-xs font-medium text-indigo-200 hover:bg-indigo-500/20 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Start
              </button>
            )}
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close run panel"
              className="rounded-lg px-2 py-1 text-zinc-400 hover:bg-zinc-800"
            >
              ✕
            </button>
          </div>

          {error && <p className="border-b border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</p>}

          <div className="flex flex-col gap-3 py-3 text-sm">
            {shownCommand ? (
              <p className="break-all rounded-lg bg-zinc-900 px-3 py-2 font-mono text-xs text-zinc-300">
                {shownCommand} {args.join(" ")}
              </p>
            ) : (
              <p className="text-zinc-500">
                No run command configured. Let the agent declare <code>.masterhand/run.json</code>, or edit it here.
              </p>
            )}

            {detected && (
              <div className="flex flex-col gap-2 rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-3 py-2">
                <p className="text-xs text-indigo-200">
                  Detected in <code>.masterhand/run.json</code>:
                </p>
                <p className="break-all font-mono text-xs text-indigo-100">
                  {detected.command} {detected.args.join(" ")}
                </p>
                <button
                  type="button"
                  onClick={() => void applyDetected()}
                  className="self-start rounded-lg border border-indigo-500/40 px-2.5 py-1 text-xs font-medium text-indigo-200 hover:bg-indigo-500/20"
                >
                  Apply
                </button>
              </div>
            )}

            {editing ? (
              <div className="flex flex-col gap-2">
                <label className="flex flex-col gap-1 text-xs text-zinc-400">
                  Executable (argv, no shell)
                  <input
                    value={command}
                    onChange={(event) => setCommand(event.target.value)}
                    placeholder="npm"
                    className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-mono text-xs text-zinc-200"
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs text-zinc-400">
                  Arguments (one per line; <code>{"{port}"}</code> is replaced by the reserved port)
                  <textarea
                    value={argsText}
                    onChange={(event) => setArgsText(event.target.value)}
                    rows={5}
                    placeholder={"run\ndev\n--\n--host\n0.0.0.0\n--port\n{port}"}
                    className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-mono text-xs text-zinc-200"
                  />
                </label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => void save()}
                    className="rounded-lg border border-indigo-500/40 bg-indigo-500/10 px-2.5 py-1 text-xs font-medium text-indigo-200 hover:bg-indigo-500/20"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditing(false)}
                    className="rounded-lg border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={openEditor}
                  className="rounded-lg border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
                >
                  Edit command
                </button>
                <button
                  type="button"
                  onClick={() => void detect()}
                  className="rounded-lg border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
                >
                  Detect from .masterhand/run.json
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
