import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createGitManager, runGitCommand } from "../src/git.js"

/** Prepends a directory to the child PATH (restored even when `work` throws). */
function withPath<T>(dir: string, work: () => Promise<T>): Promise<T> {
  const original = process.env.PATH
  process.env.PATH = `${dir}:${original ?? ""}`
  return work().finally(() => {
    process.env.PATH = original
  })
}

/** Replaces PATH entirely, so a missing binary cannot leak in from the host. */
function withOnlyPath<T>(dir: string, work: () => Promise<T>): Promise<T> {
  const original = process.env.PATH
  process.env.PATH = dir
  return work().finally(() => {
    process.env.PATH = original
  })
}

/**
 * Regression for #77: git (and every external CLI) must run through async
 * `spawn`, never `spawnSync`/blocking fs work — a slow git command used to
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
      const manager = createGitManager()
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
      const manager = createGitManager({ gitTimeoutMs: 200 })
      const started = Date.now()
      const result = await manager.headBranch("/tmp")
      const elapsed = Date.now() - started
      expect(elapsed).toBeLessThan(1500)
      expect(result).not.toBe("shim-branch")
    })
  })

  it("refuses to spawn when the signal is already aborted", async () => {
    const result = await runGitCommand(["rev-parse", "--show-toplevel"], "/tmp", {
      signal: AbortSignal.abort(),
    })
    expect(result.status).toBe(-1)
    expect(result.stderr).toContain("was cancelled")
  })

  it("aborts a running git child and reports cancellation", async () => {
    const shim = shimGit("sleep 3")
    await withPath(shim, async () => {
      const controller = new AbortController()
      const pending = runGitCommand(["--version"], "/tmp", { signal: controller.signal })
      setTimeout(() => controller.abort(), 50)
      const result = await pending
      expect(result.status).toBe(-1)
      expect(result.stderr).toMatch(/abort|cancel/i)
    })
  })

  it("surfaces a missing git binary instead of hanging", async () => {
    const empty = mkdtempSync(join(tmpdir(), "mh-no-git-"))
    dirs.push(empty)
    await withOnlyPath(empty, async () => {
      const result = await runGitCommand(["--version"], "/tmp")
      expect(result.status).toBe(-1)
      expect(result.stderr.length).toBeGreaterThan(0)
    })
  })

  it("falls back to the default PATH when the environment has none", async () => {
    const original = process.env.PATH
    delete process.env.PATH
    try {
      const result = await runGitCommand(["--version"], "/tmp")
      expect(result.status).toBe(0)
    } finally {
      process.env.PATH = original
    }
  })

  it("scopes safe.directory to both the real and the symlinked path", async () => {
    const real = mkdtempSync(join(tmpdir(), "mh-git-real-"))
    const linkRoot = mkdtempSync(join(tmpdir(), "mh-git-link-"))
    dirs.push(real, linkRoot)
    const link = join(linkRoot, "repo")
    symlinkSync(real, link)
    const shim = shimGit("env")
    await withPath(shim, async () => {
      const result = await runGitCommand(["status"], link)
      expect(result.stdout).toContain(`GIT_CONFIG_VALUE_5=${realpathSync(real)}`)
      expect(result.stdout).toContain(`GIT_CONFIG_VALUE_6=${link}`)
    })
  })

  it("caps stdout from a runaway git command", async () => {
    const shim = shimGit("head -c 5000000 /dev/zero")
    await withPath(shim, async () => {
      const result = await runGitCommand(["--version"], "/tmp")
      expect(result.status).toBe(0)
      expect(result.stdout.length).toBe(4 * 1024 * 1024)
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

  it("does not run a repository's hooks while initializing", async () => {
    const repo = tempDir("mh-hooks-")
    gitSetup(["init", "-q"], repo)
    const marker = join(repo, "hook-ran")
    executable(join(repo, ".git", "hooks", "pre-commit"), `echo ran >> "${marker}"`)
    executable(join(repo, ".git", "hooks", "post-checkout"), `echo ran >> "${marker}"`)

    const manager = createGitManager()
    await manager.ensureRepo(repo)

    expect(existsSync(marker)).toBe(false)
  })

  it("neutralizes a repo-local core.hooksPath without rejecting it (husky)", async () => {
    const repo = tempDir("mh-husky-")
    gitSetup(["init", "-q"], repo)
    const marker = join(repo, "husky-ran")
    const hooks = join(repo, ".husky", "_")
    mkdirSync(hooks, { recursive: true })
    executable(join(hooks, "pre-commit"), `echo ran >> "${marker}"`)
    gitSetup(["config", "core.hooksPath", hooks], repo)

    // Legitimate (husky) repos set this; the command-scope override disables
    // the hooks, so the preflight does not need to reject the repository.
    const manager = createGitManager()
    await manager.ensureRepo(repo)
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
    const preflightRepo = tempDir("mh-fsmonitor-")
    gitSetup(["init", "-q"], preflightRepo)
    gitSetup(["config", "core.fsmonitor", script], preflightRepo)
    const manager = createGitManager()
    await expect(manager.ensureRepo(preflightRepo)).rejects.toThrow(/unsafe_git_config/)
    expect(existsSync(marker)).toBe(false)
  })

  it("rejects repo-local config that could execute commands", async () => {
    const repo = tempDir("mh-unsafe-config-")
    gitSetup(["init", "-q"], repo)
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

    const manager = createGitManager()
    await expect(manager.ensureRepo(repo)).rejects.toThrow(/unsafe_git_config/)
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
      GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND,
    }
    process.env.SESSION_SECRET = "super-secret-session"
    process.env.MASTERHAND_PASSWORD = "super-secret-password"
    process.env.OPENCODE_SERVER_PASSWORD = "super-secret-opencode"
    process.env.OPENAI_API_KEY = "sk-super-secret-provider"
    process.env.GH_TOKEN = "ghp_super_secret"
    process.env.GIT_ASKPASS = "/tmp/masterhand-askpass.sh"
    process.env.GIT_SSH_COMMAND = "ssh -i /tmp/masterhand-key"

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
    expect(env).toContain("GIT_SSH_COMMAND=ssh -i /tmp/masterhand-key")

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
