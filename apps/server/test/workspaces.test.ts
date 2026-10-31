import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  createWorkspaceDir,
  engineReadGuardRules,
  externalAccessGuardRules,
  isInsideRoot,
  normalizeWorkspaceSlug,
  processGuardRules,
  processSystemPrompt,
  removeWorkspaceDir,
  workspaceName,
  workspacePath,
  workspaceSystemPrompt,
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

  it("allows external access without confining writes to the workspace", () => {
    expect(externalAccessGuardRules()).toEqual([
      { action: "external_directory", resource: "*", effect: "allow" },
    ])
  })
})

describe("engineReadGuardRules (#219)", () => {
  it("denies read and external_directory on /proc and reads/edits of the engine store", () => {
    const rules = engineReadGuardRules("/home/tester")
    expect(rules.length).toBeGreaterThan(0)
    expect(rules.every((rule) => rule.effect === "deny")).toBe(true)
    // /proc/self/environ carries OPENCODE_SERVER_PASSWORD in the engine process.
    expect(rules).toContainEqual({ action: "read", resource: "/proc/*", effect: "deny" })
    expect(rules).toContainEqual({ action: "external_directory", resource: "/proc/*", effect: "deny" })
    // opencode.db (the credential store) and the provider config file.
    expect(rules).toContainEqual({
      action: "read",
      resource: "/home/tester/.local/share/opencode/*",
      effect: "deny",
    })
    expect(rules).toContainEqual({
      action: "read",
      resource: "/home/tester/.config/opencode/*",
      effect: "deny",
    })
    expect(rules).toContainEqual({
      action: "external_directory",
      resource: "/home/tester/.local/share/opencode/*",
      effect: "deny",
    })
    expect(rules).toContainEqual({
      action: "edit",
      resource: "/home/tester/.config/opencode/*",
      effect: "deny",
    })
    // The Docker engine paths are covered even when the BFF resolves a
    // different home (the BFF and the engine are different containers).
    expect(rules).toContainEqual({
      action: "read",
      resource: "/home/node/.local/share/opencode/*",
      effect: "deny",
    })
    expect(rules).toContainEqual({
      action: "read",
      resource: "/home/node/.config/opencode/*",
      effect: "deny",
    })
  })

  it("has no grep/glob rules: their resource is the search pattern, never the path", () => {
    // Verified against the pinned 2.0.6 source: grep/glob assert
    // `action: name, resources: [input.pattern]` and gate the path through
    // `authorizeExternal` (action `external_directory`). A path-shaped deny on
    // the grep/glob actions could therefore never match a real call, while the
    // external_directory denies above do gate their path.
    const actions = engineReadGuardRules("/home/tester").map((rule) => rule.action)
    expect(actions).not.toContain("grep")
    expect(actions).not.toContain("glob")
    expect(new Set(actions)).toEqual(new Set(["read", "external_directory", "edit"]))
  })

  it("only matches absolute resources, so workspace-relative reads stay allowed", () => {
    // opencode tags workspace files with a plain relative resource and engine
    // paths with an absolute one (verified against 2.0.6 file-access.ts). Every
    // deny here is absolute, so `notes.md` or `sub/dir` never match one.
    const resources = engineReadGuardRules("/home/tester").map((rule) => rule.resource)
    expect(resources.length).toBeGreaterThan(0)
    for (const resource of resources) {
      expect(resource.startsWith("/") || resource.startsWith("?:")).toBe(true)
    }
    // Residual, documented in docs/bff/api.md: the match is lexical, so a
    // symlink inside the workspace pointing outside still resolves to a
    // relative resource and passes this guard. Permission rules cannot cover
    // that escape; the engine uid boundary (agent-exec) is the mitigation for
    // shell/PTY paths, and the engine data/config files stay owner-only.
  })

  it("dedupes the Docker paths when home already resolves to them", () => {
    const rules = engineReadGuardRules("/home/node")
    const seen = rules.map((rule) => `${rule.action} ${rule.resource}`)
    expect(new Set(seen).size).toBe(seen.length)
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

describe("workspaceSystemPrompt", () => {
  it("roots the agent in its workspace while allowing justified external work", () => {
    const prompt = workspaceSystemPrompt("/workspace/app")
    expect(prompt).toContain("Your working directory is exactly /workspace/app")
    expect(prompt).toContain("100% necessary")
    expect(prompt).toContain("user explicitly indicates")
    expect(prompt).not.toContain("only area you own")
  })
})

describe("createWorkspaceDir / removeWorkspaceDir", () => {
  it("creates nested folders and deletes them recursively", async () => {
    const root = mkdtempSync(join(tmpdir(), "masterhand-ws-"))
    try {
      const path = join(root, "nested", "project")
      await createWorkspaceDir(path)
      expect(existsSync(path)).toBe(true)

      writeFileSync(join(path, "file.txt"), "x")
      await removeWorkspaceDir(path)
      expect(existsSync(path)).toBe(false)
      expect(existsSync(join(root, "nested"))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("removing a missing folder is a no-op", async () => {
    const root = mkdtempSync(join(tmpdir(), "masterhand-ws-"))
    try {
      await expect(removeWorkspaceDir(join(root, "missing"))).resolves.toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
