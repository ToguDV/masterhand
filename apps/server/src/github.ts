import { randomUUID } from "node:crypto"
import { chmod, lstat, mkdir, rename, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Store } from "./store.js"

/**
 * GitHub account integration.
 *
 * The token lives in MasterHand's SQLite store and is never returned to a
 * client. To let agents use it, the BFF writes git/gh configuration into a
 * dedicated volume mounted at the agent user's `~/.config` (`agent-exec` sets
 * `HOME=/home/agent`). The volume is owned by the BFF user and group-readable
 * by the agent; the agent can read the credential but cannot rewrite the files
 * (which would let it make the BFF overwrite engine-owned files through a
 * symlink).
 */
const AGENT_CONFIG_PATH = "/home/agent/.config"
const GITHUB_API = "https://api.github.com/user"
const REQUEST_TIMEOUT_MS = 10_000
/** Fine-grained and classic tokens are URL-safe; reject anything that could inject config. */
const TOKEN_RE = /^(?:gh[pousr]_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]{20,})$/

export type GithubErrorCode = "invalid_token" | "github_rejected" | "github_unreachable"

export class GithubError extends Error {
  constructor(
    readonly code: GithubErrorCode,
    readonly status: 400 | 502,
    message: string,
  ) {
    super(message)
    this.name = "GithubError"
  }
}

export interface GithubStatus {
  connected: boolean
  login: string | null
  name: string | null
  avatarUrl: string | null
  scopes: string[]
  updatedAt: string | null
  /** True when the credential files were written to the shared agent volume. */
  injected: boolean
  /** Why the files could not be written (null when injection is healthy). */
  agentConfigError: string | null
}

export interface GithubIntegration {
  status(): GithubStatus
  /** Validates with GitHub, stores the token and re-materializes the agent files. */
  connect(token: string): Promise<GithubStatus>
  /** Removes the token and its files (idempotent). */
  disconnect(): Promise<GithubStatus>
  /** Re-writes the files from the stored token (boot / volume recreation). */
  materialize(): Promise<void>
}

export interface GithubIntegrationOptions {
  store: Store
  /** BFF-side mount of the shared agent config volume; null in native dev. */
  configDir: string | null
  version?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

interface GithubUser {
  id: number
  login: string
  name: string | null
  avatarUrl: string | null
  scopes: string[]
}

function gitQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n")}"`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Validates against GitHub and normalizes the account. The error messages
 * never include the token (they reach the client and the server log).
 */
async function fetchGithubUser(
  token: string,
  options: { fetchImpl: typeof fetch; version: string; timeoutMs: number },
): Promise<GithubUser> {
  let response: Response
  try {
    response = await options.fetchImpl(GITHUB_API, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": `MasterHand/${options.version}`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs),
    })
  } catch {
    throw new GithubError("github_unreachable", 502, "Could not reach GitHub. Check the server's Internet connection.")
  }
  if (response.status === 401) {
    throw new GithubError("invalid_token", 400, "GitHub rejected this token. Check that it is valid and not expired.")
  }
  if (!response.ok) {
    throw new GithubError(
      "github_rejected",
      502,
      `GitHub rejected the token request (HTTP ${response.status}). Try again later.`,
    )
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new GithubError("github_unreachable", 502, "GitHub returned an unreadable response. Try again.")
  }
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : null
  if (!record || typeof record.id !== "number" || typeof record.login !== "string" || !record.login) {
    throw new GithubError("github_unreachable", 502, "GitHub returned an unreadable account. Try again.")
  }
  const scopesHeader = response.headers.get("x-oauth-scopes") ?? ""
  return {
    id: record.id,
    login: record.login,
    name: typeof record.name === "string" && record.name.trim() ? record.name.trim() : null,
    avatarUrl: typeof record.avatar_url === "string" && record.avatar_url ? record.avatar_url : null,
    scopes: scopesHeader
      .split(",")
      .map((scope) => scope.trim())
      .filter((scope) => scope.length > 0),
  }
}

async function writeFileAtomic(path: string, content: string): Promise<void> {
  // `wx` refuses a pre-existing path (including a symlink planted in the
  // shared volume), and rename replaces the final path itself so a symlink at
  // the destination can never redirect the BFF's write.
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, content, { mode: 0o640, flag: "wx" })
    // writeFile applies the process umask; force the shared group-readable mode.
    await chmod(temporary, 0o640)
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

/** Creates/repairs an owned directory, refusing a symlink at the shared path. */
async function ensurePrivateDir(path: string): Promise<void> {
  try {
    const current = await lstat(path)
    if (current.isSymbolicLink() || !current.isDirectory()) {
      throw new Error(`${path} is not a real directory`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    await mkdir(path, { recursive: true, mode: 0o750 })
  }
  await chmod(path, 0o750)
}

export function createGithubIntegration(options: GithubIntegrationOptions): GithubIntegration {
  const { store, configDir } = options
  const fetchImpl = options.fetchImpl ?? fetch
  const version = options.version ?? "0.1.0"
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
  let injectionError: string | null = null

  function status(): GithubStatus {
    const auth = store.getGithubAuth()
    if (!auth) {
      return {
        connected: false,
        login: null,
        name: null,
        avatarUrl: null,
        scopes: [],
        updatedAt: null,
        injected: false,
        agentConfigError: injectionError,
      }
    }
    return {
      connected: true,
      login: auth.login,
      name: auth.name,
      avatarUrl: auth.avatarUrl,
      scopes: auth.scopes,
      updatedAt: new Date(auth.updatedAt).toISOString(),
      injected: injectionError === null,
      agentConfigError: injectionError,
    }
  }

  function gitConfig(login: string, name: string | null, id: number): string {
    return [
      "[user]",
      `\tname = ${gitQuote(name ?? login)}`,
      `\temail = ${gitQuote(`${id}+${login}@users.noreply.github.com`)}`,
      '[credential "https://github.com"]',
      `\thelper = store --file ${AGENT_CONFIG_PATH}/git/credentials`,
      "",
    ].join("\n")
  }

  function ghHosts(login: string, token: string): string {
    return [
      "github.com:",
      `    user: ${JSON.stringify(login)}`,
      `    oauth_token: ${JSON.stringify(token)}`,
      "    git_protocol: https",
      "",
    ].join("\n")
  }

  async function writeArtifacts(auth: {
    token: string
    login: string
    githubID: number
    name: string | null
  }): Promise<void> {
    if (!configDir) {
      throw new Error("AGENT_CONFIG_DIR is not configured; the agent container cannot receive GitHub credentials")
    }
    const gitDir = join(configDir, "git")
    const ghDir = join(configDir, "gh")
    await ensurePrivateDir(configDir)
    await ensurePrivateDir(gitDir)
    await ensurePrivateDir(ghDir)
    await writeFileAtomic(
      join(gitDir, "config"),
      gitConfig(auth.login, auth.name, auth.githubID),
    )
    await writeFileAtomic(
      join(gitDir, "credentials"),
      `https://x-access-token:${auth.token}@github.com\n`,
    )
    await writeFileAtomic(join(ghDir, "hosts.yml"), ghHosts(auth.login, auth.token))
  }

  async function removeArtifacts(): Promise<void> {
    if (!configDir) return
    for (const path of [
      join(configDir, "git", "config"),
      join(configDir, "git", "credentials"),
      join(configDir, "gh", "hosts.yml"),
    ]) {
      try {
        await unlink(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
    }
  }

  async function materializeOnce(): Promise<void> {
    const auth = store.getGithubAuth()
    if (!auth) {
      try {
        await removeArtifacts()
        injectionError = null
      } catch (error) {
        injectionError = messageOf(error)
        console.warn("[masterhand] could not remove stale GitHub credential files:", injectionError)
      }
      return
    }
    try {
      // Re-read after the (serialized) write begins: a disconnect queued behind
      // us removes the row first, so this branch sees null and removes the files.
      await writeArtifacts({
        token: auth.token,
        login: auth.login,
        githubID: auth.githubID,
        name: auth.name,
      })
      injectionError = null
    } catch (error) {
      injectionError = messageOf(error)
      console.warn("[masterhand] GitHub credential injection failed:", injectionError)
    }
  }

  /**
   * One serialized mutation queue. A boot materialization must never race a
   * disconnect (which would leave a valid token file behind), and two connects
   * must not fight over the same atomic temp/rename.
   */
  let queue: Promise<unknown> = Promise.resolve()
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task)
    queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  return {
    status,
    connect(token) {
      return enqueue(async () => {
        const normalized = token.trim()
        if (!TOKEN_RE.test(normalized)) {
          throw new GithubError("invalid_token", 400, "That does not look like a GitHub token.")
        }
        const user = await fetchGithubUser(normalized, { fetchImpl, version, timeoutMs })
        store.saveGithubAuth({
          token: normalized,
          login: user.login,
          githubID: user.id,
          name: user.name,
          avatarUrl: user.avatarUrl,
          scopes: user.scopes,
          updatedAt: Date.now(),
        })
        await materializeOnce()
        return status()
      })
    },
    disconnect() {
      return enqueue(async () => {
        store.deleteGithubAuth()
        try {
          await removeArtifacts()
          injectionError = null
        } catch (error) {
          injectionError = messageOf(error)
          console.warn("[masterhand] could not remove GitHub credential files:", injectionError)
        }
        return status()
      })
    },
    materialize() {
      return enqueue(materializeOnce)
    },
  }
}
