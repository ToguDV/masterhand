import { useEffect, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  isAmbiguousError,
  previewErrorMessage,
  queryKeys,
  useBffStatus,
  usePreview,
  type PreviewStatus,
} from "@masterhand/client-core"
import { client } from "../client"
import { SidePanel } from "./SidePanel"
import { ExternalLinkIcon } from "./icons"

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
  // The tunnel dying while the panel is open must surface, not keep claiming
  // "running" with a blank iframe (#89).
  const [notice, setNotice] = useState<string | null>(null)
  const previousStatus = useRef<PreviewStatus["status"]>("stopped")

  const availability = statusQuery.data?.preview
  const preview = previewQuery.data ?? STOPPED
  const key = queryKeys.preview(sessionID)

  useEffect(() => {
    const before = previousStatus.current
    previousStatus.current = preview.status
    if (before === "running" && preview.status === "error") {
      setNotice(preview.error ?? "The preview tunnel stopped.")
    } else if (before === "running" && preview.status === "stopped") {
      setNotice("The preview tunnel stopped.")
    } else if (preview.status === "running" || preview.status === "starting") {
      setNotice(null)
    }
  }, [preview.status, preview.error])

  if (!availability || !availability.enabled) return null
  const unavailable = !availability.available
  const timedOut = previewQuery.timedOut && preview.status === "starting"

  /** Reconciles a start/stop whose response was lost against a fresh status. */
  async function reconcile(): Promise<PreviewStatus | null> {
    const fresh = await previewQuery.refetch().catch(() => null)
    return fresh?.data ?? null
  }

  async function start() {
    setBusy(true)
    setError(null)
    try {
      const next = await client.api.startPreview(sessionID)
      queryClient.setQueryData(key, next)
    } catch (startError) {
      // The tunnel may already be starting (or up) after a lost response.
      const fresh = await reconcile()
      if (fresh?.status === "running" || fresh?.status === "starting") {
        setError(null)
      } else if (isAmbiguousError(startError)) {
        setError("The server did not answer in time — the tunnel may still start. Check the status before retrying.")
      } else {
        setError(previewErrorMessage(startError))
      }
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
    } catch (stopError) {
      const fresh = await reconcile()
      if (fresh?.status === "stopped") {
        queryClient.setQueryData(key, fresh)
      } else if (isAmbiguousError(stopError)) {
        setError("The server did not answer in time — the tunnel may still be stopping. Check the status.")
      } else {
        setError("Could not stop the preview")
      }
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
              Open
              <ExternalLinkIcon size={12} />
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
      {!error && (notice || (preview.status === "error" && preview.error)) && (
        <p className="mh-banner mh-banner--warning" role="status">
          {notice ?? preview.error}
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
