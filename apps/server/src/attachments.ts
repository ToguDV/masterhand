import { createHash, randomBytes } from "node:crypto"
import { constants } from "node:fs"
import type { FileHandle } from "node:fs/promises"
import { link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, unlink } from "node:fs/promises"
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
  sha256: string
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
 * hard-link/rename) so a crash can never expose a half-written file.
 *
 * The workspace is agent-writable and therefore untrusted: every directory in
 * the store is checked with `lstat` so a symlink planted by the agent cannot
 * redirect the BFF's write outside the workspace.
 */
export async function uploadAttachment(input: UploadAttachmentInput): Promise<UploadAttachmentResult> {
  assertSegment(input.sessionID)
  assertSegment(input.attachmentID)
  if (input.bytes.byteLength > input.maxFileBytes) {
    throw new AttachmentError("attachment_too_large")
  }

  const root = await ensureStore(input.workspacePath)
  const dir = await ensureSessionDir(root, input.sessionID)
  await ensureGitignore(root)

  const digest = createHash("sha256").update(input.bytes).digest("hex")
  const existing = await readSidecar(dir, input.attachmentID)
  if (existing) {
    try {
      if (!existing.file || basename(existing.file) !== existing.file) {
        throw new AttachmentError("attachment_conflict")
      }
      const existingPath = resolve(dir, existing.file)
      if (!existingPath.startsWith(resolve(dir) + sep)) {
        throw new AttachmentError("attachment_conflict")
      }
      const info = await lstat(existingPath)
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new AttachmentError("attachment_conflict")
      }
      const matches =
        info.size === input.bytes.byteLength &&
        (existing.sha256
          ? existing.sha256 === digest
          : (await readFile(existingPath)).equals(Buffer.from(input.bytes)))
      if (matches) return toResult(input, existing, true)
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
  const nonce = randomBytes(6).toString("hex")
  const temp = join(dir, `.${input.attachmentID}.${nonce}.part`)
  const sidecar: Sidecar = {
    id: input.attachmentID,
    name: input.name || safeName,
    mime: sniffMime(input.bytes),
    size: input.bytes.byteLength,
    file,
    sha256: digest,
    createdAt: Date.now(),
  }

  let createdTarget = false
  try {
    await writeNewFile(temp, input.bytes)
    try {
      // `link` is a no-clobber atomic create: a concurrent upload with the same
      // id either wins or sees EEXIST and reconciles against the winner.
      await link(temp, target)
      createdTarget = true
      await unlink(temp)
    } catch (error) {
      await unlink(temp).catch(() => {})
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (code === "EEXIST") {
        const winner = await readSidecar(dir, input.attachmentID)
        if (winner?.size === input.bytes.byteLength && winner.sha256 === digest) {
          return toResult(input, winner, true)
        }
        // The winner may still be writing its sidecar: compare the bytes.
        const current = await lstat(target).catch(() => null)
        if (current?.isFile() && !current.isSymbolicLink() && current.size === input.bytes.byteLength) {
          const bytes = await readFile(target)
          if (bytes.equals(Buffer.from(input.bytes))) {
            await writeNewFile(join(dir, `${input.attachmentID}.json`), JSON.stringify(sidecar)).catch(() => {})
            return toResult(input, sidecar, true)
          }
        }
        throw new AttachmentError("attachment_conflict")
      }
      // Hard links are unavailable on a few filesystems; same-directory
      // rename is still atomic, just not no-clobber.
      if (code === "EPERM" || code === "EXDEV" || code === "ENOSYS" || code === "EOPNOTSUPP") {
        await rename(temp, target)
        createdTarget = true
      } else {
        throw error
      }
    }
    const sidecarPath = join(dir, `${input.attachmentID}.json`)
    try {
      await writeNewFile(sidecarPath, JSON.stringify(sidecar))
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== "EEXIST") throw error
      // The target is ours (link/rename succeeded). A stale sidecar must not
      // describe different bytes, so replace it when the digest differs.
      const current = await readSidecar(dir, input.attachmentID)
      if (!current || current.sha256 !== digest) {
        await unlink(sidecarPath).catch(() => {})
        await writeNewFile(sidecarPath, JSON.stringify(sidecar))
      }
    }
  } catch (error) {
    await unlink(temp).catch(() => {})
    if (createdTarget) {
      await unlink(target).catch(() => {})
      await unlink(join(dir, `${input.attachmentID}.json`)).catch(() => {})
    }
    throw error
  }

  return toResult(input, sidecar, false)
}

export interface LoadedAttachment {
  meta: Sidecar
  /** Open file handle; the caller streams and closes it. */
  handle: FileHandle
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
  if (!(await lstat(attachmentsRoot(workspacePath)).catch(() => null))) {
    throw new AttachmentError("not_found")
  }
  const root = await assertStoreUnderWorkspace(workspacePath)
  const dir = attachmentDir(workspacePath, sessionID)
  await assertRealDirectory(dir)
  const [realRoot, realDir] = await Promise.all([realpath(root), realpath(dir)])
  if (!realDir.startsWith(realRoot + sep)) throw new AttachmentError("not_found")

  const sidecar = await readSidecar(realDir, attachmentID)
  if (!sidecar) throw new AttachmentError("not_found")
  // The sidecar is server-written, but never let it point outside the session
  // directory (a corrupted file must not turn into a path traversal).
  if (!sidecar.file || basename(sidecar.file) !== sidecar.file) throw new AttachmentError("not_found")
  const filePath = resolve(realDir, sidecar.file)
  if (!filePath.startsWith(realDir + sep)) throw new AttachmentError("not_found")

  const info = await lstat(filePath).catch(() => null)
  if (!info || !info.isFile() || info.isSymbolicLink()) throw new AttachmentError("not_found")
  const realFile = await realpath(filePath).catch(() => null)
  if (!realFile || !realFile.startsWith(realDir + sep)) throw new AttachmentError("not_found")

  // `O_NOFOLLOW` closes the lstat → open race for the final component; the
  // resolved-directory checks above cover a symlinked parent.
  let handle: FileHandle
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch {
    throw new AttachmentError("not_found")
  }
  const fileInfo = await handle.stat().catch(() => null)
  if (!fileInfo || !fileInfo.isFile()) {
    await handle.close().catch(() => {})
    throw new AttachmentError("not_found")
  }
  return { meta: sidecar, handle, size: fileInfo.size }
}

export async function removeAttachment(
  workspacePath: string,
  sessionID: string,
  attachmentID: string,
): Promise<void> {
  assertSegment(sessionID)
  assertSegment(attachmentID)
  let root: string
  try {
    root = await assertStoreUnderWorkspace(workspacePath)
  } catch {
    return
  }
  const dir = attachmentDir(workspacePath, sessionID)
  try {
    await assertRealDirectory(dir)
  } catch {
    return
  }
  const [realRoot, realDir] = await Promise.all([realpath(root), realpath(dir)])
  if (!realDir.startsWith(realRoot + sep)) return

  const sidecar = await readSidecar(realDir, attachmentID)
  if (sidecar?.file && basename(sidecar.file) === sidecar.file) {
    await unlink(join(realDir, sidecar.file)).catch(() => {})
  }
  // Also sweep a file left behind by a sidecar that never landed.
  const entries = await readdir(realDir, { withFileTypes: true }).catch(() => [])
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.startsWith(`${attachmentID}-`))
      .map((entry) => unlink(join(realDir, entry.name)).catch(() => {})),
  )
  await unlink(join(realDir, `${attachmentID}.json`)).catch(() => {})
}

/** Drops one session's attachments (best effort at the call site). */
export async function removeSessionAttachments(workspacePath: string, sessionID: string): Promise<void> {
  assertSegment(sessionID)
  let root: string
  try {
    root = await assertStoreUnderWorkspace(workspacePath)
  } catch {
    return
  }
  const dir = attachmentDir(workspacePath, sessionID)
  try {
    await assertRealDirectory(dir)
  } catch {
    return
  }
  const [realRoot, realDir] = await Promise.all([realpath(root), realpath(dir)])
  if (!realDir.startsWith(realRoot + sep)) return
  await rm(realDir, { recursive: true, force: true })
}

/** Drops every attachment of a workspace without touching `.masterhand/run.json`. */
export async function removeWorkspaceAttachments(workspacePath: string): Promise<void> {
  const master = join(workspacePath, ".masterhand")
  try {
    await assertRealDirectory(master)
  } catch {
    return
  }
  const root = attachmentsRoot(workspacePath)
  const info = await lstat(root).catch(() => null)
  if (!info || !info.isDirectory() || info.isSymbolicLink()) return
  const [realWorkspace, realRoot] = await Promise.all([realpath(workspacePath), realpath(root)])
  if (!realRoot.startsWith(realWorkspace + sep)) return
  await rm(realRoot, { recursive: true, force: true })
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
 * A symlinked store or session directory is skipped: the workspace is
 * agent-writable, so `rm -rf` must never follow a link outside it.
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
    const master = join(workspacePath, ".masterhand")
    const masterInfo = await lstat(master).catch(() => null)
    if (!masterInfo || !masterInfo.isDirectory() || masterInfo.isSymbolicLink()) continue
    const root = attachmentsRoot(workspacePath)
    const rootInfo = await lstat(root).catch(() => null)
    if (!rootInfo || !rootInfo.isDirectory() || rootInfo.isSymbolicLink()) continue
    const [realWorkspace, realRoot] = await Promise.all([
      realpath(workspacePath).catch(() => null),
      realpath(root).catch(() => null),
    ])
    if (!realRoot || !realWorkspace || !realRoot.startsWith(realWorkspace + sep)) continue

    const sessions = await readdir(root, { withFileTypes: true }).catch(() => [])
    for (const session of sessions) {
      if (!session.isDirectory() || !SEGMENT.test(session.name)) continue
      const dir = join(root, session.name)
      // Capture the directory mtime before touching its contents: unlinking a
      // stale .part updates the parent directory and would reset the TTL.
      const info = await lstat(dir).catch(() => null)
      if (!info || !info.isDirectory() || info.isSymbolicLink()) continue
      const realDir = await realpath(dir).catch(() => null)
      if (!realDir || !realDir.startsWith(realRoot + sep)) continue

      const entries = await readdir(realDir, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".part")) continue
        const partInfo = await lstat(join(realDir, entry.name)).catch(() => null)
        if (partInfo && now - partInfo.mtimeMs > partTtl) {
          try {
            await unlink(join(realDir, entry.name))
            result.removedParts += 1
          } catch {
            // A concurrent download/cleanup: leave it for the next pass.
          }
        }
      }
      if (now - info.mtimeMs < options.ttlMs) continue
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
        await rm(realDir, { recursive: true, force: true })
        result.removedSessions += 1
      } catch {
        // Leave it for the next pass; the session may be writing again.
      }
    }
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

/** The store and the session directory must be real directories, never links. */
async function assertRealDirectory(path: string): Promise<void> {
  const info = await lstat(path).catch(() => null)
  if (!info || !info.isDirectory() || info.isSymbolicLink()) {
    throw new AttachmentError("invalid_attachment")
  }
}

/**
 * A `.masterhand` (or `attachments`) symlink would let the BFF read, write or
 * delete outside the workspace. The workspace itself may be reached through a
 * symlinked prefix (native /tmp), so the real store must still be below the
 * real workspace path.
 */
async function assertStoreUnderWorkspace(workspacePath: string): Promise<string> {
  const master = join(workspacePath, ".masterhand")
  await assertRealDirectory(master)
  const root = attachmentsRoot(workspacePath)
  await assertRealDirectory(root)
  const [realWorkspace, realRoot] = await Promise.all([realpath(workspacePath), realpath(root)])
  if (!realRoot.startsWith(realWorkspace + sep)) throw new AttachmentError("invalid_attachment")
  return root
}

async function ensureStore(workspacePath: string): Promise<string> {
  const master = join(workspacePath, ".masterhand")
  const root = join(master, "attachments")
  try {
    await mkdir(master, { recursive: true, mode: 0o775 })
    await assertRealDirectory(master)
    await mkdir(root, { recursive: true, mode: 0o775 })
    await assertRealDirectory(root)
  } catch (error) {
    if (error instanceof AttachmentError) throw error
    throw new AttachmentError("invalid_attachment")
  }
  return root
}

async function ensureSessionDir(root: string, sessionID: string): Promise<string> {
  const dir = join(root, sessionID)
  try {
    await mkdir(dir, { recursive: true, mode: 0o775 })
    await assertRealDirectory(dir)
  } catch (error) {
    if (error instanceof AttachmentError) throw error
    throw new AttachmentError("invalid_attachment")
  }
  const [realRoot, realDir] = await Promise.all([realpath(root), realpath(dir)])
  if (!realDir.startsWith(realRoot + sep)) throw new AttachmentError("invalid_attachment")
  return dir
}

async function writeNewFile(path: string, body: string | Uint8Array): Promise<void> {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o644,
  )
  try {
    await handle.writeFile(body)
  } finally {
    await handle.close().catch(() => {})
  }
}

async function ensureGitignore(root: string): Promise<void> {
  // A self-ignoring directory: the user's git status never shows attachments.
  // O_EXCL/O_NOFOLLOW means a symlink planted at this path is never followed.
  try {
    await writeNewFile(join(root, ".gitignore"), "*\n")
  } catch {
    // Already present (or a hostile symlink): never follow it.
  }
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
      typeof record.sha256 !== "string" ||
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
      sha256: record.sha256,
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
    const info = await lstat(join(dir, entry.name)).catch(() => null)
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
