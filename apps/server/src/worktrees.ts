import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, realpathSync, renameSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve, sep } from "node:path"
import type { Store } from "./store.js"

const GIT_TIMEOUT_MS = 60_000
const MAX_BRANCH_SEGMENT = 40

/** Marker written by a successful reconciliation; its absence flags an unconfirmed volume. */
export const VOLUME_SENTINEL = ".masterhand-volume"
/** Suffix of a quarantined orphan worktree (kept on disk, never re-quarantined). */
export const ORPHAN_SUFFIX = ".orphaned-"

export interface GitResult {
  status: number
  stdout: string
  stderr: string
}

/** Runs `git <args>` inside `cwd`. Injectable so tests never spawn git. */
export type GitRunner = (args: string[], cwd: string) => GitResult

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
}

export interface WorktreeManager {
  /** True when `path` is the root of its own git work tree, not merely inside one. */
  isRepoRoot(path: string): boolean
  /** Initializes `path` as its own repo (and an empty first commit) when it is not one yet. */
  ensureRepo(path: string): void
  /** Current branch name, or a short SHA when HEAD is detached. */
  headBranch(path: string): string
  create(repoPath: string, worktreePath: string, branch: string, baseRef: string): void
  remove(repoPath: string, worktreePath: string, branch: string): void
  /** Renames an orphan worktree out of the way (data kept) and prunes git's admin entry. */
  quarantine(repoPath: string, worktreePath: string): string
  list(repoPath: string): WorktreeInfo[]
  /** Stages and commits everything; false when the tree was already clean. */
  commitAll(worktreePath: string, message: string): boolean
  hasRemote(worktreePath: string): boolean
  remoteUrl(worktreePath: string): string | null
  push(worktreePath: string, branch: string): void
  /** PR URL from `gh`/`glab` when available; null to fall back to a compare URL. */
  pullRequest(worktreePath: string, remoteUrl: string, branch: string, baseRef: string): string | null
}

function defaultRunner(args: string[], cwd: string): GitResult {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    env: {
      ...process.env,
      // Never block waiting for credentials on the server.
      GIT_TERMINAL_PROMPT: "0",
    },
  })
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  }
}

export function createWorktreeManager(options: WorktreeManagerOptions = {}): WorktreeManager {
  const run = options.run ?? defaultRunner
  const runCommand = options.runCommand ?? defaultCommandRunner
  const userName = options.userName ?? "MasterHand"
  const userEmail = options.userEmail ?? "masterhand@localhost"

  function git(args: string[], cwd: string): GitResult {
    return run(args, cwd)
  }

  function gitOrThrow(args: string[], cwd: string, context: string): GitResult {
    const result = git(args, cwd)
    if (result.status !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`
      throw new Error(`${context}: ${detail}`)
    }
    return result
  }

  const authorArgs = ["-c", `user.name=${userName}`, "-c", `user.email=${userEmail}`]

  return {
    isRepoRoot(path) {
      const result = git(["rev-parse", "--show-toplevel"], path)
      if (result.status !== 0) return false
      const top = result.stdout.trim()
      if (!top) return false
      try {
        return realpathSync(top) === realpathSync(path)
      } catch {
        return resolve(top) === resolve(path)
      }
    },

    ensureRepo(path) {
      if (!this.isRepoRoot(path)) {
        gitOrThrow(["init"], path, "git_init_failed")
      }
      const head = git(["rev-parse", "--verify", "HEAD"], path)
      if (head.status !== 0) {
        gitOrThrow([...authorArgs, "commit", "--allow-empty", "-m", "Initial commit"], path, "git_commit_failed")
      }
    },

    headBranch(path) {
      const branch = git(["symbolic-ref", "--short", "HEAD"], path)
      if (branch.status === 0 && branch.stdout.trim()) return branch.stdout.trim()
      const sha = git(["rev-parse", "--short", "HEAD"], path)
      return sha.stdout.trim() || "HEAD"
    },

    create(repoPath, worktreePath, branch, baseRef) {
      if (existsSync(worktreePath)) throw new Error("worktree_path_exists")
      mkdirSync(dirname(worktreePath), { recursive: true })
      gitOrThrow(["worktree", "add", "-b", branch, worktreePath, baseRef], repoPath, "git_worktree_add_failed")
    },

    remove(repoPath, worktreePath, branch) {
      git(["worktree", "remove", "--force", worktreePath], repoPath)
      git(["branch", "-D", branch], repoPath)
      git(["worktree", "prune"], repoPath)
    },

    quarantine(repoPath, worktreePath) {
      const target = `${worktreePath}${ORPHAN_SUFFIX}${Date.now()}`
      renameSync(worktreePath, target)
      git(["worktree", "prune"], repoPath)
      return target
    },

    list(repoPath) {
      const result = git(["worktree", "list", "--porcelain"], repoPath)
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

    commitAll(worktreePath, message) {
      gitOrThrow(["add", "-A"], worktreePath, "git_add_failed")
      const diff = git(["diff", "--cached", "--quiet"], worktreePath)
      if (diff.status === 0) return false
      gitOrThrow([...authorArgs, "commit", "-m", message], worktreePath, "git_commit_failed")
      return true
    },

    hasRemote(worktreePath) {
      const result = git(["remote"], worktreePath)
      return result.status === 0 && result.stdout.trim().length > 0
    },

    remoteUrl(worktreePath) {
      const named = git(["remote", "get-url", "origin"], worktreePath)
      if (named.status === 0 && named.stdout.trim()) return named.stdout.trim()
      const list = git(["remote"], worktreePath)
      const first = list.stdout.trim().split("\n")[0]?.trim()
      if (!first) return null
      const fallback = git(["remote", "get-url", first], worktreePath)
      return fallback.status === 0 ? fallback.stdout.trim() || null : null
    },

    push(worktreePath, branch) {
      gitOrThrow(["push", "-u", "origin", branch], worktreePath, "git_push_failed")
    },

    pullRequest(worktreePath, remoteUrl, branch, baseRef) {
      return createPullRequest({ cwd: worktreePath, remoteUrl, branch, baseRef, runCommand })
    },
  }
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
export type CommandRunner = (command: string, args: string[], cwd: string) => GitResult

function defaultCommandRunner(command: string, args: string[], cwd: string): GitResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GH_PROMPT_DISABLED: "1",
      GITLAB_PROMPT_DISABLED: "1",
    },
  })
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  }
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
export function createPullRequest(options: PullRequestOptions): string | null {
  const run = options.runCommand ?? defaultCommandRunner
  const provider = remoteProvider(options.remoteUrl)
  const firstUrl = (text: string): string | null =>
    text.match(/https?:\/\/\S+/)?.[0]?.replace(/[)\],.]+$/, "") ?? null

  if (provider === "github") {
    const result = run(
      "gh",
      ["pr", "create", "--head", options.branch, "--base", options.baseRef, "--fill"],
      options.cwd,
    )
    if (result.status === 0) return firstUrl(result.stdout)
  } else if (provider === "gitlab") {
    const result = run(
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
export function reconcileWorktrees(
  store: Pick<Store, "listWorkspaces" | "listIsolatedSessions" | "removeIsolatedSession">,
  manager: WorktreeManager,
  root: string,
): ReconcileResult {
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
      writeFileSync(sentinel, new Date().toISOString(), "utf8")
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
    if (!manager.isRepoRoot(workspace.path)) continue
    for (const entry of manager.list(workspace.path)) {
      const path = resolve(entry.path)
      if (path === resolve(workspace.path)) continue
      if (!path.startsWith(normalizedRoot + sep)) continue
      if (known.has(path)) continue
      if (basename(path).includes(ORPHAN_SUFFIX)) continue
      try {
        result.quarantinedWorktrees.push(manager.quarantine(workspace.path, path))
      } catch {
        // best effort: a locked worktree should not block startup
      }
    }
  }

  return result
}


