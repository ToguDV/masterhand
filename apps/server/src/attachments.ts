import { randomBytes } from "node:crypto"
import { createReadStream } from "node:fs"
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises"
import { basename, extname, join, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"

/** IDs become path segments; keep them ASCII and slash-free. */
const SEGMENT = /^[A-Za-z0-9_-]{1,96}$/
const PART_TTL_MS = 60 * 60 * 1000

export type AttachmentErrorCode =
  | "invalid_attachment"
  | "attachment_conflict"
  | "attachment_too_large"
  | "attachments_full"
  | "not_found"
  | "storage_unavailable"

export class AttachmentError extends Error {
  constructor(
    public readonly code: AttachmentErrorCode,
    message = code,
  ) {
    super(message)
    this.name = "AttachmentError"
  }
}

export interface StoredAttachment {
  id: string
  name: string
  /** MIME sniffed from the bytes (never trusted from the client). */
  mime: string
  size: number
  /** Absolute path on the server. The agent reads it with its tools. */
  path: string
  /** file: URL for opencode's prompt `files`. */
  uri: string
  /** Authenticated BFF URL for previews/downloads. */
  url: string
}

interface Sidecar {
  id: string
  name: string
  mime: string
  size: number
  file: string
  createdAt: number
}

export interface UploadAttachmentInput {
  workspaceID: string
  workspacePath: string
  sessionID: string
  attachmentID: string
  name: string
  bytes: Uint8Array
  maxFileBytes: number
  maxSessionBytes: number
}

export interface UploadAttachmentResult extends StoredAttachment {
  /** True when an idempotent retry found the already-stored file. */
  existed: boolean
}

export function attachmentURL(workspaceID: string, sessionID: string, attachmentID: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceID)}/attachments/${encodeURIComponent(sessionID)}/${encodeURIComponent(attachmentID)}`
}

export function attachmentsRoot(workspacePath: string): string {
  return join(workspacePath, ".masterhand", "attachments")
}

export function attachmentDir(workspacePath: string, sessionID: string): string {
  assertSegment(sessionID)
  return join(attachmentsRoot(workspacePath), sessionID)
}

/**
 * Writes one attachment under `<workspace>/.masterhand/attachments/<session>/`.
 * The client id makes retries idempotent; the write is atomic (`.part` →
 * rename) so a crash can never expose a half-written file.
 */
export async function uploadAttachment(input: UploadAttachmentInput): Promise<UploadAttachmentResult> {
  assertSegment(input.sessionID)
  assertSegment(input.attachmentID)
  if (input.bytes.byteLength > input.maxFileBytes) {
    throw new AttachmentError("attachment_too_large")
  }

  const dir = attachmentDir(input.workspacePath, input.sessionID)
  await mkdir(dir, { recursive: true, mode: 0o775 })
  await ensureGitignore(attachmentsRoot(input.workspacePath))

  const existing = await readSidecar(dir, input.attachmentID)
  if (existing) {
    try {
      const info = await stat(join(dir, existing.file))
      if (info.isFile() && info.size === input.bytes.byteLength) {
        return toResult(input, existing, true)
      }
      throw new AttachmentError("attachment_conflict")
    } catch (error) {
      if (error instanceof AttachmentError) throw error
      // A missing file with a stale sidecar: rewrite both below.
      await unlink(join(dir, `${input.attachmentID}.json`)).catch(() => {})
    }
  }

  const used = await directoryBytes(dir)
  if (used + input.bytes.byteLength > input.maxSessionBytes) {
    throw new AttachmentError("attachments_full")
  }

  const safeName = sanitizeFileName(input.name || "file")
  const file = `${input.attachmentID}-${safeName}`
  const target = join(dir, file)
  const temp = join(dir, `.${input.attachmentID}.${randomBytes(6).toString("hex")}.part`)
  const sidecar: Sidecar = {
    id: input.attachmentID,
    name: input.name || safeName,
    mime: sniffMime(input.bytes),
    size: input.bytes.byteLength,
    file,
    createdAt: Date.now(),
  }

  try {
    await writeFile(temp, input.bytes, { mode: 0o644 })
    await rename(temp, target)
    await writeFile(join(dir, `${input.attachmentID}.json`), JSON.stringify(sidecar), { mode: 0o644 })
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }

  return toResult(input, sidecar, false)
}

export interface LoadedAttachment {
  meta: Sidecar
  filePath: string
  /** Current on-disk size (the agent may have edited the file since upload). */
  size: number
}

export async function getAttachment(
  workspacePath: string,
  sessionID: string,
  attachmentID: string,
): Promise<LoadedAttachment> {
  assertSegment(sessionID)
  assertSegment(attachmentID)
  const dir = attachmentDir(workspacePath, sessionID)
  const sidecar = await readSidecar(dir, attachmentID)
  if (!sidecar || sidecar.id !== attachmentID) throw new AttachmentError("not_found")
  // The sidecar is server-written, but never let it point outside the session
  // directory (a corrupted file must not turn into a path traversal).
  if (!sidecar.file || basename(sidecar.file) !== sidecar.file) throw new AttachmentError("not_found")
  const filePath = resolve(dir, sidecar.file)
  if (!filePath.startsWith(resolve(dir) + sep)) throw new AttachmentError("not_found")
  const info = await stat(filePath).catch(() => null)
  if (!info || !info.isFile()) throw new AttachmentError("not_found")
  return { meta: sidecar, filePath, size: info.size }
}

export function attachmentStream(filePath: string): ReadableStream {
  // Node's Readable is accepted by Hono's Response; the cast keeps this module
  // free of Hono types.
  return createReadStream(filePath) as unknown as ReadableStream
}

export async function removeAttachment(
  workspacePath: string,
  sessionID: string,
  attachmentID: string,
): Promise<void> {
  assertSegment(sessionID)
  assertSegment(attachmentID)
  const dir = attachmentDir(workspacePath, sessionID)
  const sidecar = await readSidecar(dir, attachmentID)
  if (sidecar?.file && basename(sidecar.file) === sidecar.file) {
    await unlink(join(dir, sidecar.file)).catch(() => {})
  }
  // Also sweep a file left behind by a sidecar that never landed.
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.startsWith(`${attachmentID}-`))
      .map((entry) => unlink(join(dir, entry.name)).catch(() => {})),
  )
  await unlink(join(dir, `${attachmentID}.json`)).catch(() => {})
}

/** Drops one session's attachments (best effort at the call site). */
export async function removeSessionAttachments(workspacePath: string, sessionID: string): Promise<void> {
  assertSegment(sessionID)
  await rm(attachmentDir(workspacePath, sessionID), { recursive: true, force: true })
}

/** Drops every attachment of a workspace without touching `.masterhand/run.json`. */
export async function removeWorkspaceAttachments(workspacePath: string): Promise<void> {
  await rm(attachmentsRoot(workspacePath), { recursive: true, force: true })
}

export interface PruneAttachmentsOptions {
  ttlMs: number
  partTtlMs?: number
  now?: number
  /**
   * Whether a session still exists. A failing predicate is treated as "active"
   * so an unreachable opencode can never delete a live session's files.
   */
  isSessionActive?: (workspacePath: string, sessionID: string) => Promise<boolean> | boolean
}

export interface PruneResult {
  removedSessions: number
  removedParts: number
}

/**
 * Removes stale upload debris: `.part` files older than an hour and session
 * directories older than the retention window whose session no longer exists.
 */
export async function pruneAttachments(
  workspacesRoot: string,
  options: PruneAttachmentsOptions,
): Promise<PruneResult> {
  const now = options.now ?? Date.now()
  const partTtl = options.partTtlMs ?? PART_TTL_MS
  const result: PruneResult = { removedSessions: 0, removedParts: 0 }
  if (options.ttlMs <= 0) return result

  const workspaces = await readdir(workspacesRoot, { withFileTypes: true }).catch(() => [])
  for (const workspace of workspaces) {
    if (!workspace.isDirectory() || workspace.name.startsWith(".")) continue
    const workspacePath = join(workspacesRoot, workspace.name)
    const root = attachmentsRoot(workspacePath)
    const sessions = await readdir(root, { withFileTypes: true }).catch(() => [])
    for (const session of sessions) {
      if (!session.isDirectory() || !SEGMENT.test(session.name)) continue
      const dir = join(root, session.name)
      // Capture the directory mtime before touching its contents: unlinking a
      // stale .part updates the parent directory and would reset the TTL.
      const info = await stat(dir).catch(() => null)
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".part")) continue
        const partInfo = await stat(join(dir, entry.name)).catch(() => null)
        if (partInfo && now - partInfo.mtimeMs > partTtl) {
          try {
            await unlink(join(dir, entry.name))
            result.removedParts += 1
          } catch {
            // A concurrent download/cleanup: leave it for the next pass.
          }
        }
      }
      if (!info || now - info.mtimeMs < options.ttlMs) continue
      if (options.isSessionActive) {
        let active = true
        try {
          active = await options.isSessionActive(workspacePath, session.name)
        } catch {
          active = true
        }
        if (active) continue
      }
      try {
        await rm(dir, { recursive: true, force: true })
        result.removedSessions += 1
      } catch {
        // Leave it for the next pass; the session may be writing again.
      }    }
  }
  return result
}

/**
 * Content sniffing for the stored MIME. Mirrors the pinned opencode v2.0.6
 * `Mime.detect` so the inline decision made by the clients matches what the
 * model actually receives: text/plain, PNG/JPEG/GIF/WebP, PDF; everything else
 * is `application/octet-stream`.
 */
export function sniffMime(bytes: Uint8Array): string {
  const starts = (prefix: number[], offset = 0): boolean =>
    prefix.every((value, index) => bytes[offset + index] === value)
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg"
  if (starts([0x47, 0x49, 0x46, 0x38])) return "image/gif"
  if (starts([0x42, 0x4d])) return "image/bmp"
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp"
  if (
    starts([0x66, 0x74, 0x79, 0x70], 4) &&
    (starts([0x61, 0x76, 0x69, 0x66], 8) || starts([0x61, 0x76, 0x69, 0x73], 8))
  ) {
    return "image/avif"
  }
  return isText(bytes.subarray(0, 64 * 1024)) ? "text/plain" : "application/octet-stream"
}

export function sanitizeFileName(name: string): string {
  const cleaned = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w.\- ]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._]+|[._]+$/g, "")
  if (!cleaned) return "file"
  const extension = extname(cleaned).slice(0, 16)
  const base = extension ? cleaned.slice(0, -extname(cleaned).length) : cleaned
  const trimmed = base.replace(/[._]+$/, "").slice(0, 80) || "file"
  return `${trimmed}${extension}`.slice(0, 96)
}

function isText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return true
  if (bytes.includes(0)) return false
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true })
  } catch {
    return false
  }
  let controls = 0
  for (const byte of bytes) if (byte < 9 || (byte > 13 && byte < 32)) controls += 1
  return controls / bytes.length <= 0.3
}

function assertSegment(value: string): void {
  if (!SEGMENT.test(value)) throw new AttachmentError("invalid_attachment")
}

async function ensureGitignore(root: string): Promise<void> {
  // A self-ignoring directory: the user's git status never shows attachments.
  await writeFile(join(root, ".gitignore"), "*\n", { flag: "wx", mode: 0o644 }).catch(() => {})
}

async function readSidecar(dir: string, attachmentID: string): Promise<Sidecar | null> {
  try {
    const raw = await readFile(join(dir, `${attachmentID}.json`), "utf8")
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    if (
      typeof record.id !== "string" ||
      record.id !== attachmentID ||
      typeof record.name !== "string" ||
      typeof record.mime !== "string" ||
      typeof record.file !== "string" ||
      typeof record.size !== "number" ||
      typeof record.createdAt !== "number"
    ) {
      return null
    }
    return {
      id: record.id,
      name: record.name,
      mime: record.mime,
      size: record.size,
      file: record.file,
      createdAt: record.createdAt,
    }
  } catch {
    return null
  }
}

async function directoryBytes(dir: string): Promise<number> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  let total = 0
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const info = await stat(join(dir, entry.name)).catch(() => null)
    if (info) total += info.size
  }
  return total
}

function toResult(input: UploadAttachmentInput, sidecar: Sidecar, existed: boolean): UploadAttachmentResult {
  const path = join(attachmentDir(input.workspacePath, input.sessionID), sidecar.file)
  return {
    id: sidecar.id,
    name: sidecar.name,
    mime: sidecar.mime,
    size: sidecar.size,
    path,
    uri: pathToFileURL(path).href,
    url: attachmentURL(input.workspaceID, input.sessionID, sidecar.id),
    existed,
  }
}
