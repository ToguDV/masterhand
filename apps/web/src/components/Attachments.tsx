import { useState } from "react"
import { formatFileSize, type ChatAttachment, type UploadedAttachment } from "@masterhand/client-core"
import { client } from "../client"
import { DownloadIcon, FileIcon, XIcon } from "./icons"

/** A file staged in the composer, before/while it is uploaded on Send. */
export interface ComposerAttachment {
  id: string
  file: File
  name: string
  mime: string
  size: number
  previewUrl?: string
  status: "ready" | "uploading" | "error"
  error?: string
  uploaded?: UploadedAttachment
}

/** One staged attachment: thumbnail (images) or glyph, name, size, remove. */
export function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: ComposerAttachment
  onRemove: (id: string) => void
}) {
  const status = attachment.status === "uploading" ? "Uploading…" : attachment.error ?? formatFileSize(attachment.size)
  return (
    <div className={`mh-attachment${attachment.status === "error" ? " is-error" : ""}`}>
      {attachment.previewUrl ? (
        <img className="mh-attachment__thumb" src={attachment.previewUrl} alt="" />
      ) : (
        <span className="mh-attachment__glyph">
          <FileIcon size={16} />
        </span>
      )}
      <span className="mh-attachment__text">
        <span className="mh-attachment__name" title={attachment.name}>
          {attachment.name}
        </span>
        <span className="mh-attachment__meta" title={status}>
          {status}
        </span>
      </span>
      {attachment.status === "uploading" ? <span className="mh-attachment__spinner" aria-hidden="true" /> : null}
      <button
        type="button"
        className="mh-attachment__remove"
        onClick={() => onRemove(attachment.id)}
        aria-label={`Remove ${attachment.name}`}
        title="Remove attachment"
      >
        <XIcon size={13} />
      </button>
    </div>
  )
}

/** Attachments rendered in the user's history bubble. */
export function AttachmentList({ attachments }: { attachments: readonly ChatAttachment[] }) {
  const [error, setError] = useState<string | null>(null)

  async function download(attachment: ChatAttachment): Promise<void> {
    if (!attachment.url) return
    setError(null)
    try {
      const blob = await client.api.attachments.download(attachment.url)
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = attachment.name
      anchor.rel = "noreferrer"
      anchor.click()
      setTimeout(() => URL.revokeObjectURL(url), 1_000)
    } catch {
      setError(`Could not download ${attachment.name}.`)
    }
  }

  return (
    <div className="mh-attachments">
      {attachments.map((attachment) => (
        <div className="mh-attachment" key={attachment.id}>
          {attachment.previewDataUrl ? (
            <img
              className="mh-attachment__thumb"
              src={attachment.previewDataUrl}
              alt={attachment.name}
              loading="lazy"
            />
          ) : (
            <span className="mh-attachment__glyph">
              <FileIcon size={16} />
            </span>
          )}
          <span className="mh-attachment__text">
            <span className="mh-attachment__name" title={attachment.name}>
              {attachment.name}
            </span>
            <span className="mh-attachment__meta">
              {attachment.size > 0 ? formatFileSize(attachment.size) : attachment.mime}
            </span>
          </span>
          {attachment.url ? (
            <button
              type="button"
              className="mh-attachment__remove"
              onClick={() => void download(attachment)}
              aria-label={`Download ${attachment.name}`}
              title="Download attachment"
            >
              <DownloadIcon size={14} />
            </button>
          ) : null}
        </div>
      ))}
      {error ? <p className="mh-attachment__error">{error}</p> : null}
    </div>
  )
}
