import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { previewErrorMessage, queryKeys, useBffStatus, usePreview, type PreviewStatus } from "@masterhand/client-core"
import { client } from "../client"

const STOPPED: PreviewStatus = { status: "stopped", url: null, port: null, error: null }

export function PreviewPanel({ sessionID }: { sessionID: string }) {
  const queryClient = useQueryClient()
  const statusQuery = useBffStatus(client)
  const previewQuery = usePreview(client, sessionID, statusQuery.data?.preview?.enabled === true)
  const [open, setOpen] = useState(false)
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
    <>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1.5 rounded-lg border border-zinc-700 px-2.5 py-1 text-xs font-medium text-zinc-300 hover:bg-zinc-800"
      >
        <span
          aria-hidden="true"
          className={`h-1.5 w-1.5 rounded-full ${
            preview.status === "running"
              ? "bg-emerald-400"
              : preview.status === "error"
                ? "bg-red-400"
                : "bg-zinc-600"
          }`}
        />
        Preview
      </button>

      {open && (
        <div className="fixed inset-0 z-30 flex flex-col bg-zinc-950 md:inset-auto md:right-0 md:top-0 md:h-full md:w-[min(560px,60vw)] md:border-l md:border-zinc-800">
          <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
            <h2 className="text-sm font-medium text-zinc-200">Preview</h2>
            {preview.port !== null && (
              <span className="rounded bg-zinc-900 px-1.5 py-0.5 text-[11px] text-zinc-400">
                port {preview.port}
              </span>
            )}
            {preview.status === "running" && preview.url && (
              <a
                href={preview.url}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-indigo-400 hover:underline"
              >
                Open ↗
              </a>
            )}
            <span className="flex-1" />
            {busy ? (
              <span className="text-xs text-zinc-500">Working…</span>
            ) : preview.status === "running" ? (
              <button
                type="button"
                onClick={() => void stop()}
                className="rounded-lg border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
              >
                Stop
              </button>
            ) : unavailable ? null : (
              <button
                type="button"
                onClick={() => void start()}
                className="rounded-lg border border-indigo-500/40 bg-indigo-500/10 px-2.5 py-1 text-xs font-medium text-indigo-200 hover:bg-indigo-500/20"
              >
                Start
              </button>
            )}
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close preview"
              className="rounded-lg px-2 py-1 text-zinc-400 hover:bg-zinc-800"
            >
              ✕
            </button>
          </div>

          {error && <p className="border-b border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</p>}

          <div className="min-h-0 flex-1 bg-white">
            {preview.status === "running" && preview.url ? (
              <iframe
                key={preview.url}
                src={preview.url}
                title="Session preview"
                className="h-full w-full border-0"
                sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-same-origin"
              />
            ) : (
              <div className="flex h-full items-center justify-center bg-zinc-950 p-6 text-center text-sm text-zinc-500">
                {unavailable ? (
                  <span>
                    cloudflared is not available on the server. Install it, or run MasterHand with Docker (the image
                    bundles it).
                  </span>
                ) : preview.status === "starting" ? (
                  "Starting the tunnel…"
                ) : (
                  <span>
                    Ask the agent to start the web server on port {preview.port ?? availability.portRange.min}, then
                    press Start.
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
