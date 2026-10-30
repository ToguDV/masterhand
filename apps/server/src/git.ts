import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const GIT_TIMEOUT_MS = 60_000
/** Output kept from a slow git call; enough for porcelain listings, no unbounded memory. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024

export interface GitResult {
  status: number
  stdout: string
  stderr: string
}

export interface GitRunOptions {
  /** Kills the process once exceeded (SIGKILL); defaults to `gitTimeoutMs`/60 s. */
  timeoutMs?: number
  /** Cancels the child (e.g. request aborted / shutdown); the process is killed. */
  signal?: AbortSignal
}

/**
 * Runs `git <args>` inside `cwd` through async `spawn`, never `spawnSync`: a slow
 * command must not freeze the BFF's event loop (requests, SSE pings, other
 * clients keep working). Injectable so tests never spawn git.
 */
export type GitRunner = (args: string[], cwd: string, options?: GitRunOptions) => Promise<GitResult>

export interface GitManagerOptions {
  run?: GitRunner
  userName?: string
  userEmail?: string
  /** Deadline for every git call (also injectable for tests). */
  gitTimeoutMs?: number
}

export interface GitManager {
  /** True when `path` is the root of its own git work tree, not merely inside one. */
  isRepoRoot(path: string): Promise<boolean>
  /** Initializes `path` as its own repo (and an empty first commit) when it is not one yet. */
  ensureRepo(path: string): Promise<void>
  /** Current branch name, or a short SHA when HEAD is detached. */
  headBranch(path: string): Promise<string>
  /** Local branches, current one first-class. */
  branches(repoPath: string): Promise<{ current: string; branches: string[] }>
}

/**
 * Collects a child's stdout/stderr as UTF-8 and resolves with its exit status.
 * A timeout (or an aborted signal) kills the process; the result then carries a
 * descriptive `stderr` so callers can tell "timed out" from "failed".
 */
function spawnResult(
  command: string,
  args: string[],
  cwd: string,
  options: { timeoutMs: number; env: NodeJS.ProcessEnv; signal?: AbortSignal },
): Promise<GitResult> {
  return new Promise((resolvePromise) => {
    // An already-expired operation budget must not spawn (let alone wait on)
    // a child it can no longer use.
    if (options.signal?.aborted) {
      resolvePromise({ status: -1, stdout: "", stderr: `${command} was cancelled` })
      return
    }
    let child: ChildProcess
    try {
      child = spawn(command, args, {
        cwd,
        env: options.env,
        signal: options.signal,
        stdio: ["ignore", "pipe", "pipe"],
        // Own process group: a timeout can kill the whole tree (git hooks,
        // credential helpers, shells' children), not just the direct child.
        detached: process.platform !== "win32",
      })
    } catch (error) {
      resolvePromise({
        status: -1,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      })
      return
    }

    let stdout = ""
    let stderr = ""
    let settled = false
    let killedBy: "timeout" | "signal" | null = null

    const finish = (result: GitResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(result)
    }

    const kill = (reason: "timeout" | "signal"): void => {
      if (killedBy) return
      killedBy = reason
      const pid = child.pid
      try {
        if (pid && process.platform !== "win32") process.kill(-pid, "SIGKILL")
        else child.kill("SIGKILL")
      } catch {
        try {
          child.kill("SIGKILL")
        } catch {
          // already gone
        }
      }
    }

    const timer = setTimeout(() => kill("timeout"), options.timeoutMs)
    const onAbort = (): void => kill("signal")
    options.signal?.addEventListener("abort", onAbort, { once: true })

    const append = (current: string, chunk: Buffer): string =>
      current.length >= MAX_OUTPUT_BYTES ? current : (current + chunk.toString("utf8")).slice(0, MAX_OUTPUT_BYTES)

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk)
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk)
    })
    child.on("error", (error) => {
      options.signal?.removeEventListener("abort", onAbort)
      finish({ status: -1, stdout, stderr: stderr || error.message })
    })
    child.on("close", (code) => {
      options.signal?.removeEventListener("abort", onAbort)
      const suffix =
        killedBy === "timeout"
          ? `\n${command} timed out after ${options.timeoutMs}ms`
          : killedBy === "signal"
            ? `\n${command} was cancelled`
            : ""
      finish({ status: code ?? -1, stdout, stderr: stderr + suffix })
    })
  })
}

/**
 * Workspace repositories are untrusted input: agents and cloned projects
 * control `.git/config`, hooks and attributes. Two layers keep that content
 * from executing programs inside the BFF (issue #178):
 *
 * 1. Git children never inherit `process.env`. They get PATH, a private empty
 *    HOME and explicit variables only, plus `GIT_CONFIG_*` overrides. Those
 *    overrides are command-scope config, so they beat system/global/local/
 *    worktree files and are inherited by any git process the CLI spawns.
 * 2. `createGitManager` preflights the repository-local config and refuses keys
 *    that can execute a program or include more config.
 *
 * Residual risk: the preflight is a deny-list and runs immediately before each
 * operation, so a writer that rewrites `.git/config` between the check and the
 * command (TOCTOU) could still add a vector this list does not cover. The
 * vectors reachable from the commands run here (hooks, fsmonitor, credential
 * helpers, SSH command, filters/diff/merge drivers, includes) are both denied
 * and — where git exposes an env override — neutralized. System/global config
 * stays trusted operator config; the temp HOME guarantees git never reads the
 * BFF user's `~/.gitconfig`.
 */
const UNSAFE_LOCAL_CONFIG =
  /^(filter\..*\.(clean|smudge|process)|diff\..*\.(command|textconv)|diff\.external|merge\..*\.driver|include\..*|includeif\..*\.path|credential\..*|core\.(fsmonitor|sshcommand|worktree|askpass)|commit\.gpgsign|gpg\.program|url\..*\.insteadof|submodule\..*\.update)$/

/**
 * Forced on every git child. `GIT_CONFIG_*` entries are applied at command
 * scope (after every config file), so repo-local values cannot win.
 */
const NEUTRALIZED_GIT_CONFIG: ReadonlyArray<readonly [string, string]> = [
  // /dev/null disables every hook without needing a writable directory.
  ["core.hooksPath", "/dev/null"],
  ["core.fsmonitor", "false"],
  // An empty helper resets the list, so a repo cannot point credentials at a script.
  ["credential.helper", ""],
  ["core.sshCommand", ""],
  // Signing would execute a repo-configured gpg program on every commit.
  ["commit.gpgSign", "false"],
]

/** Private empty HOME for git children; nothing from the BFF user's home is reachable. */
let gitHome: string | null = null
function isolatedGitHome(): string {
  gitHome ??= mkdtempSync(join(tmpdir(), "masterhand-git-home-"))
  return gitHome
}

/**
 * Environment for git children. The allowlist is deliberate: BFF secrets
 * (SESSION_SECRET, MASTERHAND_PASSWORD, OPENCODE_SERVER_PASSWORD, provider keys)
 * and provider tokens must never reach a repo-controlled process.
 *
 * `safe.directory` is scoped to the exact repository path being operated on
 * (command-scope config, verified against git 2.39): the image-level
 * `safe.directory /workspace` does not cover `/workspace/<name>`, and a `*`
 * would trust every repository in the container. Only paths the BFF itself
 * resolved from its workspace record reach this function.
 */
function sanitizedGitEnv(extra: NodeJS.ProcessEnv = {}, cwd?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: isolatedGitHome(),
    // Never block waiting for credentials on the server.
    GIT_TERMINAL_PROMPT: "0",
    ...extra,
  }
  // Operator-provided credential helpers (deployment runbook): still explicit,
  // never inherited wholesale. Neither is ever repo-controlled.
  if (process.env.GIT_SSH_COMMAND) env.GIT_SSH_COMMAND = process.env.GIT_SSH_COMMAND
  if (process.env.GIT_ASKPASS) env.GIT_ASKPASS = process.env.GIT_ASKPASS
  const config: Array<readonly [string, string]> = [...NEUTRALIZED_GIT_CONFIG]
  if (cwd) {
    const root = realpathSyncSafe(cwd)
    config.push(["safe.directory", root])
    if (root !== cwd) config.push(["safe.directory", cwd])
  }
  env.GIT_CONFIG_COUNT = String(config.length)
  config.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key
    env[`GIT_CONFIG_VALUE_${index}`] = value
  })
  return env
}

/**
 * Only commands that can invoke repository-controlled code need the preflight:
 * hooks/fsmonitor on `commit`. Read-only plumbing (`rev-parse`, `symbolic-ref`,
 * `for-each-ref`) cannot execute repo content, and the env overrides already
 * neutralize the vectors that apply there.
 */
function needsConfigPreflight(args: string[]): boolean {
  // Global options precede the subcommand (`-c key=value`, `-C path`); the
  // first bare token is the command the preflight needs to classify. Only
  // `commit` can execute repository-controlled hooks among the operations
  // this manager runs.
  let index = 0
  while (index < args.length) {
    const arg = args[index] as string
    if (arg === "-c" || arg === "-C") {
      index += 2
      continue
    }
    if (arg.startsWith("-")) {
      index += 1
      continue
    }
    return arg === "commit"
  }
  return false
}

/**
 * Refuses a repository whose local config can execute code. Uses `spawnResult`
 * directly (not the injectable runner) to avoid recursion, and only fails on a
 * match: status 1 (no match) and non-repo errors let the real command report.
 */
async function assertSafeLocalConfig(cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  const unsafe = new Set<string>()
  // `--local` is `.git/config`; with `extensions.worktreeConfig` a repo can also
  // carry keys in `.git/config.worktree`, so both scopes are checked.
  for (const scope of ["--local", "--worktree"]) {
    const result = await spawnResult(
      "git",
      ["config", scope, "--name-only", "--get-regexp", UNSAFE_LOCAL_CONFIG.source],
      cwd,
      { timeoutMs, env: sanitizedGitEnv({}, cwd), signal },
    )
    if (result.status !== 0) continue
    for (const line of result.stdout.split("\n")) {
      const key = line.trim()
      // Only a key from the deny-list is fatal: a broken/foreign `git` must not
      // turn arbitrary output into an unsafe_git_config error.
      if (key && UNSAFE_LOCAL_CONFIG.test(key)) unsafe.add(key)
    }
  }
  if (unsafe.size > 0) {
    throw new Error(`unsafe_git_config: ${[...unsafe].sort().join(", ")}`)
  }
}

/** Default async git runner; exported for tests and for callers needing a custom cwd env. */
export function runGitCommand(args: string[], cwd: string, options: GitRunOptions = {}): Promise<GitResult> {
  return spawnResult("git", args, cwd, {
    timeoutMs: options.timeoutMs ?? GIT_TIMEOUT_MS,
    signal: options.signal,
    env: sanitizedGitEnv({}, cwd),
  })
}

export function createGitManager(options: GitManagerOptions = {}): GitManager {
  const run = options.run ?? ((args, cwd, runOptions) => runGitCommand(args, cwd, runOptions))
  const gitTimeoutMs = options.gitTimeoutMs ?? GIT_TIMEOUT_MS
  const userName = options.userName ?? "MasterHand"
  const userEmail = options.userEmail ?? "masterhand@localhost"

  async function git(args: string[], cwd: string, runOptions: GitRunOptions = {}): Promise<GitResult> {
    if (needsConfigPreflight(args)) await assertSafeLocalConfig(cwd, gitTimeoutMs, runOptions.signal)
    return run(args, cwd, { timeoutMs: gitTimeoutMs, ...runOptions })
  }

  async function gitOrThrow(
    args: string[],
    cwd: string,
    context: string,
    runOptions: GitRunOptions = {},
  ): Promise<GitResult> {
    const result = await git(args, cwd, runOptions)
    if (result.status !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`
      throw new Error(`${context}: ${detail}`)
    }
    return result
  }

  const authorArgs = ["-c", `user.name=${userName}`, "-c", `user.email=${userEmail}`]

  return {
    async isRepoRoot(path) {
      const result = await git(["rev-parse", "--show-toplevel"], path)
      if (result.status !== 0) return false
      const top = result.stdout.trim()
      if (!top) return false
      const topReal = realpathSyncSafe(top)
      const pathReal = realpathSyncSafe(path)
      return topReal === pathReal || resolve(top) === resolve(path)
    },

    async ensureRepo(path) {
      if (!(await this.isRepoRoot(path))) {
        await gitOrThrow(["init"], path, "git_init_failed")
      }
      const head = await git(["rev-parse", "--verify", "HEAD"], path)
      if (head.status !== 0) {
        await gitOrThrow(
          [...authorArgs, "commit", "--no-verify", "--allow-empty", "-m", "Initial commit"],
          path,
          "git_commit_failed",
        )
      }
    },

    async headBranch(path) {
      const branch = await git(["symbolic-ref", "--short", "HEAD"], path)
      // A HEAD pointing at an option-like ref (`refs/heads/--force`) must never
      // be fed back to git as an argument (issue #209).
      const name = branch.status === 0 ? branch.stdout.trim() : ""
      if (name && isValidBranchName(name)) return name
      const sha = await git(["rev-parse", "--short", "HEAD"], path)
      return sha.stdout.trim() || "HEAD"
    },

    async branches(repoPath) {
      const current = await this.headBranch(repoPath)
      const result = await git(
        ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
        repoPath,
      )
      if (result.status !== 0) return { current, branches: [current] }
      const branches = result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
      if (current && !branches.includes(current)) branches.unshift(current)
      return { current, branches }
    },
  }
}

/** `realpathSync` that keeps the original value when it cannot be resolved. */
function realpathSyncSafe(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** Branch names git accepts; mirrors `git check-ref-format --branch` closely. */
export function isValidBranchName(name: string): boolean {
  if (!name || name.length > 255) return false
  if (name.startsWith("-") || name.endsWith("/") || name.endsWith(".") || name.endsWith(".lock")) return false
  if (name === "@" || name.includes("..") || name.includes("@{") || name.includes("//")) return false
  if (/[\s~^:?*\[\]\\\u0000-\u001f\u007f]/.test(name)) return false
  const segments = name.split("/")
  return segments.every(
    (segment) => segment.length > 0 && !segment.startsWith(".") && !segment.endsWith(".lock"),
  )
}
