import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  createWorkspaceDir,
  externalWriteGuardRules,
  isInsideRoot,
  normalizeWorkspaceSlug,
  processGuardRules,
  processSystemPrompt,
  removeWorkspaceDir,
  workspaceName,
  workspacePath,
} from "../src/workspaces.js"

describe("normalizeWorkspaceSlug", () => {
  it("accepts plain folder names and trims them", () => {
    expect(normalizeWorkspaceSlug("my-app")).toEqual({ ok: true, slug: "my-app" })
    expect(normalizeWorkspaceSlug("  my app  ")).toEqual({ ok: true, slug: "my app" })
  })

  it("rejects non-string, empty and too-long names", () => {
    expect(normalizeWorkspaceSlug(undefined)).toEqual({ ok: false, error: "invalid_name" })
    expect(normalizeWorkspaceSlug("")).toEqual({ ok: false, error: "invalid_name" })
    expect(normalizeWorkspaceSlug("a".repeat(65))).toEqual({ ok: false, error: "invalid_name" })
  })

  it("rejects traversal, separators and hidden names", () => {
    for (const name of [".", "..", ".git", "a/b", "a\\b", "a\u0000b"]) {
      expect(normalizeWorkspaceSlug(name)).toEqual({ ok: false, error: "invalid_name" })
    }
  })
})

describe("workspacePath", () => {
  it("resolves the slug under the root", () => {
    expect(workspacePath("/workspace", "app")).toBe("/workspace/app")
  })

  it("throws if the slug would escape the root", () => {
    expect(() => workspacePath("/workspace", "../etc")).toThrow(/escapes_root/)
  })
})

describe("isInsideRoot", () => {
  it("is true only for paths strictly inside the root", () => {
    expect(isInsideRoot("/workspace", "/workspace/app")).toBe(true)
    expect(isInsideRoot("/workspace", "/workspace")).toBe(false)
    expect(isInsideRoot("/workspace", "/workspace/../etc")).toBe(false)
    expect(isInsideRoot("/workspace", "/other/app")).toBe(false)
  })
})

describe("workspaceName", () => {
  it("uses the last path segment", () => {
    expect(workspaceName("/workspace/my-app")).toBe("my-app")
  })

  it("falls back to the path for the filesystem root", () => {
    expect(workspaceName("/")).toBe("/")
  })
})

describe("processGuardRules", () => {
  it("denies broad process kills for the v2 shell action and the legacy bash action", () => {
    const rules = processGuardRules()
    expect(rules).toContainEqual({ action: "shell", resource: "pkill*", effect: "deny" })
    expect(rules).toContainEqual({ action: "shell", resource: "killall*", effect: "deny" })
    expect(rules).toContainEqual({ action: "shell", resource: "kill $*", effect: "deny" })
    expect(rules).toContainEqual({ action: "shell", resource: "npm run dev:stop*", effect: "deny" })
    expect(rules).toContainEqual({ action: "bash", resource: "pkill*", effect: "deny" })
    expect(rules.every((rule) => rule.effect === "deny")).toBe(true)
  })

  it("does not deny a numeric kill of the exact PID the agent started", () => {
    // `kill 1234` must stay allowed: it is the supported way to stop a server
    // the agent owns. Only substitutions and signal-all forms are denied.
    const resources = processGuardRules().map((rule) => rule.resource)
    expect(resources).not.toContain("kill *")
    expect(resources).not.toContain("kill")
  })

  it("keeps the write guard independent from the process guard", () => {
    expect(externalWriteGuardRules().map((rule) => rule.action)).toEqual([
      "external_directory",
      "edit",
      "edit",
      "edit",
    ])
  })
})

describe("processSystemPrompt", () => {
  it("forbids broad kills and points at the supported lifecycle", () => {
    const prompt = processSystemPrompt()
    expect(prompt).toContain("never stop processes by name, pattern or port")
    expect(prompt).toContain("kill <that pid>")
    expect(prompt).toContain("Run and Preview controls")
  })
})

describe("createWorkspaceDir / removeWorkspaceDir", () => {
  it("creates nested folders and deletes them recursively", () => {
    const root = mkdtempSync(join(tmpdir(), "masterhand-ws-"))
    try {
      const path = join(root, "nested", "project")
      createWorkspaceDir(path)
      expect(existsSync(path)).toBe(true)

      writeFileSync(join(path, "file.txt"), "x")
      removeWorkspaceDir(path)
      expect(existsSync(path)).toBe(false)
      expect(existsSync(join(root, "nested"))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("removing a missing folder is a no-op", () => {
    const root = mkdtempSync(join(tmpdir(), "masterhand-ws-"))
    try {
      expect(() => removeWorkspaceDir(join(root, "missing"))).not.toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
