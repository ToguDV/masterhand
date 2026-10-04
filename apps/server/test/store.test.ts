import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createMemoryStore, createSqliteStore } from "../src/store.js"

describe("sqlite device store", () => {
  it("persists, touches and removes devices", () => {
    const dir = mkdtempSync(join(tmpdir(), "masterhand-store-"))
    const store = createSqliteStore(join(dir, "test.sqlite"))
    try {
      const device = { id: "dev_1", name: "Laptop", createdAt: 1, lastUsedAt: 1 }
      store.create(device)
      expect(store.get("dev_1")).toMatchObject({ name: "Laptop" })
      expect(store.list()).toHaveLength(1)

      store.touch("dev_1", 99)
      expect(store.get("dev_1")?.lastUsedAt).toBe(99)

      store.remove("dev_1")
      expect(store.get("dev_1")).toBeNull()
      expect(store.list()).toHaveLength(0)
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("memory device store", () => {
  it("behaves like the sqlite store", () => {
    const store = createMemoryStore()
    store.create({ id: "dev_1", name: "Phone", createdAt: 1, lastUsedAt: 1 })
    store.touch("dev_1", 5)
    expect(store.get("dev_1")?.lastUsedAt).toBe(5)
    store.remove("dev_1")
    expect(store.list()).toHaveLength(0)
    store.close()
  })
})

describe("sqlite workspace store", () => {
  it("persists, looks up and removes workspaces", () => {
    const dir = mkdtempSync(join(tmpdir(), "masterhand-store-"))
    const store = createSqliteStore(join(dir, "test.sqlite"))
    try {
      store.createWorkspace({ id: "ws_1", name: "App", path: "/workspace/app", createdAt: 1 })
      store.createWorkspace({ id: "ws_2", name: "Lib", path: "/workspace/lib", createdAt: 2 })

      expect(store.listWorkspaces().map((workspace) => workspace.id)).toEqual(["ws_1", "ws_2"])
      expect(store.getWorkspace("ws_1")).toMatchObject({ name: "App" })
      expect(store.getWorkspaceByPath("/workspace/app")?.id).toBe("ws_1")
      expect(store.getWorkspaceByPath("/workspace/missing")).toBeNull()

      store.removeWorkspace("ws_1")
      expect(store.getWorkspace("ws_1")).toBeNull()
      expect(store.listWorkspaces()).toHaveLength(1)
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("memory workspace store", () => {
  it("behaves like the sqlite store", () => {
    const store = createMemoryStore()
    store.createWorkspace({ id: "ws_1", name: "App", path: "/workspace/app", createdAt: 1 })
    store.createWorkspace({ id: "ws_2", name: "Lib", path: "/workspace/lib", createdAt: 2 })

    expect(store.listWorkspaces().map((workspace) => workspace.id)).toEqual(["ws_1", "ws_2"])
    expect(store.getWorkspaceByPath("/workspace/lib")?.id).toBe("ws_2")
    store.removeWorkspace("ws_2")
    expect(store.listWorkspaces()).toHaveLength(1)
    store.close()
  })
})

describe("audit store", () => {
  const event = {
    at: 1,
    sessionID: "ses_1",
    workspaceID: null,
    kind: "permission_denied" as const,
    command: "pkill -f node",
    reason: "Permission denied: shell",
    source: "opencode" as const,
  }

  it("records, lists newest-first and clears in sqlite", () => {
    const dir = mkdtempSync(join(tmpdir(), "masterhand-store-"))
    const store = createSqliteStore(join(dir, "test.sqlite"))
    try {
      store.recordAudit({ ...event, command: "first" })
      store.recordAudit({ ...event, command: "second" })

      expect(store.listAudit().map((entry) => entry.command)).toEqual(["second", "first"])
      expect(store.listAudit(1)).toHaveLength(1)
      expect(store.listAudit()[0]?.id).toBeGreaterThan(store.listAudit()[1]?.id ?? 0)

      store.clearAudit()
      expect(store.listAudit()).toHaveLength(0)
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("behaves the same in memory and keeps a bounded history", () => {
    const store = createMemoryStore()
    for (let index = 0; index < 520; index += 1) store.recordAudit({ ...event, at: index })
    expect(store.listAudit(1000)).toHaveLength(500)
    store.clearAudit()
    expect(store.listAudit()).toHaveLength(0)
  })
})

describe("preview port store", () => {
  it("persists reserved preview ports in sqlite", () => {
    const dir = mkdtempSync(join(tmpdir(), "masterhand-store-"))
    const store = createSqliteStore(join(dir, "test.sqlite"))
    try {
      store.assignPreviewPort({ sessionID: "ses_1", port: 3200, createdAt: 1 })
      store.assignPreviewPort({ sessionID: "ses_2", port: 3201, createdAt: 2 })

      expect(store.getPreviewPort("ses_1")).toBe(3200)
      expect(store.listPreviewPorts().map((record) => record.sessionID)).toEqual(["ses_1", "ses_2"])

      store.removePreviewPort("ses_1")
      expect(store.getPreviewPort("ses_1")).toBeNull()
      expect(store.listPreviewPorts()).toHaveLength(1)
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("behaves the same in memory", () => {
    const store = createMemoryStore()
    store.assignPreviewPort({ sessionID: "ses_1", port: 3200, createdAt: 1 })
    expect(store.getPreviewPort("ses_1")).toBe(3200)
    store.removePreviewPort("ses_1")
    expect(store.getPreviewPort("ses_1")).toBeNull()
  })
})
