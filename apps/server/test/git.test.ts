import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { createGitManager, isValidBranchName, type GitResult } from "../src/git.js"

function ok(stdout = ""): GitResult {
  return { status: 0, stdout, stderr: "" }
}

function fail(stderr = "boom"): GitResult {
  return { status: 1, stdout: "", stderr }
}

/** Async git stand-in: records the call and answers like the real binary. */
function gitStub(handler: (args: string[], cwd: string) => GitResult) {
  return vi.fn(async (args: string[], cwd: string) => handler(args, cwd))
}

describe("isValidBranchName", () => {
  it("validates user-provided branch names", () => {
    expect(isValidBranchName("feature/my-branch")).toBe(true)
    expect(isValidBranchName("fix_123.x")).toBe(true)
    expect(isValidBranchName("")).toBe(false)
    expect(isValidBranchName(" leading")).toBe(false)
    expect(isValidBranchName("-flag")).toBe(false)
    expect(isValidBranchName("a..b")).toBe(false)
    expect(isValidBranchName("a//b")).toBe(false)
    expect(isValidBranchName("a/")).toBe(false)
    expect(isValidBranchName("/a")).toBe(false)
    expect(isValidBranchName("a.")).toBe(false)
    expect(isValidBranchName("a.lock")).toBe(false)
    expect(isValidBranchName("a@{b")).toBe(false)
    expect(isValidBranchName("a b")).toBe(false)
    expect(isValidBranchName("a~b")).toBe(false)
    expect(isValidBranchName("a^b")).toBe(false)
    expect(isValidBranchName("a:b")).toBe(false)
    expect(isValidBranchName("a?b")).toBe(false)
    expect(isValidBranchName("a*b")).toBe(false)
    expect(isValidBranchName("a[b")).toBe(false)
    expect(isValidBranchName("a\\b")).toBe(false)
    expect(isValidBranchName("a\u0000b")).toBe(false)
    expect(isValidBranchName("@")).toBe(false)
    expect(isValidBranchName("a".repeat(256))).toBe(false)
  })
})

describe("createGitManager", () => {
  it("only treats a directory as its own repo root", async () => {
    const root = createGitManager({ run: gitStub(() => ok("/repo\n")) })
    expect(await root.isRepoRoot("/repo")).toBe(true)

    const nested = createGitManager({ run: gitStub(() => ok("/parent\n")) })
    expect(await nested.isRepoRoot("/parent/workspace/app")).toBe(false)

    const none = createGitManager({ run: gitStub(() => fail()) })
    expect(await none.isRepoRoot("/anything")).toBe(false)
  })

  it("initializes a repo and creates an empty commit when HEAD is missing", async () => {
    const calls: string[][] = []
    const run = gitStub((args) => {
      calls.push(args)
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return fail()
      if (args[0] === "rev-parse" && args.includes("HEAD")) return fail()
      return ok()
    })
    const manager = createGitManager({ run, userName: "MH", userEmail: "mh@test" })
    await manager.ensureRepo("/repo")
    expect(calls[0]).toEqual(["rev-parse", "--show-toplevel"])
    expect(calls[1]).toEqual(["init"])
    expect(calls[2]).toEqual(["rev-parse", "--verify", "HEAD"])
    const commit = calls[3] ?? []
    expect(commit).toContain("commit")
    expect(commit).toContain("--allow-empty")
    expect(commit).toContain("--no-verify")
    expect(commit).toContain("user.name=MH")
  })

  it("initializes a workspace nested inside another repo as its own root", async () => {
    const calls: string[][] = []
    const run = gitStub((args) => {
      calls.push(args)
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return ok("/parent\n")
      if (args[0] === "rev-parse" && args.includes("HEAD")) return fail()
      return ok()
    })
    const manager = createGitManager({ run, userName: "MH", userEmail: "mh@test" })
    await manager.ensureRepo("/parent/workspace/app")
    expect(calls[0]).toEqual(["rev-parse", "--show-toplevel"])
    expect(calls[1]).toEqual(["init"])
  })

  it("does not initialize or commit an existing repo", async () => {
    const calls: string[][] = []
    const run = gitStub((args) => {
      calls.push(args)
      return ok("/repo\n")
    })
    const manager = createGitManager({ run })
    await manager.ensureRepo("/repo")
    expect(calls).toEqual([
      ["rev-parse", "--show-toplevel"],
      ["rev-parse", "--verify", "HEAD"],
    ])
  })

  it("resolves the head branch or a short SHA when detached", async () => {
    const run = gitStub((args) => {
      if (args[0] === "symbolic-ref") return fail()
      if (args[0] === "rev-parse") return ok("abc1234\n")
      return ok()
    })
    const manager = createGitManager({ run })
    expect(await manager.headBranch("/repo")).toBe("abc1234")
  })

  it("never returns an option-like branch name from HEAD", async () => {
    const run = gitStub((args) => {
      if (args[0] === "symbolic-ref") return ok("--force\n")
      if (args[0] === "rev-parse") return ok("abc1234\n")
      return ok()
    })
    const manager = createGitManager({ run })
    expect(await manager.headBranch("/repo")).toBe("abc1234")

    const valid = gitStub((args) => {
      if (args[0] === "symbolic-ref") return ok("feature/x\n")
      return ok()
    })
    expect(await createGitManager({ run: valid }).headBranch("/repo")).toBe("feature/x")
  })

  it("falls back to HEAD when neither a branch nor a SHA can be read", async () => {
    const run = gitStub(() => ok(""))
    const manager = createGitManager({ run })
    expect(await manager.headBranch("/repo")).toBe("HEAD")
  })

  it("rejects a directory whose toplevel is empty", async () => {
    const manager = createGitManager({ run: gitStub(() => ok("")) })
    expect(await manager.isRepoRoot("/repo")).toBe(false)
  })

  it("lists only the current branch when for-each-ref fails", async () => {
    const run = gitStub((args) => {
      if (args[0] === "symbolic-ref") return ok("main\n")
      if (args[0] === "for-each-ref") return fail("broken refs")
      return ok()
    })
    expect(await createGitManager({ run }).branches("/repo")).toEqual({ current: "main", branches: ["main"] })
  })

  it("prepends a current branch missing from for-each-ref", async () => {
    const run = gitStub((args) => {
      if (args[0] === "symbolic-ref") return ok("feature/x\n")
      if (args[0] === "for-each-ref") return ok("main\n")
      return ok()
    })
    expect(await createGitManager({ run }).branches("/repo")).toEqual({
      current: "feature/x",
      branches: ["feature/x", "main"],
    })
  })

  it("reports a bare exit status when git prints nothing", async () => {
    const run = gitStub((args) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return fail("")
      return { status: 7, stdout: "", stderr: "" }
    })
    await expect(createGitManager({ run }).ensureRepo("/repo")).rejects.toThrow(/git_init_failed: exit 7/)
  })

  it("uses the default author in the initial commit", async () => {
    const calls: string[][] = []
    const run = gitStub((args) => {
      calls.push(args)
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return fail()
      if (args[0] === "rev-parse" && args.includes("HEAD")) return fail()
      return ok()
    })
    await createGitManager({ run }).ensureRepo("/repo")
    expect(calls.at(-1)).toContain("user.name=MasterHand")
    expect(calls.at(-1)).toContain("user.email=masterhand@localhost")
  })

  it("initializes and reads a real repository through the default runner", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mh-git-manager-"))
    try {
      const manager = createGitManager()
      await manager.ensureRepo(dir)
      expect(await manager.isRepoRoot(dir)).toBe(true)
      const head = await manager.headBranch(dir)
      expect(head.length).toBeGreaterThan(0)
      expect((await manager.branches(dir)).branches).toContain(head)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("throws a descriptive error when git fails", async () => {
    const run = gitStub(() => fail("fatal: nope"))
    const manager = createGitManager({ run })
    await expect(manager.ensureRepo("/repo")).rejects.toThrow(/git_init_failed: fatal: nope/)
  })

  it("lists local branches with the current one first", async () => {
    const run = gitStub((args) => {
      if (args[0] === "symbolic-ref") return ok("feature/x\n")
      if (args[0] === "for-each-ref") return ok("main\nfeature/x\n")
      return ok()
    })
    const manager = createGitManager({ run })
    expect(await manager.branches("/repo")).toEqual({
      current: "feature/x",
      branches: ["main", "feature/x"],
    })
  })
})
