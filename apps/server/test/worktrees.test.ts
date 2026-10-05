import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { createMemoryStore } from "../src/store.js"
import {
  createPullRequest,
  createWorktreeManager,
  gitSlug,
  pullRequestUrl,
  reconcileWorktrees,
  remoteProvider,
  remoteWebUrl,
  worktreeBranch,
  worktreeDir,
  type GitResult,
} from "../src/worktrees.js"

function ok(stdout = ""): GitResult {
  return { status: 0, stdout, stderr: "" }
}

function fail(stderr = "boom"): GitResult {
  return { status: 1, stdout: "", stderr }
}

describe("gitSlug / worktreeBranch / worktreeDir", () => {
  it("sanitizes names into a git-safe segment", () => {
    expect(gitSlug("My App!")).toBe("my-app")
    expect(gitSlug("...")).toBe("workspace")
    expect(gitSlug("Ünïcode")).toBe("n-code")
    expect(gitSlug("a".repeat(80)).length).toBeLessThanOrEqual(40)
  })

  it("builds the branch and directory under the root", () => {
    expect(worktreeBranch("My App", "abc123")).toBe("masterhand/my-app-abc123")
    expect(worktreeDir("/workspace/.worktrees", "My App", "abc123")).toBe(
      "/workspace/.worktrees/My App/abc123",
    )
    expect(() => worktreeDir("/workspace/.worktrees", "..", "abc")).toThrow(/escapes_root/)
  })
})

describe("remote helpers", () => {
  it("detects the provider from https and scp remotes", () => {
    expect(remoteProvider("https://github.com/org/repo.git")).toBe("github")
    expect(remoteProvider("git@github.com:org/repo.git")).toBe("github")
    expect(remoteProvider("https://gitlab.com/org/repo.git")).toBe("gitlab")
    expect(remoteProvider("ssh://git@gitlab.com/org/repo.git")).toBe("gitlab")
    expect(remoteProvider("https://example.com/org/repo.git")).toBeNull()
    expect(remoteProvider(null)).toBeNull()
  })

  it("normalizes the remote into a browsable URL", () => {
    expect(remoteWebUrl("git@github.com:org/repo.git")).toBe("https://github.com/org/repo")
    expect(remoteWebUrl("https://gitlab.com/org/repo.git")).toBe("https://gitlab.com/org/repo")
    expect(remoteWebUrl("not a url at all")).toBeNull()
  })

  it("builds provider-specific compare URLs", () => {
    expect(pullRequestUrl("git@github.com:org/repo.git", "masterhand/app-x", "main")).toBe(
      "https://github.com/org/repo/compare/main...masterhand%2Fapp-x?expand=1",
    )
    expect(pullRequestUrl("https://gitlab.com/org/repo.git", "masterhand/app-x", "main")).toBe(
      "https://gitlab.com/org/repo/-/merge_requests/new?merge_request%5Bsource_branch%5D=masterhand%2Fapp-x",
    )
    expect(pullRequestUrl(null, "b", "main")).toBeNull()
    expect(pullRequestUrl("https://example.com/org/repo.git", "b", "main")).toBeNull()
  })
})

describe("createPullRequest", () => {
  it("returns the PR URL when gh succeeds", () => {
    const runCommand = vi.fn((_command: string, _args: string[], _cwd: string) =>
      ok("Creating pull request\nhttps://github.com/org/repo/pull/7\n"),
    )
    const url = createPullRequest({
      cwd: "/worktree",
      remoteUrl: "git@github.com:org/repo.git",
      branch: "masterhand/app-x",
      baseRef: "main",
      runCommand,
    })
    expect(url).toBe("https://github.com/org/repo/pull/7")
    expect(runCommand.mock.calls[0]?.[0]).toBe("gh")
  })

  it("returns the MR URL when glab succeeds", () => {
    const runCommand = vi.fn((_command: string, _args: string[], _cwd: string) =>
      ok("https://gitlab.com/org/repo/-/merge_requests/3"),
    )
    const url = createPullRequest({
      cwd: "/worktree",
      remoteUrl: "https://gitlab.com/org/repo.git",
      branch: "masterhand/app-x",
      baseRef: "main",
      runCommand,
    })
    expect(url).toBe("https://gitlab.com/org/repo/-/merge_requests/3")
    expect(runCommand.mock.calls[0]?.[0]).toBe("glab")
  })

  it("falls back to null when the CLI fails or is missing", () => {
    const failing = vi.fn(() => fail("not logged in"))
    expect(
      createPullRequest({
        cwd: "/worktree",
        remoteUrl: "git@github.com:org/repo.git",
        branch: "b",
        baseRef: "main",
        runCommand: failing,
      }),
    ).toBeNull()
    expect(
      createPullRequest({
        cwd: "/worktree",
        remoteUrl: "https://example.com/org/repo.git",
        branch: "b",
        baseRef: "main",
        runCommand: failing,
      }),
    ).toBeNull()
  })
})

describe("createWorktreeManager", () => {
  it("only treats a directory as its own repo root", () => {
    const root = createWorktreeManager({ run: vi.fn(() => ok("/repo\n")) })
    expect(root.isRepoRoot("/repo")).toBe(true)

    const nested = createWorktreeManager({ run: vi.fn(() => ok("/parent\n")) })
    expect(nested.isRepoRoot("/parent/workspace/app")).toBe(false)

    const none = createWorktreeManager({ run: vi.fn(() => fail()) })
    expect(none.isRepoRoot("/anything")).toBe(false)
  })

  it("initializes a repo and creates an empty commit when HEAD is missing", () => {
    const calls: string[][] = []
    const run = vi.fn((args: string[]) => {
      calls.push(args)
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return fail()
      if (args[0] === "rev-parse" && args.includes("HEAD")) return fail()
      return ok()
    })
    const manager = createWorktreeManager({ run, userName: "MH", userEmail: "mh@test" })
    manager.ensureRepo("/repo")
    expect(calls[0]).toEqual(["rev-parse", "--show-toplevel"])
    expect(calls[1]).toEqual(["init"])
    expect(calls[2]).toEqual(["rev-parse", "--verify", "HEAD"])
    const commit = calls[3] ?? []
    expect(commit).toContain("commit")
    expect(commit).toContain("--allow-empty")
    expect(commit).toContain("user.name=MH")
  })

  it("initializes a workspace nested inside another repo as its own root", () => {
    const calls: string[][] = []
    const run = vi.fn((args: string[]) => {
      calls.push(args)
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return ok("/parent\n")
      if (args[0] === "rev-parse" && args.includes("HEAD")) return fail()
      return ok()
    })
    const manager = createWorktreeManager({ run, userName: "MH", userEmail: "mh@test" })
    manager.ensureRepo("/parent/workspace/app")
    expect(calls[0]).toEqual(["rev-parse", "--show-toplevel"])
    expect(calls[1]).toEqual(["init"])
  })

  it("does not initialize or commit an existing repo", () => {
    const calls: string[][] = []
    const run = vi.fn((args: string[]) => {
      calls.push(args)
      return ok("/repo\n")
    })
    const manager = createWorktreeManager({ run })
    manager.ensureRepo("/repo")
    expect(calls).toEqual([
      ["rev-parse", "--show-toplevel"],
      ["rev-parse", "--verify", "HEAD"],
    ])
  })

  it("resolves the head branch or a short SHA when detached", () => {
    const run = vi.fn((args: string[]) => {
      if (args[0] === "symbolic-ref") return fail()
      if (args[0] === "rev-parse") return ok("abc1234\n")
      return ok()
    })
    const manager = createWorktreeManager({ run })
    expect(manager.headBranch("/repo")).toBe("abc1234")
  })

  it("creates and removes worktrees with the expected git commands", () => {
    const calls: string[][] = []
    const run = vi.fn((args: string[]) => {
      calls.push(args)
      return ok()
    })
    const manager = createWorktreeManager({ run })
    const dir = mkdtempSync(join(tmpdir(), "mh-wt-"))
    try {
      const path = join(dir, "nested", "app-token")
      manager.create("/repo", path, "masterhand/app-token", "main")
      expect(calls.at(-1)).toEqual([
        "worktree",
        "add",
        "-b",
        "masterhand/app-token",
        path,
        "main",
      ])

      manager.remove("/repo", path, "masterhand/app-token")
      expect(calls.at(-3)).toEqual(["worktree", "remove", "--force", path])
      expect(calls.at(-2)).toEqual(["branch", "-D", "masterhand/app-token"])
      expect(calls.at(-1)).toEqual(["worktree", "prune"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("quarantines an orphan worktree by renaming it and pruning the repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "mh-quarantine-"))
    try {
      const worktree = join(dir, "orphan")
      mkdirSync(worktree, { recursive: true })
      writeFileSync(join(worktree, "uncommitted.txt"), "agent work")
      const calls: string[][] = []
      const run = vi.fn((args: string[]) => {
        calls.push(args)
        return ok()
      })
      const manager = createWorktreeManager({ run })
      const target = manager.quarantine("/repo", worktree)
      expect(existsSync(worktree)).toBe(false)
      expect(existsSync(join(target, "uncommitted.txt"))).toBe(true)
      expect(target.startsWith(`${worktree}.orphaned-`)).toBe(true)
      expect(calls).toEqual([["worktree", "prune"]])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("throws a descriptive error when git fails", () => {
    const run = vi.fn(() => fail("fatal: nope"))
    const manager = createWorktreeManager({ run })
    expect(() => manager.create("/repo", "/tmp/x", "b", "main")).toThrow(/git_worktree_add_failed: fatal: nope/)
  })

  it("parses porcelain worktree output", () => {
    const run = vi.fn(() =>
      ok(
        [
          "worktree /repo",
          "HEAD abc123",
          "branch refs/heads/main",
          "",
          "worktree /root/app/token",
          "HEAD def456",
          "branch refs/heads/masterhand/app-token",
          "",
        ].join("\n"),
      ),
    )
    const manager = createWorktreeManager({ run })
    expect(manager.list("/repo")).toEqual([
      { path: "/repo", head: "abc123", branch: "main" },
      { path: "/root/app/token", head: "def456", branch: "masterhand/app-token" },
    ])
  })

  it("commits only when the index has changes", () => {
    const calls: string[][] = []
    const run = vi.fn((args: string[]) => {
      calls.push(args)
      if (args[0] === "diff" && args.includes("--quiet")) return { status: 1, stdout: "", stderr: "" }
      return ok()
    })
    const manager = createWorktreeManager({ run })
    expect(manager.commitAll("/worktree", "message")).toBe(true)
    expect(calls.at(-1)).toEqual([
      "-c",
      "user.name=MasterHand",
      "-c",
      "user.email=masterhand@localhost",
      "commit",
      "-m",
      "message",
    ])

    const clean = createWorktreeManager({ run: vi.fn(() => ok()) })
    expect(clean.commitAll("/worktree", "message")).toBe(false)
  })

  it("detects remotes and pushes the branch", () => {
    const calls: string[][] = []
    const run = vi.fn((args: string[]) => {
      calls.push(args)
      if (args[0] === "remote" && args.length === 1) return ok("origin\n")
      if (args[0] === "remote") return ok("git@github.com:org/repo.git\n")
      return ok()
    })
    const manager = createWorktreeManager({ run })
    expect(manager.hasRemote("/worktree")).toBe(true)
    expect(manager.remoteUrl("/worktree")).toBe("git@github.com:org/repo.git")
    manager.push("/worktree", "masterhand/app-x")
    expect(calls.at(-1)).toEqual(["push", "-u", "origin", "masterhand/app-x"])
  })
})

describe("reconcileWorktrees", () => {
  const SENTINEL = ".masterhand-volume"

  function fakeManager(overrides: Record<string, unknown> = {}) {
    const quarantine = vi.fn((_repo: string, path: string) => `${path}.orphaned-1`)
    const remove = vi.fn()
    const manager = {
      isRepoRoot: () => true,
      list: () => [] as Array<{ path: string; head: string; branch: string }>,
      ensureRepo: () => {},
      headBranch: () => "main",
      create: () => {},
      remove,
      quarantine,
      commitAll: () => true,
      hasRemote: () => false,
      remoteUrl: () => null,
      push: () => {},
      pullRequest: () => null,
      ...overrides,
    }
    return { manager, quarantine, remove }
  }

  function seedRecord(
    store: ReturnType<typeof createMemoryStore>,
    sessionID: string,
    path: string,
    createdAt: number,
  ): void {
    store.createIsolatedSession({
      sessionID,
      workspaceID: "ws_1",
      path,
      branch: `masterhand/app-${sessionID}`,
      baseRef: "main",
      pushed: false,
      prUrl: null,
      createdAt,
    })
  }

  it("drops stale records and quarantines orphan worktrees when the volume is confirmed", () => {
    const dir = mkdtempSync(join(tmpdir(), "mh-reconcile-"))
    try {
      const root = join(dir, "root")
      mkdirSync(root, { recursive: true })
      writeFileSync(join(root, SENTINEL), "ok")
      const store = createMemoryStore()
      store.createWorkspace({ id: "ws_1", name: "app", path: join(dir, "app"), createdAt: 1 })
      seedRecord(store, "ses_gone", join(dir, "missing"), 1)
      seedRecord(store, "ses_alive", join(dir, "alive"), 2)
      const alivePath = join(dir, "alive")
      mkdirSync(alivePath, { recursive: true })
      const orphanPath = join(root, "app", "orphan")
      const { manager, quarantine, remove } = fakeManager({
        list: () => [
          { path: join(dir, "app"), head: "a", branch: "main" },
          { path: alivePath, head: "b", branch: "b2" },
          { path: orphanPath, head: "c", branch: "c" },
        ],
      })
      const result = reconcileWorktrees(store, manager, root)
      expect(result.skipped).toBeNull()
      expect(result.droppedRecords).toEqual(["ses_gone"])
      expect(result.quarantinedWorktrees).toEqual([`${orphanPath}.orphaned-1`])
      expect(quarantine).toHaveBeenCalledTimes(1)
      expect(quarantine).toHaveBeenCalledWith(join(dir, "app"), orphanPath)
      expect(remove).not.toHaveBeenCalled()
      expect(store.getIsolatedSession("ses_gone")).toBeNull()
      expect(store.getIsolatedSession("ses_alive")).not.toBeNull()
      expect(existsSync(alivePath)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("skips reconciliation when the worktrees root is not mounted", () => {
    const dir = mkdtempSync(join(tmpdir(), "mh-reconcile-"))
    try {
      const store = createMemoryStore()
      store.createWorkspace({ id: "ws_1", name: "app", path: join(dir, "app"), createdAt: 1 })
      seedRecord(store, "ses_gone", join(dir, "missing"), 1)
      const { manager, quarantine, remove } = fakeManager()
      const result = reconcileWorktrees(store, manager, join(dir, "root"))
      expect(result.skipped).toBe("worktrees_root_missing")
      expect(result.droppedRecords).toEqual([])
      expect(result.quarantinedWorktrees).toEqual([])
      expect(store.getIsolatedSession("ses_gone")).not.toBeNull()
      expect(quarantine).not.toHaveBeenCalled()
      expect(remove).not.toHaveBeenCalled()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("does nothing on a fresh install (no root, no records)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mh-reconcile-"))
    try {
      const store = createMemoryStore()
      const { manager, quarantine, remove } = fakeManager()
      const result = reconcileWorktrees(store, manager, join(dir, "root"))
      expect(result.skipped).toBeNull()
      expect(result.droppedRecords).toEqual([])
      expect(result.quarantinedWorktrees).toEqual([])
      expect(quarantine).not.toHaveBeenCalled()
      expect(remove).not.toHaveBeenCalled()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("skips reconciliation when no recorded worktree confirms the volume", () => {
    const dir = mkdtempSync(join(tmpdir(), "mh-reconcile-"))
    try {
      const root = join(dir, "root")
      mkdirSync(root, { recursive: true })
      const store = createMemoryStore()
      store.createWorkspace({ id: "ws_1", name: "app", path: join(dir, "app"), createdAt: 1 })
      seedRecord(store, "ses_gone", join(dir, "missing"), 1)
      const { manager, quarantine, remove } = fakeManager()
      const result = reconcileWorktrees(store, manager, root)
      expect(result.skipped).toBe("volume_unconfirmed")
      expect(result.droppedRecords).toEqual([])
      expect(result.quarantinedWorktrees).toEqual([])
      expect(store.getIsolatedSession("ses_gone")).not.toBeNull()
      expect(quarantine).not.toHaveBeenCalled()
      expect(remove).not.toHaveBeenCalled()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("confirms an existing volume from a live worktree and writes the sentinel", () => {
    const dir = mkdtempSync(join(tmpdir(), "mh-reconcile-"))
    try {
      const root = join(dir, "root")
      mkdirSync(root, { recursive: true })
      const store = createMemoryStore()
      store.createWorkspace({ id: "ws_1", name: "app", path: join(dir, "app"), createdAt: 1 })
      seedRecord(store, "ses_alive", join(dir, "alive"), 1)
      seedRecord(store, "ses_gone", join(dir, "missing"), 2)
      mkdirSync(join(dir, "alive"), { recursive: true })
      const { manager } = fakeManager()
      const result = reconcileWorktrees(store, manager, root)
      expect(result.skipped).toBeNull()
      expect(result.droppedRecords).toEqual(["ses_gone"])
      expect(store.getIsolatedSession("ses_alive")).not.toBeNull()
      expect(existsSync(join(root, SENTINEL))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("confirms an empty mounted volume and writes the sentinel", () => {
    const dir = mkdtempSync(join(tmpdir(), "mh-reconcile-"))
    try {
      const root = join(dir, "root")
      mkdirSync(root, { recursive: true })
      const store = createMemoryStore()
      const { manager, quarantine } = fakeManager()
      const result = reconcileWorktrees(store, manager, root)
      expect(result.skipped).toBeNull()
      expect(result.droppedRecords).toEqual([])
      expect(result.quarantinedWorktrees).toEqual([])
      expect(quarantine).not.toHaveBeenCalled()
      expect(existsSync(join(root, SENTINEL))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("does not quarantine a folder that is already quarantined", () => {
    const dir = mkdtempSync(join(tmpdir(), "mh-reconcile-"))
    try {
      const root = join(dir, "root")
      mkdirSync(root, { recursive: true })
      writeFileSync(join(root, SENTINEL), "ok")
      const store = createMemoryStore()
      store.createWorkspace({ id: "ws_1", name: "app", path: join(dir, "app"), createdAt: 1 })
      const quarantined = join(root, "app", "dead.orphaned-1700000000000")
      const orphanPath = join(root, "app", "live-orphan")
      const { manager, quarantine } = fakeManager({
        list: () => [
          { path: quarantined, head: "a", branch: null },
          { path: orphanPath, head: "b", branch: null },
        ],
      })
      const result = reconcileWorktrees(store, manager, root)
      expect(result.quarantinedWorktrees).toEqual([`${orphanPath}.orphaned-1`])
      expect(quarantine).toHaveBeenCalledTimes(1)
      expect(quarantine).toHaveBeenCalledWith(join(dir, "app"), orphanPath)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
