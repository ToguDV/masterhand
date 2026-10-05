import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { previewErrorMessage, queryKeys, useBffStatus, usePreview, type PreviewStatus } from "@masterhand/client-core"
import { client } from "../client"
import { SidePanel } from "./SidePanel"

const STOPPED: PreviewStatus = { status: "stopped", url: null, port: null, error: null }

export function PreviewTrigger({ sessionID, onOpen, className = "" }: { sessionID: string; onOpen: () => void; className?: string }) {
  const statusQuery = useBffStatus(client)
  const availability = statusQuery.data?.preview
  const previewQuery = usePreview(client, sessionID, availability?.enabled === true)
  if (!availability || !availability.enabled) return null
  const preview = previewQuery.data ?? STOPPED

  return (
    <button type="button" onClick={onOpen} className={`mh-btn mh-btn--ghost ${className}`}>
      <span
        aria-hidden="true"
        className={`mh-dot ${
          preview.status === "running" ? "mh-dot--connected" : preview.status === "error" ? "mh-dot--danger" : ""
        }`}
      />
      Preview
    </button>
  )
}

export function PreviewSheet({ sessionID, onClose }: { sessionID: string; onClose: () => void }) {
  const queryClient = useQueryClient()
  const statusQuery = useBffStatus(client)
  const previewQuery = usePreview(client, sessionID, statusQuery.data?.preview?.enabled === true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const availability = statusQuery.data?.preview
  const preview = previewQuery.data ?? STOPPED
  const key = queryKeys.preview(sessionID)

  if (!availability || !availability.enabled) return null
  const unavailable = !availability.available

  async function start() {
    setBusy(true)
    setError(null)
    try {
      const next = await client.api.startPreview(sessionID)
      queryClient.setQueryData(key, next)
    } catch (startError) {
      setError(previewErrorMessage(startError))
    } finally {
      setBusy(false)
    }
  }

  async function stop() {
    setBusy(true)
    setError(null)
    try {
      await client.api.stopPreview(sessionID)
      queryClient.setQueryData(key, STOPPED)
    } catch {
      setError("Could not stop the preview")
    } finally {
      setBusy(false)
    }
  }

  return (
    <SidePanel
      title="Preview"
      closeLabel="Close preview"
      onClose={onClose}
      actions={
        <>
          {preview.port !== null && <span className="mh-chip mh-chip--mono">port {preview.port}</span>}
          {preview.status === "running" && preview.url && (
            <a href={preview.url} target="_blank" rel="noreferrer" className="mh-btn mh-btn--ghost mh-btn--sm">
              Open ↗
            </a>
          )}
          {busy ? (
            <span className="text-xs text-ink-muted">Working…</span>
          ) : preview.status === "running" ? (
            <button type="button" onClick={() => void stop()} className="mh-btn mh-btn--secondary mh-btn--sm">
              Stop
            </button>
          ) : unavailable ? null : (
            <button type="button" onClick={() => void start()} className="mh-btn mh-btn--primary mh-btn--sm">
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
            ) : preview.status === "starting" ? (
              "Starting the tunnel…"
            ) : (
              <span>
                Ask the agent to start the web server on port {preview.port ?? availability.portRange.min}, then press
                Start.
              </span>
            )}
          </div>
        )}
      </div>
    </SidePanel>
  )
}
