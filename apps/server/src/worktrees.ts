import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { existsSync, mkdtempSync, realpathSync } from "node:fs"
import { mkdir, rename, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve, sep } from "node:path"
import type { Store } from "./store.js"

const GIT_TIMEOUT_MS = 60_000
const MAX_BRANCH_SEGMENT = 40
/** Output kept from a slow git/CLI call; enough for porcelain listings, no unbounded memory. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024

/** Marker written by a successful reconciliation; its absence flags an unconfirmed volume. */
export const VOLUME_SENTINEL = ".masterhand-volume"
/** Suffix of a quarantined orphan worktree (kept on disk, never re-quarantined). */
export const ORPHAN_SUFFIX = ".orphaned-"

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
 * commit/push must not freeze the BFF's event loop (requests, SSE pings, other
 * clients keep working). Injectable so tests never spawn git.
 */
export type GitRunner = (args: string[], cwd: string, options?: GitRunOptions) => Promise<GitResult>

export interface WorktreeInfo {
  path: string
  head: string | null
  branch: string | null
}

export interface WorktreeManagerOptions {
  run?: GitRunner
  /** Runner for `gh`/`glab`; injectable so tests never spawn them. */
  runCommand?: CommandRunner
  userName?: string
  userEmail?: string
  /** Deadline for every git call (also injectable for tests). */
  gitTimeoutMs?: number
}

export interface WorktreeManager {
  /** True when `path` is the root of its own git work tree, not merely inside one. */
  isRepoRoot(path: string): Promise<boolean>
  /** Initializes `path` as its own repo (and an empty first commit) when it is not one yet. */
  ensureRepo(path: string): Promise<void>
  /** Current branch name, or a short SHA when HEAD is detached. */
  headBranch(path: string): Promise<string>
  create(repoPath: string, worktreePath: string, branch: string, baseRef: string): Promise<void>
  remove(repoPath: string, worktreePath: string, branch: string): Promise<void>
  /** Renames an orphan worktree out of the way (data kept) and prunes git's admin entry. */
  quarantine(repoPath: string, worktreePath: string): Promise<string>
  list(repoPath: string): Promise<WorktreeInfo[]>
  /** Stages and commits everything; false when the tree was already clean. */
  commitAll(worktreePath: string, message: string): Promise<boolean>
  hasRemote(worktreePath: string): Promise<boolean>
  remoteUrl(worktreePath: string): Promise<string | null>
  push(worktreePath: string, branch: string): Promise<void>
  /** PR URL from `gh`/`glab` when available; null to fall back to a compare URL. */
  pullRequest(
    worktreePath: string,
    remoteUrl: string,
    branch: string,
    baseRef: string,
  ): Promise<string | null>
  /** Local branches, current one first-class (issue #94). */
  branches(repoPath: string): Promise<{ current: string; branches: string[] }>
  /** True when the working tree has uncommitted changes. */
  isDirty(repoPath: string): Promise<boolean>
  /** Creates and checks out `name` from `baseRef` (default  HEAD). */
  createBranch(repoPath: string, name: string, baseRef?: string): Promise<void>
  /** Switches to an existing local branch (the caller rejects dirty trees). */
  checkout(repoPath: string, name: string): Promise<void>
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
 * 2. `createWorktreeManager` preflights the repository-local config and
 *    refuses keys that can execute a program or include more config.
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
 * filters on `add`, hooks/fsmonitor on `commit`/`checkout`/`status`/`push`,
 * external diff/textconv on `diff`. Read-only plumbing (`rev-parse`,
 * `symbolic-ref`, `remote`, `for-each-ref`, `worktree list`) cannot execute
 * repo content, and the env overrides already neutralize the vectors that
 * apply there.
 */
function needsConfigPreflight(args: string[]): boolean {
  const [command, subcommand] = args
  if (command === "worktree") return subcommand === "add" || subcommand === "checkout"
  return (
    command === "add" ||
    command === "commit" ||
    command === "checkout" ||
    command === "status" ||
    command === "push" ||
    command === "diff" ||
    command === "merge"
  )
}

/**
 * Refuses a repository whose local config can execute code. Uses `spawnResult`
 * directly (not the injectable runner) to avoid recursion, and only fails on a
 * match: status 1 (no match) and non-repo errors let the real command report.
 */
async function assertSafeLocalConfig(cwd: string, timeoutMs: number): Promise<void> {
  const unsafe = new Set<string>()
  // `--local` is `.git/config`; with `extensions.worktreeConfig` a repo can also
  // carry keys in `.git/config.worktree`, so both scopes are checked.
  for (const scope of ["--local", "--worktree"]) {
    const result = await spawnResult(
      "git",
      ["config", scope, "--name-only", "--get-regexp", UNSAFE_LOCAL_CONFIG.source],
      cwd,
      { timeoutMs, env: sanitizedGitEnv({}, cwd) },
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

export function createWorktreeManager(options: WorktreeManagerOptions = {}): WorktreeManager {
  const run = options.run ?? ((args, cwd, runOptions) => runGitCommand(args, cwd, runOptions))
  const runCommand = options.runCommand ?? defaultCommandRunner
  const gitTimeoutMs = options.gitTimeoutMs ?? GIT_TIMEOUT_MS
  const userName = options.userName ?? "MasterHand"
  const userEmail = options.userEmail ?? "masterhand@localhost"

  async function git(args: string[], cwd: string, runOptions: GitRunOptions = {}): Promise<GitResult> {
    if (needsConfigPreflight(args)) await assertSafeLocalConfig(cwd, gitTimeoutMs)
    return run(args, cwd, { timeoutMs: gitTimeoutMs, ...runOptions })
  }

  async function gitOrThrow(args: string[], cwd: string, context: string): Promise<GitResult> {
    const result = await git(args, cwd)
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

    async create(repoPath, worktreePath, branch, baseRef) {
      if (!isValidBranchName(branch)) throw new Error("invalid_branch_name")
      if (!isValidBranchName(baseRef)) throw new Error("invalid_base_ref")
      if (existsSync(worktreePath)) throw new Error("worktree_path_exists")
      await mkdir(dirname(worktreePath), { recursive: true })
      await gitOrThrow(
        ["worktree", "add", "-b", branch, worktreePath, baseRef],
        repoPath,
        "git_worktree_add_failed",
      )
    },

    async remove(repoPath, worktreePath, branch) {
      await git(["worktree", "remove", "--force", worktreePath], repoPath)
      await git(["branch", "-D", branch], repoPath)
      await git(["worktree", "prune"], repoPath)
    },

    async quarantine(repoPath, worktreePath) {
      const target = `${worktreePath}${ORPHAN_SUFFIX}${Date.now()}`
      await rename(worktreePath, target)
      await git(["worktree", "prune"], repoPath)
      return target
    },

    async list(repoPath) {
      const result = await git(["worktree", "list", "--porcelain"], repoPath)
      if (result.status !== 0) return []
      const entries: WorktreeInfo[] = []
      let current: Partial<WorktreeInfo> | null = null
      for (const line of result.stdout.split("\n")) {
        if (line.startsWith("worktree ")) {
          if (current?.path) entries.push(current as WorktreeInfo)
          current = { path: line.slice("worktree ".length).trim(), head: null, branch: null }
        } else if (line.startsWith("HEAD ") && current) {
          current.head = line.slice("HEAD ".length).trim()
        } else if (line.startsWith("branch ") && current) {
          const ref = line.slice("branch ".length).trim()
          current.branch = ref.replace(/^refs\/heads\//, "")
        }
      }
      if (current?.path) entries.push(current as WorktreeInfo)
      return entries
    },

    async commitAll(worktreePath, message) {
      await gitOrThrow(["add", "-A"], worktreePath, "git_add_failed")
      const diff = await git(["diff", "--cached", "--quiet"], worktreePath)
      if (diff.status === 0) return false
      await gitOrThrow([...authorArgs, "commit", "--no-verify", "-m", message], worktreePath, "git_commit_failed")
      return true
    },

    async hasRemote(worktreePath) {
      const result = await git(["remote"], worktreePath)
      return result.status === 0 && result.stdout.trim().length > 0
    },

    async remoteUrl(worktreePath) {
      const named = await git(["remote", "get-url", "origin"], worktreePath)
      if (named.status === 0 && named.stdout.trim()) return named.stdout.trim()
      const list = await git(["remote"], worktreePath)
      const first = list.stdout.trim().split("\n")[0]?.trim()
      if (!first) return null
      const fallback = await git(["remote", "get-url", first], worktreePath)
      return fallback.status === 0 ? fallback.stdout.trim() || null : null
    },

    async push(worktreePath, branch) {
      await gitOrThrow(["push", "--no-verify", "-u", "origin", branch], worktreePath, "git_push_failed")
    },

    async pullRequest(worktreePath, remoteUrl, branch, baseRef) {
      return createPullRequest({ cwd: worktreePath, remoteUrl, branch, baseRef, runCommand })
    },

    async branches(repoPath) {
      const current = await this.headBranch(repoPath)
      const result = await git(
        ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
        repoPath,
      )
      if (result.status !== 0) return { current, branches: current ? [current] : [] }
      const branches = result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
      if (current && !branches.includes(current)) branches.unshift(current)
      return { current, branches }
    },

    async isDirty(repoPath) {
      const result = await git(["status", "--porcelain"], repoPath)
      // A failed status must not read as "clean": the caller decides what to do
      // with the error, and treating it as dirty blocks a destructive checkout.
      if (result.status !== 0) throw new Error(`git_status_failed: ${result.stderr.trim() || result.stdout.trim()}`)
      return result.stdout.trim().length > 0
    },

    async createBranch(repoPath, name, baseRef) {
      if (!isValidBranchName(name)) throw new Error("invalid_branch_name")
      if (baseRef !== undefined && !isValidBranchName(baseRef)) throw new Error("invalid_base_ref")
      await gitOrThrow(
        ["checkout", "-b", name, ...(baseRef ? [baseRef] : [])],
        repoPath,
        "git_branch_create_failed",
      )
    },

    async checkout(repoPath, name) {
      await gitOrThrow(["checkout", name], repoPath, "git_checkout_failed")
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

/** Git-safe single path/branch segment derived from a workspace name. */
export function gitSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, MAX_BRANCH_SEGMENT)
  return slug || "workspace"
}

export function worktreeBranch(workspaceName: string, token: string): string {
  return `masterhand/${gitSlug(workspaceName)}-${token}`
}

/** Absolute worktree path, guaranteed to live under `root`. */
export function worktreeDir(root: string, workspaceName: string, token: string): string {
  const normalizedRoot = resolve(root)
  const path = resolve(normalizedRoot, workspaceName, token)
  if (!path.startsWith(normalizedRoot + sep)) throw new Error("worktree_path_escapes_root")
  return path
}

export type RemoteProvider = "github" | "gitlab"

export function remoteProvider(remoteUrl: string | null): RemoteProvider | null {
  if (!remoteUrl) return null
  const host = remoteUrl.replace(/^[a-z]+:\/\//i, "").replace(/^[^@/]+@/, "").split(/[/:]/)[0]?.toLowerCase()
  if (!host) return null
  if (host === "github.com" || host.endsWith(".github.com")) return "github"
  if (host === "gitlab.com" || host.endsWith(".gitlab.com")) return "gitlab"
  return null
}

/** Browsable https URL of the remote repository (used to build compare links). */
export function remoteWebUrl(remoteUrl: string): string | null {
  let value = remoteUrl.trim()
  const scp = value.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/)
  if (scp && !value.includes("://")) value = `https://${scp[1]}/${scp[2]}`
  const url = value.startsWith("http://") || value.startsWith("https://") ? value : `https://${value}`
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\.git$/, "").replace(/\/$/, "")}`
  } catch {
    return null
  }
}

/** Runs an external command; injectable so tests never spawn `gh`/`glab`. */
export type CommandRunner = (command: string, args: string[], cwd: string) => Promise<GitResult>

function defaultCommandRunner(command: string, args: string[], cwd: string): Promise<GitResult> {
  const env = sanitizedGitEnv(
    {
      GH_PROMPT_DISABLED: "1",
      GITLAB_PROMPT_DISABLED: "1",
    },
    cwd,
  )
  // Operator credentials are opt-in, one provider at a time: the CLI never
  // inherits the BFF's environment (and `git` never receives a provider token).
  const token =
    command === "gh"
      ? (process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN)
      : command === "glab"
        ? process.env.GITLAB_TOKEN
        : undefined
  if (token) env[command === "gh" ? "GH_TOKEN" : "GITLAB_TOKEN"] = token
  return spawnResult(command, args, cwd, {
    timeoutMs: GIT_TIMEOUT_MS,
    env,
  })
}

export interface PullRequestOptions {
  cwd: string
  remoteUrl: string
  branch: string
  baseRef: string
  runCommand?: CommandRunner
}

/**
 * Best-effort PR creation with the provider CLI. Returns the PR URL when the
 * CLI exists and is authenticated, `null` otherwise (the caller falls back to
 * a compare URL).
 */
export async function createPullRequest(options: PullRequestOptions): Promise<string | null> {
  const run = options.runCommand ?? defaultCommandRunner
  const provider = remoteProvider(options.remoteUrl)
  const firstUrl = (text: string): string | null =>
    text.match(/https?:\/\/\S+/)?.[0]?.replace(/[)\],.]+$/, "") ?? null

  if (provider === "github") {
    const result = await run(
      "gh",
      ["pr", "create", "--head", options.branch, "--base", options.baseRef, "--fill"],
      options.cwd,
    )
    if (result.status === 0) return firstUrl(result.stdout)
  } else if (provider === "gitlab") {
    const result = await run(
      "glab",
      [
        "mr",
        "create",
        "--source-branch",
        options.branch,
        "--target-branch",
        options.baseRef,
        "--fill",
        "--yes",
      ],
      options.cwd,
    )
    if (result.status === 0) return firstUrl(result.stdout)
  }
  return null
}

/** "Create pull/merge request" URL for GitHub or GitLab; null when unsupported. */
export function pullRequestUrl(
  remoteUrl: string | null,
  branch: string,
  baseRef: string,
): string | null {
  if (!remoteUrl) return null
  const provider = remoteProvider(remoteUrl)
  const web = remoteWebUrl(remoteUrl)
  if (!provider || !web) return null
  if (provider === "github") {
    return `${web}/compare/${encodeURIComponent(baseRef)}...${encodeURIComponent(branch)}?expand=1`
  }
  return `${web}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodeURIComponent(branch)}`
}

export type ReconcileSkipReason = "worktrees_root_missing" | "volume_unconfirmed"

export interface ReconcileResult {
  /** Reason no worktree data was touched, or null when reconciliation ran. */
  skipped: ReconcileSkipReason | null
  droppedRecords: string[]
  quarantinedWorktrees: string[]
}

/**
 * Startup cleanup, gated on a demonstrably healthy volume:
 * - Skips entirely when the worktree root is missing (late/failed mount) or no
 *   record/sentinel confirms the volume (DB restored from an older backup).
 * - Records whose worktree folder disappeared are dropped only then.
 * - Worktrees under `root` without a record are quarantined (renamed on disk,
 *   branch kept) instead of deleted, so uncommitted agent work stays recoverable.
 */
export async function reconcileWorktrees(
  store: Pick<Store, "listWorkspaces" | "listIsolatedSessions" | "removeIsolatedSession">,
  manager: WorktreeManager,
  root: string,
): Promise<ReconcileResult> {
  const normalizedRoot = resolve(root)
  const result: ReconcileResult = {
    skipped: null,
    droppedRecords: [],
    quarantinedWorktrees: [],
  }
  const records = store.listIsolatedSessions()

  const rootExists = existsSync(normalizedRoot)
  if (!rootExists && records.length === 0) return result // fresh install: nothing to clean or protect
  const sentinel = join(normalizedRoot, VOLUME_SENTINEL)
  const confirmed =
    rootExists &&
    (existsSync(sentinel) ||
      records.length === 0 ||
      records.some((record) => existsSync(record.path)))
  if (!confirmed) {
    result.skipped = rootExists ? "volume_unconfirmed" : "worktrees_root_missing"
    return result
  }
  if (!existsSync(sentinel)) {
    try {
      await writeFile(sentinel, new Date().toISOString(), "utf8")
    } catch {
      // A read-only volume still reconciles; the sentinel is best effort.
    }
  }

  for (const record of records) {
    if (existsSync(record.path)) continue
    store.removeIsolatedSession(record.sessionID)
    result.droppedRecords.push(record.sessionID)
  }

  const known = new Set(
    store.listIsolatedSessions().map((record) => resolve(record.path)),
  )
  for (const workspace of store.listWorkspaces()) {
    if (!(await manager.isRepoRoot(workspace.path))) continue
    for (const entry of await manager.list(workspace.path)) {
      const path = resolve(entry.path)
      if (path === resolve(workspace.path)) continue
      if (!path.startsWith(normalizedRoot + sep)) continue
      if (known.has(path)) continue
      if (basename(path).includes(ORPHAN_SUFFIX)) continue
      try {
        result.quarantinedWorktrees.push(await manager.quarantine(workspace.path, path))
      } catch {
        // best effort: a locked worktree should not block startup
      }
    }
  }

  return result
}
