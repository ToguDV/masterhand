import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createWorktreeManager, runGitCommand } from "../src/worktrees.js"

/** Prepends a directory to the child PATH (restored even when `work` throws). */
function withPath<T>(dir: string, work: () => Promise<T>): Promise<T> {
  const original = process.env.PATH
  process.env.PATH = `${dir}:${original ?? ""}`
  return work().finally(() => {
    process.env.PATH = original
  })
}

/**
 * Regression for #77: git (and every external CLI) must run through async
 * `spawn`, never `spawnSync`/blocking fs work — a slow Finish & PR used to
 * freeze the whole BFF (no requests, no SSE events) for up to the 60 s git
 * timeout. The shim on PATH makes `git` deterministically slow.
 */
describe("async git runner (#77)", () => {
  const dirs: string[] = []

  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
  })

  function shimGit(script: string): string {
    const dir = mkdtempSync(join(tmpdir(), "mh-git-shim-"))
    dirs.push(dir)
    writeFileSync(join(dir, "git"), `#!/bin/sh\n${script}\n`, { mode: 0o755 })
    return dir
  }

  it("keeps the event loop responsive while git runs", async () => {
    const shim = shimGit("sleep 0.4\necho shim-branch")
    await withPath(shim, async () => {
      const manager = createWorktreeManager()
      const ticks: number[] = []
      const timer = setInterval(() => ticks.push(Date.now()), 10)
      try {
        const branch = await manager.headBranch("/tmp")
        expect(branch).toBe("shim-branch")
      } finally {
        clearInterval(timer)
      }
      // ~40 interval ticks fit in the 400 ms child; a synchronous spawn leaves ~0.
      expect(ticks.length).toBeGreaterThanOrEqual(10)
    })
  })

  it("kills a git command that exceeds its timeout instead of hanging forever", async () => {
    const shim = shimGit("sleep 3")
    await withPath(shim, async () => {
      const manager = createWorktreeManager({ gitTimeoutMs: 200 })
      const started = Date.now()
      const result = await manager.headBranch("/tmp")
      const elapsed = Date.now() - started
      expect(elapsed).toBeLessThan(1500)
      expect(result).not.toBe("shim-branch")
    })
  })
})

/**
 * Regression for #178: a workspace repository is untrusted input. Git must run
 * with a sanitized environment and neutralized repo-controlled execution, so a
 * malicious hook, fsmonitor program or BFF secret in `process.env` never runs
 * or leaks through the BFF.
 */
describe("sandboxed git execution (#178)", () => {
  const dirs: string[] = []

  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
  })

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    dirs.push(dir)
    return dir
  }

  /** Test-setup git must never inherit a leaked GIT_DIR/WORK_TREE/INDEX_FILE
   * (rule 30): with those set, every `git init/config/add/commit` in a temp
   * dir targets the leaked repository instead. */
  function cleanGitEnv(): NodeJS.ProcessEnv {
    const { GIT_DIR: _dir, GIT_WORK_TREE: _work, GIT_INDEX_FILE: _index, ...rest } = process.env
    return rest
  }

  function gitSetup(args: string[], cwd: string): Buffer {
    return execFileSync("git", args, { cwd, env: cleanGitEnv() })
  }

  /** Real repository with one commit and a local identity (setup runs outside the BFF). */
  function makeRepo(): string {
    const dir = tempDir("mh-safe-git-")
    gitSetup(["init", "-q"], dir)
    gitSetup(["config", "user.name", "Test"], dir)
    gitSetup(["config", "user.email", "test@example.com"], dir)
    writeFileSync(join(dir, "README.md"), "init\n")
    gitSetup(["add", "-A"], dir)
    gitSetup(["commit", "-q", "--no-verify", "-m", "init"], dir)
    return dir
  }

  it("ignores a leaked GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE when setting up temp repos (rule 30)", () => {
    const victim = tempDir("mh-git-victim-")
    gitSetup(["init", "-q", "-b", "main"], victim)
    gitSetup(["config", "user.name", "Victim"], victim)
    gitSetup(["config", "user.email", "victim@test.invalid"], victim)
    writeFileSync(join(victim, "base.txt"), "base\n")
    gitSetup(["add", "-A"], victim)
    gitSetup(["commit", "-q", "--no-verify", "-m", "base"], victim)

    const savedDir = process.env.GIT_DIR
    const savedWorkTree = process.env.GIT_WORK_TREE
    const savedIndex = process.env.GIT_INDEX_FILE
    process.env.GIT_DIR = join(victim, ".git")
    process.env.GIT_WORK_TREE = victim
    process.env.GIT_INDEX_FILE = join(victim, ".git", "index")
    try {
      const repo = makeRepo()
      // The victim must keep its identity and its single base commit.
      expect(gitSetup(["config", "user.name"], victim).toString().trim()).toBe("Victim")
      expect(gitSetup(["log", "--format=%s"], victim).toString().trim().split("\n")).toEqual(["base"])
      // The temp repo is a real repo of its own with the Test identity.
      expect(gitSetup(["config", "user.name"], repo).toString().trim()).toBe("Test")
    } finally {
      if (savedDir === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = savedDir
      if (savedWorkTree === undefined) delete process.env.GIT_WORK_TREE
      else process.env.GIT_WORK_TREE = savedWorkTree
      if (savedIndex === undefined) delete process.env.GIT_INDEX_FILE
      else process.env.GIT_INDEX_FILE = savedIndex
    }
  })

  function executable(path: string, body: string): void {
    writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  }

  it("does not run a repository's pre-commit or post-checkout hooks", async () => {
    const repo = makeRepo()
    const marker = join(repo, "hook-ran")
    executable(join(repo, ".git", "hooks", "pre-commit"), `echo ran >> "${marker}"`)
    executable(join(repo, ".git", "hooks", "post-checkout"), `echo ran >> "${marker}"`)
    writeFileSync(join(repo, "change.txt"), "agent work\n")

    const manager = createWorktreeManager()
    expect(await manager.commitAll(repo, "agent work")).toBe(true)
    await manager.createBranch(repo, "feature/hooks")

    expect(existsSync(marker)).toBe(false)
  })

  it("neutralizes a repo-local core.hooksPath without rejecting it (husky)", async () => {
    const repo = makeRepo()
    const marker = join(repo, "husky-ran")
    const hooks = join(repo, ".husky", "_")
    mkdirSync(hooks, { recursive: true })
    executable(join(hooks, "pre-commit"), `echo ran >> "${marker}"`)
    gitSetup(["config", "core.hooksPath", hooks], repo)
    writeFileSync(join(repo, "change.txt"), "agent work\n")

    // Legitimate (husky) repos set this; the command-scope override disables
    // the hooks, so the preflight does not need to reject the repository.
    const manager = createWorktreeManager()
    expect(await manager.commitAll(repo, "agent work")).toBe(true)
    expect(existsSync(marker)).toBe(false)
  })

  it("never runs core.fsmonitor and rejects the unsafe local config", async () => {
    const repo = makeRepo()
    const marker = join(repo, "fsmonitor-ran")
    const script = join(repo, "fsmonitor.sh")
    executable(script, `echo ran > "${marker}"\nexit 0`)
    gitSetup(["config", "core.fsmonitor", script], repo)
    writeFileSync(join(repo, "dirty.txt"), "agent work\n")

    // Layer 1: the sanitized child env alone disables the program.
    const status = await runGitCommand(["status", "--porcelain"], repo)
    expect(status.status).toBe(0)
    expect(existsSync(marker)).toBe(false)

    // Layer 2: the manager preflight refuses to touch the repository at all.
    const manager = createWorktreeManager()
    await expect(manager.isDirty(repo)).rejects.toThrow(/unsafe_git_config/)
    expect(existsSync(marker)).toBe(false)
  })

  it("rejects repo-local config that could execute commands", async () => {
    const repo = makeRepo()
    const keys: Array<[string, string]> = [
      ["filter.evil.clean", "cat"],
      ["filter.evil.smudge", "cat"],
      ["filter.evil.process", "cat"],
      ["diff.evil.command", "cat"],
      ["diff.evil.textconv", "cat"],
      ["merge.evil.driver", "cat"],
      ["include.path", join(repo, "extra.gitconfig")],
      ["credential.https://github.com.helper", "!evil"],
      ["commit.gpgSign", "true"],
      ["core.worktree", "/"],
      ["url.https://evil.example/.insteadOf", "https://github.com/"],
      ["submodule.evil.update", "!evil"],
    ]
    for (const [key, value] of keys) {
      gitSetup(["config", key, value], repo)
    }

    const manager = createWorktreeManager()
    await expect(manager.isDirty(repo)).rejects.toThrow(/unsafe_git_config/)
  })

  it("passes no BFF secrets to git children", async () => {
    const dir = tempDir("mh-git-env-")
    const dump = join(dir, "env.txt")
    const bin = join(dir, "bin")
    mkdirSync(bin)
    executable(join(bin, "git"), `env > "${dump}"`)

    const saved = {
      PATH: process.env.PATH,
      SESSION_SECRET: process.env.SESSION_SECRET,
      MASTERHAND_PASSWORD: process.env.MASTERHAND_PASSWORD,
      OPENCODE_SERVER_PASSWORD: process.env.OPENCODE_SERVER_PASSWORD,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      GH_TOKEN: process.env.GH_TOKEN,
      GIT_ASKPASS: process.env.GIT_ASKPASS,
    }
    process.env.SESSION_SECRET = "super-secret-session"
    process.env.MASTERHAND_PASSWORD = "super-secret-password"
    process.env.OPENCODE_SERVER_PASSWORD = "super-secret-opencode"
    process.env.OPENAI_API_KEY = "sk-super-secret-provider"
    process.env.GH_TOKEN = "ghp_super_secret"
    process.env.GIT_ASKPASS = "/tmp/masterhand-askpass.sh"

    try {
      await withPath(bin, () => runGitCommand(["rev-parse", "--show-toplevel"], dir))
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }

    const env = readFileSync(dump, "utf8")
    expect(env).not.toContain("SESSION_SECRET")
    expect(env).not.toContain("super-secret-session")
    expect(env).not.toContain("MASTERHAND_PASSWORD")
    expect(env).not.toContain("super-secret-password")
    expect(env).not.toContain("OPENCODE_SERVER_PASSWORD")
    expect(env).not.toContain("super-secret-opencode")
    expect(env).not.toContain("OPENAI_API_KEY")
    expect(env).not.toContain("sk-super-secret-provider")
    expect(env).not.toContain("GH_TOKEN")
    expect(env).not.toContain("ghp_super_secret")
    expect(env).toContain("HOME=")
    expect(env).toContain("GIT_TERMINAL_PROMPT=0")
    // Explicit operator credentials are the only channels kept.
    expect(env).toContain("GIT_ASKPASS=/tmp/masterhand-askpass.sh")

    // safe.directory is scoped to the exact repository, never `*`.
    const dumped: Record<string, string> = {}
    for (const line of env.split("\n")) {
      const separator = line.indexOf("=")
      if (separator > 0) dumped[line.slice(0, separator)] = line.slice(separator + 1)
    }
    const safeValueKeys = Object.entries(dumped)
      .filter(([key, value]) => /^GIT_CONFIG_KEY_\d+$/.test(key) && value === "safe.directory")
      .map(([key]) => `GIT_CONFIG_VALUE_${key.slice("GIT_CONFIG_KEY_".length)}`)
    expect(safeValueKeys.length).toBeGreaterThan(0)
    for (const key of safeValueKeys) expect([realpathSync(dir), dir]).toContain(dumped[key])
    expect(Object.values(dumped)).not.toContain("*")
  })
})
