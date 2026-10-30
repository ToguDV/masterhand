import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  attachmentDir,
  getAttachment,
  pruneAttachments,
  removeSessionAttachments,
  removeWorkspaceAttachments,
  sanitizeFileName,
  sniffMime,
  uploadAttachment,
} from "../src/attachments.js"
import { login, startMockOpencode, startTestApp, type MockOpencode, type TestApp } from "./helpers.js"

let app: TestApp | null = null
let upstream: MockOpencode | null = null
let root = ""

afterEach(async () => {
  await app?.close()
  await upstream?.close()
  if (root) rmSync(root, { recursive: true, force: true })
  app = null
  upstream = null
  root = ""
})

function setupWorkspace(): { root: string; workspacePath: string } {
  root = mkdtempSync(join(tmpdir(), "masterhand-attachments-"))
  const workspacePath = join(root, "app")
  mkdirSync(workspacePath, { recursive: true })
  return { root, workspacePath }
}

async function startApp(workspacePath: string, options: { maxMb?: number; opencodeUrl?: string } = {}) {
  app = await startTestApp({
    config: {
      workspacesRoot: root,
      ...(options.opencodeUrl ? { opencodeUrl: options.opencodeUrl } : {}),
      ...(options.maxMb ? { attachmentMaxMb: options.maxMb } : {}),
    },
  })
  app.store.createWorkspace({ id: "ws_1", name: "app", path: workspacePath, createdAt: Date.now() })
  return app
}

function uploadForm(id: string, name: string, bytes: BlobPart, type = "text/plain"): FormData {
  const form = new FormData()
  form.set("sessionID", "ses_1")
  form.set("attachmentID", id)
  form.set("file", new File([bytes], name, { type }))
  return form
}

describe("attachment content helpers", () => {
  it("sniffs the MIME opencode will see", () => {
    expect(sniffMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png")
    expect(sniffMime(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]))).toBe("application/pdf")
    expect(sniffMime(new TextEncoder().encode("hello\nworld"))).toBe("text/plain")
    expect(sniffMime(new Uint8Array([0, 1, 2, 3]))).toBe("application/octet-stream")
  })

  it("sanitizes on-disk names without losing the extension", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("etc_passwd")
    expect(sanitizeFileName("My report (final).pdf")).toBe("My_report_final.pdf")
    expect(sanitizeFileName("")).toBe("file")
    expect(sanitizeFileName("ñandú.png")).toBe("nandu.png")
  })

  it("writes an idempotent, atomic attachment", async () => {
    const { workspacePath } = setupWorkspace()
    const input = {
      workspaceID: "ws_1",
      workspacePath,
      sessionID: "ses_1",
      attachmentID: "a1",
      name: "notes.txt",
      bytes: new TextEncoder().encode("hello"),
      maxFileBytes: 1024,
      maxSessionBytes: 4096,
    }
    const first = await uploadAttachment(input)
    expect(first.existed).toBe(false)
    expect(first.mime).toBe("text/plain")
    expect(first.path).toBe(join(attachmentDir(workspacePath, "ses_1"), "a1-notes.txt"))
    expect(readFileSync(first.path, "utf8")).toBe("hello")
    expect(first.url).toBe("/api/workspaces/ws_1/attachments/ses_1/a1")
    expect(first.uri.startsWith("file:")).toBe(true)

    const retry = await uploadAttachment(input)
    expect(retry.existed).toBe(true)
    expect(retry.path).toBe(first.path)

    await expect(
      uploadAttachment({ ...input, bytes: new TextEncoder().encode("different") }),
    ).rejects.toMatchObject({ code: "attachment_conflict" })
  })

  it("rejects same-size different bytes as a conflict", async () => {
    const { workspacePath } = setupWorkspace()
    const base = {
      workspaceID: "ws_1",
      workspacePath,
      sessionID: "ses_1",
      attachmentID: "a1",
      name: "notes.txt",
      maxFileBytes: 1024,
      maxSessionBytes: 4096,
    }
    await uploadAttachment({ ...base, bytes: new TextEncoder().encode("hello") })
    await expect(
      uploadAttachment({ ...base, bytes: new TextEncoder().encode("world") }),
    ).rejects.toMatchObject({ code: "attachment_conflict" })
  })

  it("never writes or reads through a symlinked store", async () => {
    const { workspacePath } = setupWorkspace()
    mkdirSync(join(workspacePath, ".masterhand"), { recursive: true })
    const outside = join(root, "outside")
    mkdirSync(outside, { recursive: true })
    const store = join(workspacePath, ".masterhand", "attachments")
    symlinkSync(outside, store, "dir")

    const input = {
      workspaceID: "ws_1",
      workspacePath,
      sessionID: "ses_1",
      attachmentID: "a1",
      name: "notes.txt",
      bytes: new TextEncoder().encode("hello"),
      maxFileBytes: 1024,
      maxSessionBytes: 4096,
    }
    await expect(uploadAttachment(input)).rejects.toMatchObject({ code: "invalid_attachment" })
    expect(existsSync(join(outside, "ses_1"))).toBe(false)

    rmSync(store)
    const uploaded = await uploadAttachment(input)
    rmSync(uploaded.path)
    const secret = join(root, "outside.txt")
    writeFileSync(secret, "secret")
    symlinkSync(secret, uploaded.path)
    await expect(getAttachment(workspacePath, "ses_1", "a1")).rejects.toMatchObject({
      code: "not_found",
    })
  })

  it("never prunes through a symlinked store", async () => {
    const { workspacePath } = setupWorkspace()
    mkdirSync(join(workspacePath, ".masterhand"), { recursive: true })
    const outside = join(root, "outside")
    const victim = join(outside, "ses_old")
    mkdirSync(victim, { recursive: true })
    writeFileSync(join(victim, "keep.txt"), "keep")
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000)
    utimesSync(victim, old, old)
    symlinkSync(outside, join(workspacePath, ".masterhand", "attachments"), "dir")

    const result = await pruneAttachments(root, {
      ttlMs: 90 * 24 * 60 * 60 * 1000,
    })
    expect(result.removedSessions).toBe(0)
    expect(existsSync(join(victim, "keep.txt"))).toBe(true)
  })

  it("never deletes through a symlinked .masterhand", async () => {
    const { workspacePath } = setupWorkspace()
    const outside = join(root, "outside")
    const victim = join(outside, "attachments", "ses_1")
    mkdirSync(victim, { recursive: true })
    writeFileSync(join(victim, "keep.txt"), "keep")
    symlinkSync(outside, join(workspacePath, ".masterhand"), "dir")

    await removeSessionAttachments(workspacePath, "ses_1")
    await removeWorkspaceAttachments(workspacePath)
    expect(existsSync(join(victim, "keep.txt"))).toBe(true)
  })

  it("rejects oversized files and full sessions", async () => {
    const { workspacePath } = setupWorkspace()
    await expect(
      uploadAttachment({
        workspaceID: "ws_1",
        workspacePath,
        sessionID: "ses_1",
        attachmentID: "a1",
        name: "big.bin",
        bytes: new Uint8Array(2048),
        maxFileBytes: 1024,
        maxSessionBytes: 4096,
      }),
    ).rejects.toMatchObject({ code: "attachment_too_large" })

    const base = {
      workspaceID: "ws_1",
      workspacePath,
      sessionID: "ses_1",
      name: "chunk.bin",
      bytes: new Uint8Array(600),
      maxFileBytes: 1024,
      maxSessionBytes: 1000,
    }
    await uploadAttachment({ ...base, attachmentID: "a1" })
    await expect(uploadAttachment({ ...base, attachmentID: "a2" })).rejects.toMatchObject({
      code: "attachments_full",
    })
  })

  it("prunes old parts and orphan sessions only", async () => {
    const { workspacePath } = setupWorkspace()
    const dir = attachmentDir(workspacePath, "ses_old")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "a1-old.txt"), "old")
    writeFileSync(join(dir, ".a1.dead.part"), "partial")
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000)
    utimesSync(dir, old, old)
    utimesSync(join(dir, ".a1.dead.part"), old, old)

    const keptDir = attachmentDir(workspacePath, "ses_active")
    mkdirSync(keptDir, { recursive: true })
    writeFileSync(join(keptDir, "a1-live.txt"), "live")
    utimesSync(keptDir, old, old)

    const result = await pruneAttachments(root, {
      ttlMs: 90 * 24 * 60 * 60 * 1000,
      isSessionActive: (_, sessionID) => sessionID === "ses_active",
    })
    expect(result.removedSessions).toBe(1)
    expect(result.removedParts).toBe(1)
    expect(existsSync(dir)).toBe(false)
    expect(existsSync(keptDir)).toBe(true)
    expect(existsSync(join(keptDir, "a1-live.txt"))).toBe(true)
  })
})

describe("attachment routes", () => {
  it("uploads, serves and deletes a file with auth", async () => {
    const { workspacePath } = setupWorkspace()
    const testApp = await startApp(workspacePath)
    const cookie = await login(testApp.url)

    const response = await fetch(`${testApp.url}/api/workspaces/ws_1/attachments`, {
      method: "POST",
      headers: { cookie },
      body: uploadForm("a1", "notes.txt", "hello"),
    })
    expect(response.status).toBe(201)
    const { attachment } = (await response.json()) as {
      attachment: { id: string; path: string; mime: string; size: number; url: string; uri: string }
    }
    expect(attachment).toMatchObject({ id: "a1", mime: "text/plain", size: 5 })
    expect(attachment.path).toContain("/.masterhand/attachments/ses_1/a1-notes.txt")

    const served = await fetch(`${testApp.url}${attachment.url}`, { headers: { cookie } })
    expect(served.status).toBe(200)
    expect(await served.text()).toBe("hello")
    expect(served.headers.get("x-content-type-options")).toBe("nosniff")
    expect(served.headers.get("content-security-policy")).toBe("sandbox")
    expect(served.headers.get("content-disposition")).toContain("attachment")

    const removed = await fetch(`${testApp.url}${attachment.url}`, { method: "DELETE", headers: { cookie } })
    expect(removed.status).toBe(204)
    const gone = await fetch(`${testApp.url}${attachment.url}`, { headers: { cookie } })
    expect(gone.status).toBe(404)
  })

  it("accepts a display-name override from the native uploader", async () => {
    const { workspacePath } = setupWorkspace()
    const testApp = await startApp(workspacePath)
    const cookie = await login(testApp.url)
    const form = uploadForm("a1", "cache-1234.jpg", "hello", "image/jpeg")
    form.set("name", "holiday.jpg")

    const response = await fetch(`${testApp.url}/api/workspaces/ws_1/attachments`, {
      method: "POST",
      headers: { cookie },
      body: form,
    })
    expect(response.status).toBe(201)
    const { attachment } = (await response.json()) as { attachment: { name: string } }
    expect(attachment.name).toBe("holiday.jpg")
  })

  it("is idempotent per client id and conflicts on different bytes", async () => {
    const { workspacePath } = setupWorkspace()
    const testApp = await startApp(workspacePath)
    const cookie = await login(testApp.url)
    const url = `${testApp.url}/api/workspaces/ws_1/attachments`

    const first = await fetch(url, { method: "POST", headers: { cookie }, body: uploadForm("a1", "notes.txt", "hello") })
    expect(first.status).toBe(201)
    const retry = await fetch(url, { method: "POST", headers: { cookie }, body: uploadForm("a1", "notes.txt", "hello") })
    expect(retry.status).toBe(200)
    const conflict = await fetch(url, {
      method: "POST",
      headers: { cookie },
      body: uploadForm("a1", "notes.txt", "different"),
    })
    expect(conflict.status).toBe(409)
  })

  it("rejects unauthenticated, invalid and oversized uploads", async () => {
    const { workspacePath } = setupWorkspace()
    const testApp = await startApp(workspacePath, { maxMb: 1 })
    const cookie = await login(testApp.url)

    const unauthenticated = await fetch(`${testApp.url}/api/workspaces/ws_1/attachments`, {
      method: "POST",
      body: uploadForm("a1", "notes.txt", "hello"),
    })
    expect(unauthenticated.status).toBe(401)

    const invalid = await fetch(`${testApp.url}/api/workspaces/ws_1/attachments`, {
      method: "POST",
      headers: { cookie },
      body: uploadForm("../escape", "notes.txt", "hello"),
    })
    expect(invalid.status).toBe(400)

    const oversized = await fetch(`${testApp.url}/api/workspaces/ws_1/attachments`, {
      method: "POST",
      headers: { cookie },
      body: uploadForm("a2", "big.bin", new Uint8Array(2 * 1024 * 1024), "application/octet-stream"),
    })
    expect(oversized.status).toBe(413)
  })

  it("removes a workspace's attachments when the workspace is deleted", async () => {
    const { workspacePath } = setupWorkspace()
    const testApp = await startApp(workspacePath)
    const cookie = await login(testApp.url)
    const response = await fetch(`${testApp.url}/api/workspaces/ws_1/attachments`, {
      method: "POST",
      headers: { cookie },
      body: uploadForm("a1", "notes.txt", "hello"),
    })
    expect(response.status).toBe(201)
    const dir = attachmentDir(workspacePath, "ses_1")
    expect(existsSync(dir)).toBe(true)

    const deleted = await fetch(`${testApp.url}/api/workspaces/ws_1`, { method: "DELETE", headers: { cookie } })
    expect(deleted.status).toBe(200)
    expect(existsSync(dir)).toBe(false)
  })

  it("confines prompt file URIs to the attachment store", async () => {
    const { root: workspaceRoot, workspacePath } = setupWorkspace()
    upstream = await startMockOpencode()
    const testApp = await startApp(workspacePath, { opencodeUrl: upstream.url })
    const cookie = await login(testApp.url)
    const promptURL = `${testApp.url}/api/oc/api/session/ses_1/prompt`

    const blocked = await fetch(promptURL, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ text: "read", files: [{ uri: "file:///etc/passwd" }] }),
    })
    expect(blocked.status).toBe(400)
    expect(await blocked.json()).toEqual({ error: "invalid_attachment" })
    expect(upstream.requests.filter((request) => request.path.endsWith("/prompt"))).toHaveLength(0)

    const uploadedDir = join(workspacePath, ".masterhand", "attachments", "ses_1")
    mkdirSync(uploadedDir, { recursive: true })
    const allowedFile = join(uploadedDir, "a1-notes.txt")
    writeFileSync(allowedFile, "hello")
    const allowed = await fetch(promptURL, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        text: "read",
        files: [{ uri: `file://${allowedFile}`, name: "notes.txt" }],
        metadata: { "masterhand.delivery": "d1" },
      }),
    })
    expect(allowed.status).toBe(200)
    const forwarded = upstream.requests.filter((request) => request.path.endsWith("/prompt"))
    expect(forwarded).toHaveLength(1)
    expect(JSON.parse(String(forwarded[0]?.body))).toMatchObject({ files: [{ name: "notes.txt" }] })

    const symlink = join(uploadedDir, "a2-link.txt")
    symlinkSync("/etc/passwd", symlink)
    const blockedLink = await fetch(promptURL, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ text: "read", files: [{ uri: `file://${symlink}` }] }),
    })
    expect(blockedLink.status).toBe(400)
    expect(workspaceRoot).toBeTruthy()
  })
})
