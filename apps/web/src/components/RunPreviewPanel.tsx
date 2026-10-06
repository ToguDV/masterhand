import { useEffect, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  isAmbiguousError,
  previewErrorMessage,
  queryKeys,
  useBffStatus,
  usePreview,
  useSessionRun,
  useWorkspaceRun,
  type PreviewStatus,
  type RunCandidate,
  type RunStatus,
} from "@masterhand/client-core"
import { client } from "../client"
import { SidePanel } from "./SidePanel"
import { ExternalLinkIcon } from "./icons"

const STOPPED_RUN: RunStatus = { status: "stopped", command: null, args: [], port: null, pid: null, error: null }
const STOPPED_PREVIEW: PreviewStatus = { status: "stopped", url: null, port: null, error: null }

type PanelTab = "run" | "preview"

/**
 * One control for one lifecycle (issue #97): the run command starts the dev
 * server on the session's reserved port and the preview is the tunnel that
 * exposes it, so they share a single trigger and a single panel with internal
 * tabs instead of two competing controls.
 */
export function RunPreviewTrigger({
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
  const statusQuery = useBffStatus(client)
  const previewEnabled = statusQuery.data?.preview?.enabled === true
  const runQuery = useSessionRun(client, sessionID, workspaceID)
  const previewQuery = usePreview(client, sessionID, previewEnabled)
  if (!workspaceID) return null

  const run = runQuery.data ?? STOPPED_RUN
  const preview = previewQuery.data ?? STOPPED_PREVIEW
  const running = run.status === "running" || (previewEnabled && preview.status === "running")
  const failed = run.status === "error" || (previewEnabled && preview.status === "error")

  return (
    <button
      type="button"
      onClick={onOpen}
      className={`mh-btn mh-btn--ghost ${className}`}
      aria-label="Run and preview"
    >
      <span
        aria-hidden="true"
        className={`mh-dot ${running ? "mh-dot--connected" : failed ? "mh-dot--danger" : ""}`}
      />
      Run &amp; preview
    </button>
  )
}

/** Internal tablist with arrow-key navigation (roving tabindex). */
function PanelTabs({
  tab,
  previewEnabled,
  onChange,
}: {
  tab: PanelTab
  previewEnabled: boolean
  onChange: (tab: PanelTab) => void
}) {
  const tabs: PanelTab[] = previewEnabled ? ["run", "preview"] : ["run"]

  function move(from: PanelTab, direction: 1 | -1): void {
    const index = tabs.indexOf(from)
    const next = tabs[(index + direction + tabs.length) % tabs.length]
    if (!next) return
    onChange(next)
    document.getElementById(`run-preview-tab-${next}`)?.focus()
  }

  return (
    <div role="tablist" aria-label="Run and preview" className="mh-tabindex px-3 pt-2">
      {tabs.map((value) => {
        const selected = tab === value
        return (
          <button
            key={value}
            type="button"
            role="tab"
            id={`run-preview-tab-${value}`}
            aria-selected={selected}
            aria-controls={`run-preview-tabpanel-${value}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight") {
                event.preventDefault()
                move(value, 1)
              } else if (event.key === "ArrowLeft") {
                event.preventDefault()
                move(value, -1)
              }
            }}
            className={`mh-tabindex__tab ${selected ? "is-active" : ""}`}
          >
            {value === "run" ? "Run" : "Preview"}
          </button>
        )
      })}
    </div>
  )
}

export function RunPreviewSheet({
  sessionID,
  workspaceID,
  onClose,
}: {
  sessionID: string
  workspaceID: string | null
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const statusQuery = useBffStatus(client)
  const previewEnabled = statusQuery.data?.preview?.enabled === true
  const availability = statusQuery.data?.preview
  const runQuery = useSessionRun(client, sessionID, workspaceID)
  const configQuery = useWorkspaceRun(client, workspaceID)
  const previewQuery = usePreview(client, sessionID, previewEnabled)

  const run = runQuery.data ?? STOPPED_RUN
  const preview = previewQuery.data ?? STOPPED_PREVIEW
  const previewKey = queryKeys.preview(sessionID)

  // Open on Preview when the tunnel is already running; otherwise on Run. The
  // choice is only made until the user picks a tab, and Start/Stop never
  // forces a switch.
  const [tab, setTab] = useState<PanelTab>(() =>
    previewQuery.data?.status === "running" ? "preview" : "run",
  )
  const tabTouched = useRef(false)
  useEffect(() => {
    if (tabTouched.current || !previewEnabled) return
    if (previewQuery.data?.status === "running") setTab("preview")
  }, [previewEnabled, previewQuery.data?.status])
  const selectTab = (value: PanelTab): void => {
    tabTouched.current = true
    setTab(value)
  }

  // Run tab state.
  const [runBusy, setRunBusy] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [runNotice, setRunNotice] = useState<string | null>(null)
  const previousRunStatus = useRef<RunStatus["status"]>("stopped")
  const [editing, setEditing] = useState(false)
  const [command, setCommand] = useState("")
  const [argsText, setArgsText] = useState("")
  const [detected, setDetected] = useState<RunCandidate | null>(null)

  // Preview tab state.
  const [previewBusy, setPreviewBusy] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewNotice, setPreviewNotice] = useState<string | null>(null)
  const previousPreviewStatus = useRef<PreviewStatus["status"]>("stopped")

  useEffect(() => {
    const before = previousRunStatus.current
    previousRunStatus.current = run.status
    if (before === "running" && run.status === "stopped") setRunNotice("The dev server stopped.")
    else if (before === "running" && run.status === "error") setRunNotice(run.error ?? "The dev server stopped.")
    else if (run.status === "running") setRunNotice(null)
  }, [run.status, run.error])

  useEffect(() => {
    const before = previousPreviewStatus.current
    previousPreviewStatus.current = preview.status
    if (before === "running" && preview.status === "error") {
      setPreviewNotice(preview.error ?? "The preview tunnel stopped.")
    } else if (before === "running" && preview.status === "stopped") {
      setPreviewNotice("The preview tunnel stopped.")
    } else if (preview.status === "running" || preview.status === "starting") {
      setPreviewNotice(null)
    }
  }, [preview.status, preview.error])

  if (!workspaceID) return null

  const config = configQuery.data ?? null
  const running = run.status === "running"
  const args = run.args.length > 0 ? run.args : (config?.args ?? [])
  const shownCommand = run.command ?? config?.command ?? null
  const unavailable = availability ? !availability.available : false
  const timedOut = previewQuery.timedOut && preview.status === "starting"
  const port = run.port ?? preview.port

  function openEditor() {
    setCommand(config?.command ?? "")
    setArgsText((config?.args ?? []).join("\n"))
    setRunError(null)
    setEditing(true)
  }

  /** Reconciles a start/stop whose response was lost against a fresh status. */
  async function reconcileRun(): Promise<RunStatus | null> {
    const fresh = await runQuery.refetch().catch(() => null)
    return fresh?.data ?? null
  }

  async function startRun() {
    setRunBusy(true)
    setRunError(null)
    setRunNotice(null)
    try {
      const next = await client.api.startSessionRun(sessionID, workspaceID!)
      queryClient.setQueryData(queryKeys.sessionRun(sessionID), next)
    } catch (startError) {
      // The start is not idempotent server-side (a PTY may have been created):
      // never report a hard failure without checking the live status first.
      const fresh = await reconcileRun()
      if (fresh?.status === "running" || fresh?.status === "starting") {
        setRunError(null)
      } else if (isAmbiguousError(startError)) {
        setRunError("The server did not answer in time — the run may still start. Check the status before retrying.")
      } else {
        setRunError("Could not start the run server. Check the command, then try again.")
      }
    } finally {
      setRunBusy(false)
    }
  }

  async function stopRun() {
    setRunBusy(true)
    setRunError(null)
    try {
      await client.api.stopSessionRun(sessionID, workspaceID!)
      queryClient.setQueryData(queryKeys.sessionRun(sessionID), STOPPED_RUN)
    } catch (stopError) {
      const fresh = await reconcileRun()
      if (fresh?.status === "stopped") {
        queryClient.setQueryData(queryKeys.sessionRun(sessionID), fresh)
      } else if (isAmbiguousError(stopError)) {
        setRunError("The server did not answer in time — the dev server may still be stopping. Check the status.")
      } else {
        setRunError("Could not stop the run server")
      }
    } finally {
      setRunBusy(false)
    }
  }

  async function save() {
    setRunBusy(true)
    setRunError(null)
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
      setRunError("Could not save the run command. Check the executable and arguments.")
    } finally {
      setRunBusy(false)
    }
  }

  async function detect() {
    setRunBusy(true)
    setRunError(null)
    try {
      setDetected(await client.api.detectRun(workspaceID!))
    } catch {
      setRunError("No valid .masterhand/run.json found in the workspace.")
    } finally {
      setRunBusy(false)
    }
  }

  async function applyDetected() {
    if (!detected) return
    setRunBusy(true)
    setRunError(null)
    try {
      const saved = await client.api.saveRun(workspaceID!, {
        command: detected.command,
        args: detected.args,
        cwd: detected.cwd,
      })
      queryClient.setQueryData(queryKeys.run(workspaceID), saved)
      setDetected(null)
    } catch {
      setRunError("Could not save the detected run command.")
    } finally {
      setRunBusy(false)
    }
  }

  async function reconcilePreview(): Promise<PreviewStatus | null> {
    const fresh = await previewQuery.refetch().catch(() => null)
    return fresh?.data ?? null
  }

  async function startPreview() {
    setPreviewBusy(true)
    setPreviewError(null)
    try {
      const next = await client.api.startPreview(sessionID)
      queryClient.setQueryData(previewKey, next)
    } catch (startError) {
      // The tunnel may already be starting (or up) after a lost response.
      const fresh = await reconcilePreview()
      if (fresh?.status === "running" || fresh?.status === "starting") {
        setPreviewError(null)
      } else if (isAmbiguousError(startError)) {
        setPreviewError("The server did not answer in time — the tunnel may still start. Check the status before retrying.")
      } else {
        setPreviewError(previewErrorMessage(startError))
      }
    } finally {
      setPreviewBusy(false)
    }
  }

  async function stopPreview() {
    setPreviewBusy(true)
    setPreviewError(null)
    try {
      await client.api.stopPreview(sessionID)
      queryClient.setQueryData(previewKey, STOPPED_PREVIEW)
    } catch (stopError) {
      const fresh = await reconcilePreview()
      if (fresh?.status === "stopped") {
        queryClient.setQueryData(previewKey, fresh)
      } else if (isAmbiguousError(stopError)) {
        setPreviewError("The server did not answer in time — the tunnel may still be stopping. Check the status.")
      } else {
        setPreviewError("Could not stop the preview")
      }
    } finally {
      setPreviewBusy(false)
    }
  }

  const actions =
    tab === "run" ? (
      <>
        {port !== null && <span className="mh-chip mh-chip--mono">port {port}</span>}
        {runBusy ? (
          <span className="text-xs text-ink-muted">Working…</span>
        ) : running ? (
          <button
            type="button"
            onClick={() => void stopRun()}
            aria-label="Stop run"
            className="mh-btn mh-btn--secondary mh-btn--sm"
          >
            Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void startRun()}
            disabled={!config}
            aria-label="Start run"
            className="mh-btn mh-btn--primary mh-btn--sm"
          >
            Start
          </button>
        )}
      </>
    ) : (
      <>
        {port !== null && <span className="mh-chip mh-chip--mono">port {port}</span>}
        {preview.status === "running" && preview.url && (
          <a
            href={preview.url}
            target="_blank"
            rel="noreferrer"
            aria-label="Open preview"
            className="mh-btn mh-btn--ghost mh-btn--sm"
          >
            Open
            <ExternalLinkIcon size={12} />
          </a>
        )}
        {previewBusy ? (
          <span className="text-xs text-ink-muted">Working…</span>
        ) : preview.status === "running" ? (
          <button
            type="button"
            onClick={() => void stopPreview()}
            aria-label="Stop preview"
            className="mh-btn mh-btn--secondary mh-btn--sm"
          >
            Stop
          </button>
        ) : unavailable ? null : (
          <button
            type="button"
            onClick={() => void startPreview()}
            aria-label="Start preview"
            className="mh-btn mh-btn--primary mh-btn--sm"
          >
            Start
          </button>
        )}
      </>
    )

  return (
    <SidePanel title="Run & preview" closeLabel="Close run and preview" onClose={onClose} actions={actions}>
      <PanelTabs tab={tab} previewEnabled={previewEnabled} onChange={selectTab} />

      <div
        role="tabpanel"
        id="run-preview-tabpanel-run"
        aria-labelledby="run-preview-tab-run"
        hidden={tab !== "run"}
      >
        {runError && (
          <p className="mh-banner mh-banner--danger" role="alert">
            {runError}
          </p>
        )}
        {!runError && (runNotice || (run.status === "error" && run.error)) && (
          <p className="mh-banner mh-banner--warning" role="status">
            {runNotice ?? run.error}
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
      </div>

      {previewEnabled && (
        <div
          role="tabpanel"
          id="run-preview-tabpanel-preview"
          aria-labelledby="run-preview-tab-preview"
          hidden={tab !== "preview"}
        >
          {previewError && (
            <p className="mh-banner mh-banner--danger" role="alert">
              {previewError}
            </p>
          )}
          {!previewError && (previewNotice || (preview.status === "error" && preview.error)) && (
            <p className="mh-banner mh-banner--warning" role="status">
              {previewNotice ?? preview.error}
            </p>
          )}

          <div className="min-h-[60vh] bg-white">
            {preview.status === "running" && preview.url ? (
              <iframe
                key={preview.url}
                src={preview.url}
                title="Session preview"
                className="h-[70vh] w-full border-0 md:h-[calc(100vh-3rem)]"
                sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-same-origin"
              />
            ) : (
              <div className="flex min-h-[60vh] items-center justify-center bg-canvas p-6 text-center text-sm text-ink-muted">
                {unavailable ? (
                  <span>
                    cloudflared is not available on the server. Install it, or run MasterHand with Docker (the image
                    bundles it).
                  </span>
                ) : preview.status === "error" ? (
                  <span>{preview.error ?? "The preview tunnel stopped."}</span>
                ) : timedOut ? (
                  <span>
                    The tunnel is taking longer than expected. Check the server logs, then retry the preview.
                  </span>
                ) : preview.status === "starting" ? (
                  "Starting the tunnel…"
                ) : (
                  <span>
                    Ask the agent to start the web server on port {preview.port ?? availability?.portRange.min ?? ""},
                    then press Start.
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </SidePanel>
  )
}
