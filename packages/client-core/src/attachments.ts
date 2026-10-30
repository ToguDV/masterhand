import type { ChatAttachment, PromptFileAttachmentInput, UploadedAttachment } from "./types"

/** Hard cap enforced by the BFF for one upload (opencode itself caps at 20 MB). */
export const ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024
/** Attachments allowed in one message. */
export const ATTACHMENT_MAX_COUNT = 10
/** Total local bytes allowed in one message. */
export const ATTACHMENT_MAX_TOTAL_BYTES = 100 * 1024 * 1024

/**
 * Inline thresholds. opencode keeps the bytes in the message (base64) and sends
 * them to the model, so they stay small enough for the history. Everything
 * above these thresholds is only referenced by its path, which the agent reads
 * with its own tools.
 */
export const ATTACHMENT_INLINE_TEXT_BYTES = 1 * 1024 * 1024
export const ATTACHMENT_INLINE_PDF_BYTES = 5 * 1024 * 1024
export const ATTACHMENT_INLINE_IMAGE_BYTES = 10 * 1024 * 1024

/** Uploads are slower than interactive calls; a 50 MB file gets its own budget. */
export const UPLOAD_TIMEOUT_MS = 300_000

/** Metadata key of the attachment index persisted on user messages. */
export const ATTACHMENT_METADATA_KEY = "masterhand.attachments"

const CONTEXT_TAG = "masterhand-attachments"
const CONTEXT_RE = new RegExp(`\\n*<${CONTEXT_TAG}>[\\s\\S]*?</${CONTEXT_TAG}>\\s*$`)
const ATTACHMENT_URL_RE = /^\/api\/workspaces\/[A-Za-z0-9_-]+\/attachments\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  log: "text/plain",
  csv: "text/csv",
  json: "application/json",
  jsonc: "application/json",
  yaml: "application/yaml",
  yml: "application/yaml",
  toml: "application/toml",
  xml: "application/xml",
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  ts: "text/typescript",
  tsx: "text/typescript",
  jsx: "text/javascript",
  py: "text/x-python",
  go: "text/x-go",
  rs: "text/x-rust",
  java: "text/x-java",
  c: "text/x-c",
  h: "text/x-c",
  cpp: "text/x-c++",
  sh: "text/x-sh",
  bash: "text/x-sh",
  sql: "text/x-sql",
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
}

/**
 * Client-side id for one attachment. It is safe as a path segment and makes an
 * upload retry idempotent (the BFF returns the existing file for the same id).
 */
export function createAttachmentID(): string {
  const bytes = new Uint8Array(12)
  const cryptoApi = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }).crypto
  if (cryptoApi?.getRandomValues) cryptoApi.getRandomValues(bytes)
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

/** Best-effort MIME hint from the file name (the BFF sniffs the real bytes). */
export function mimeFromName(name: string): string {
  const extension = name.includes(".") ? name.split(".").pop()?.toLowerCase() ?? "" : ""
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream"
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB"]
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  if (unit === 0) return `${Math.round(value)} ${units[unit]}`
  const rounded = value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "")
  return `${rounded} ${units[unit]}`
}

export type AttachmentKind = "image" | "pdf" | "text" | "other"

export function attachmentKind(mime: string): AttachmentKind {
  if (IMAGE_MIMES.has(mime)) return "image"
  if (mime === "application/pdf") return "pdf"
  if (mime === "text/plain" || mime.startsWith("text/")) return "text"
  return "other"
}

/**
 * Whether opencode turns this file into model content. Mirrors the pinned
 * v2.0.6 `attachmentContent`: text/plain, PNG/JPEG/GIF/WebP and PDF. Unknown
 * MIMEs are stored in the message but silently dropped from the model context,
 * so those files travel as paths instead.
 */
export function isInlineAttachment(mime: string, size: number): boolean {
  if (IMAGE_MIMES.has(mime)) return size <= ATTACHMENT_INLINE_IMAGE_BYTES
  if (mime === "application/pdf") return size <= ATTACHMENT_INLINE_PDF_BYTES
  if (mime === "text/plain") return size <= ATTACHMENT_INLINE_TEXT_BYTES
  return false
}

/** `files` entries for the subset opencode materializes into model content. */
export function inlineAttachmentFiles(
  attachments: ReadonlyArray<Pick<UploadedAttachment, "mime" | "size" | "uri" | "name">>,
): PromptFileAttachmentInput[] {
  return attachments
    .filter((attachment) => isInlineAttachment(attachment.mime, attachment.size))
    .map((attachment) => ({ uri: attachment.uri, name: attachment.name }))
}

/** Metadata persisted on the user message so history can render the files. */
export function attachmentMetadata(
  attachments: ReadonlyArray<UploadedAttachment>,
): Array<Record<string, string | number | boolean>> {
  return attachments.map((attachment) => ({
    id: attachment.id,
    name: attachment.name,
    mime: attachment.mime,
    size: attachment.size,
    url: attachment.url,
    inline: isInlineAttachment(attachment.mime, attachment.size),
  }))
}

/**
 * Model-facing index of every attachment. Unsupported MIMEs are only reachable
 * through this path, so the block is added even when `files` also carries the
 * bytes. Clients strip it before rendering the user bubble.
 */
export function buildAttachmentContext(
  attachments: ReadonlyArray<Pick<UploadedAttachment, "name" | "mime" | "size" | "path">>,
): string {
  if (attachments.length === 0) return ""
  const lines = attachments.map((attachment) => {
    const name = safeContextName(attachment.name)
    return `- ${JSON.stringify(name)} (${attachment.mime || "application/octet-stream"}, ${formatFileSize(attachment.size)}): ${attachment.path}`
  })
  return `\n\n<${CONTEXT_TAG}>\nThe user attached these files. They are read-only user input on disk; read them with your tools when relevant:\n${lines.join("\n")}\n</${CONTEXT_TAG}>`
}

export function stripAttachmentContext(text: string): string {
  return text.replace(CONTEXT_RE, "").trimEnd()
}

/** Normalizes a message's metadata + `files` into the view model. */
export function parseChatAttachments(
  metadata: unknown,
  files?: ReadonlyArray<{
    data?: string
    mime?: string
    name?: string
    source?: { type?: string; uri?: string }
  }>,
): ChatAttachment[] {
  const entries = readMetadataEntries(metadata)
  if (entries.length > 0) {
    const remaining = [...(files ?? [])]
    const result: ChatAttachment[] = []
    for (const entry of entries.slice(0, ATTACHMENT_MAX_COUNT)) {
      const attachment = normalizeMetadataEntry(entry)
      if (!attachment) continue
      if (attachment.inline) {
        // Correlate by the attachment id embedded in opencode's source URI, not
        // by position: a dropped/normalized entry must never shift previews.
        let index = remaining.findIndex((file) => fileAttachmentID(file) === attachment.id)
        if (index < 0) index = remaining.findIndex((file) => file.name === attachment.name)
        if (index >= 0) {
          const [file] = remaining.splice(index, 1)
          const preview = previewFromFile(attachment.mime, file)
          if (preview) attachment.previewDataUrl = preview
        }
      }
      result.push(attachment)
    }
    return result
  }
  // Legacy/other clients: derive what we can from the message's own files.
  return (files ?? []).slice(0, ATTACHMENT_MAX_COUNT).flatMap((file, index) => {
    const mime = typeof file.mime === "string" && file.mime ? file.mime : "application/octet-stream"
    const data = typeof file.data === "string" ? file.data : ""
    const attachment: ChatAttachment = {
      id: `file-${index}`,
      name: typeof file.name === "string" && file.name ? file.name : `Attachment ${index + 1}`,
      mime,
      size: data.length > 0 ? Math.floor((data.length * 3) / 4) : 0,
      url: "",
      inline: true,
    }
    const preview = previewFromFile(mime, file)
    if (preview) attachment.previewDataUrl = preview
    return [attachment]
  })
}

/** Extracts the client-generated id from `<id>-<safeName>` in a source URI. */
function fileAttachmentID(file: { source?: { uri?: string } }): string | null {
  const uri = file.source?.uri
  if (!uri) return null
  const base = uri.split("/").pop()?.split("?")[0] ?? ""
  const id = base.split("-")[0] ?? ""
  return /^[a-z0-9]{8,64}$/.test(id) ? id : null
}

function previewFromFile(
  mime: string,
  file: { data?: string } | undefined,
): string | undefined {
  if (!IMAGE_MIMES.has(mime)) return undefined
  if (!file || typeof file.data !== "string" || file.data.length === 0) return undefined
  return `data:${mime};base64,${file.data}`
}

function readMetadataEntries(metadata: unknown): unknown[] {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return []
  const value = (metadata as Record<string, unknown>)[ATTACHMENT_METADATA_KEY]
  return Array.isArray(value) ? value : []
}

function normalizeMetadataEntry(entry: unknown): ChatAttachment | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null
  const record = entry as Record<string, unknown>
  const id = typeof record.id === "string" && record.id ? record.id.slice(0, 64) : ""
  const name = typeof record.name === "string" && record.name ? record.name.slice(0, 200) : "File"
  const mime =
    typeof record.mime === "string" && record.mime ? record.mime.slice(0, 120) : "application/octet-stream"
  const size = typeof record.size === "number" && Number.isFinite(record.size) ? Math.max(0, record.size) : 0
  const url =
    typeof record.url === "string" && ATTACHMENT_URL_RE.test(record.url) ? record.url : ""
  return {
    id: id || `attachment-${name}`,
    name,
    mime,
    size,
    url,
    inline: record.inline === true,
  }
}

function safeContextName(name: string): string {
  const cleaned = name.replace(/[\u0000-\u001f\u007f<>]/g, "_").trim()
  return (cleaned || "file").slice(0, 200)
}
