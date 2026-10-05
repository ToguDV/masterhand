import { readFileSync } from "node:fs"
import { basename, join, resolve, sep } from "node:path"

/**
 * Managed dev-server lifecycle. MasterHand starts the workspace's run command
 * through opencode's PTY API and stops it by deleting that exact PTY, so the
 * agent never has to start or kill a server (the incident this feature exists
 * to prevent). The command is argv — no shell — and `{port}` is replaced with
 * the session's reserved preview port, which keeps it validatable and reusable.
 */

export interface RunConfig {
  command: string
  args: string[]
  /** Optional working directory, relative to the workspace (or absolute inside it). */
  cwd: string | null
}

export type RunPhase = "stopped" | "starting" | "running" | "error"

export interface RunStatus {
  status: RunPhase
  command: string | null
  args: string[]
  /** Reserved preview port (the `{port}` value and `PORT` env). */
  port: number | null
  pid: number | null
  error: string | null
}

export const RUN_FILE = ".masterhand/run.json"
export const RUN_TITLE_PREFIX = "masterhand:"

const MAX_COMMAND_LENGTH = 128
const MAX_ARGS = 32
const MAX_ARG_LENGTH = 512
const MAX_CWD_LENGTH = 256

/**
 * Commands that manage or kill other processes, or that would turn the argv
 * execution back into a shell. A project script (e.g. `./scripts/dev.sh`) is
 * fine; `bash -c ...` is not.
 */
const DENIED_COMMANDS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "csh",
  "tcsh",
  "env",
  "nohup",
  "xargs",
  "sudo",
  "su",
  "setpriv",
  "pkill",
  "kill",
  "killall",
  "fuser",
  "systemctl",
  "service",
  "docker",
  "podman",
  "nerdctl",
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
  "init",
  "eval",
  "exec",
])

export class RunError extends Error {
  constructor(
    public readonly code: string,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code)
    this.name = "RunError"
  }
}

/** True when `path` is `root` or strictly inside it. */
export function isInsideOrEqual(root: string, path: string): boolean {
  const normalizedRoot = resolve(root)
  const target = resolve(path)
  return target === normalizedRoot || target.startsWith(normalizedRoot + sep)
}

/**
 * Validates a run configuration against the workspace it will run in. The
 * command must be a single executable (no shell), arguments are bounded and
 * `cwd` cannot escape the workspace.
 */
export function validateRunConfig(
  value: unknown,
  workspacePath: string,
): { ok: true; config: RunConfig } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "invalid_config" }
  const record = value as Record<string, unknown>

  const command = typeof record.command === "string" ? record.command.trim() : ""
  if (!command || command.length > MAX_COMMAND_LENGTH || /[\u0000-\u001f]/.test(command)) {
    return { ok: false, error: "invalid_command" }
  }
  if (DENIED_COMMANDS.has(basename(command).toLowerCase())) {
    return { ok: false, error: "command_not_allowed" }
  }

  const rawArgs = record.args === undefined ? [] : record.args
  if (!Array.isArray(rawArgs) || rawArgs.length > MAX_ARGS) return { ok: false, error: "invalid_args" }
  const args: string[] = []
  for (const item of rawArgs) {
    if (typeof item !== "string" || item.length > MAX_ARG_LENGTH || /[\u0000-\u001f]/.test(item)) {
      return { ok: false, error: "invalid_args" }
    }
    args.push(item)
  }

  let cwd: string | null = null
  if (record.cwd !== undefined && record.cwd !== null && record.cwd !== "") {
    if (typeof record.cwd !== "string" || record.cwd.length > MAX_CWD_LENGTH || /[\u0000-\u001f]/.test(record.cwd)) {
      return { ok: false, error: "invalid_cwd" }
    }
    if (!isInsideOrEqual(workspacePath, resolve(workspacePath, record.cwd))) {
      return { ok: false, error: "cwd_outside_workspace" }
    }
    cwd = record.cwd
  }

  return { ok: true, config: { command, args, cwd } }
}

/** Replaces `{port}` in every argument with the session's reserved port. */
export function renderRunArgs(args: string[], port: number): string[] {
  return args.map((arg) => arg.replaceAll("{port}", String(port)))
}

/**
 * Reads the agent-proposed run file (`<workspace>/.masterhand/run.json`).
 * Returns `null` when it does not exist, `{ error }` when it is invalid.
 */
export function readRunFile(workspacePath: string): { config: RunConfig } | { error: string } | null {
  let raw: string
  try {
    raw = readFileSync(join(workspacePath, ...RUN_FILE.split("/")), "utf8")
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { error: "invalid_json" }
  }
  const result = validateRunConfig(parsed, workspacePath)
  return result.ok ? { config: result.config } : { error: result.error }
}

/**
 * Session instruction telling the agent to declare the run command instead of
 * starting servers itself.
 */
export function runSystemPrompt(): string {
  return [
    "MasterHand manages this project's dev server lifecycle: never start or stop a long-running server yourself, and never kill processes to manage one.",
    `Declare how to start it in \`${RUN_FILE}\` at the project root, as JSON, for example: {"command":"npm","args":["run","dev","--","--host","0.0.0.0","--port","{port}"]}.`,
    "It runs as argv (no shell) and `{port}` is replaced with the port MasterHand reserved; the user reviews or edits it in the UI.",
    "MasterHand starts and stops that exact process. If the project has no web server, ignore this instruction.",
  ].join(" ")
}

export interface RunPty {
  id: string
  pid: number
  status: string
  title: string
}

/** Subset of opencode's PTY API the run manager needs (injectable for tests). */
export interface RunOpencode {
  createPty(input: {
    directory: string
    command: string
    args: string[]
    cwd: string
    title: string
    env: Record<string, string>
  }): Promise<RunPty>
  listPtys(directory: string): Promise<RunPty[]>
  removePty(directory: string, ptyID: string): Promise<void>
}

export interface RunManager {
  status(sessionID: string, directory: string, port: number): Promise<RunStatus>
  start(sessionID: string, directory: string, config: RunConfig, port: number): Promise<RunStatus>
  stop(sessionID: string, directory: string): Promise<void>
  /** Best-effort stop when a session disappears (no directory available). */
  forget(sessionID: string): void
}

interface RunningRun {
  ptyID: string
  pid: number
  command: string
  args: string[]
  directory: string
}

export interface RunManagerDeps {
  opencode: RunOpencode
}

export function createRunManager(deps: RunManagerDeps): RunManager {
  const running = new Map<string, RunningRun>()
  // In-flight starts, keyed per session: `start` is a non-idempotent
  // check→create, so two devices pressing Start in the same tick must share one
  // PTY instead of racing into two dev servers on the same port.
  const starting = new Map<string, Promise<RunStatus>>()

  async function findAdoptable(sessionID: string, directory: string): Promise<RunPty | null> {
    const ptys = await deps.opencode.listPtys(directory)
    return ptys.find((pty) => pty.title === `${RUN_TITLE_PREFIX}${sessionID}` && pty.status === "running") ?? null
  }

  function stopped(port: number): RunStatus {
    return { status: "stopped", command: null, args: [], port, pid: null, error: null }
  }

  async function status(sessionID: string, directory: string, port: number): Promise<RunStatus> {
    const active = running.get(sessionID)
    if (active) {
      const ptys = await deps.opencode.listPtys(directory).catch(() => [] as RunPty[])
      const live = ptys.find((pty) => pty.id === active.ptyID && pty.status === "running")
      if (!live) {
        running.delete(sessionID)
        return stopped(port)
      }
      return { status: "running", command: active.command, args: active.args, port, pid: live.pid, error: null }
    }

    // The BFF may have restarted while the dev server kept running: adopt the
    // PTY by its title instead of spawning a second server.
    const adoptable = await findAdoptable(sessionID, directory).catch(() => null)
    if (!adoptable) return stopped(port)
    running.set(sessionID, {
      ptyID: adoptable.id,
      pid: adoptable.pid,
      command: "",
      args: [],
      directory,
    })
    return { status: "running", command: null, args: [], port, pid: adoptable.pid, error: null }
  }

  async function startOnce(
    sessionID: string,
    directory: string,
    config: RunConfig,
    port: number,
  ): Promise<RunStatus> {
    const current = await status(sessionID, directory, port)
    if (current.status === "running") return current

    const args = renderRunArgs(config.args, port)
    const cwd = config.cwd ? resolve(directory, config.cwd) : directory
    let pty: RunPty
    try {
      pty = await deps.opencode.createPty({
        directory,
        command: config.command,
        args,
        cwd,
        title: `${RUN_TITLE_PREFIX}${sessionID}`,
        env: { PORT: String(port) },
      })
    } catch (error) {
      throw new RunError("run_spawn_failed", error instanceof Error ? error.message : "spawn failed")
    }

    running.set(sessionID, { ptyID: pty.id, pid: pty.pid, command: config.command, args, directory })
    return { status: "running", command: config.command, args, port, pid: pty.pid, error: null }
  }

  function start(sessionID: string, directory: string, config: RunConfig, port: number): Promise<RunStatus> {
    const pending = starting.get(sessionID)
    if (pending) return pending
    const task = startOnce(sessionID, directory, config, port).finally(() => {
      if (starting.get(sessionID) === task) starting.delete(sessionID)
    })
    starting.set(sessionID, task)
    return task
  }

  /** Waits for an in-flight create so stop/forget act on the PTY it produced. */
  async function settled(sessionID: string): Promise<void> {
    const pending = starting.get(sessionID)
    if (pending) await pending.catch(() => {})
  }

  async function stop(sessionID: string, directory: string): Promise<void> {
    await settled(sessionID)
    let active = running.get(sessionID)
    if (!active) {
      const adoptable = await findAdoptable(sessionID, directory).catch(() => null)
      if (adoptable) {
        active = { ptyID: adoptable.id, pid: adoptable.pid, command: "", args: [], directory }
      }
    }
    if (!active) return
    await deps.opencode.removePty(directory, active.ptyID).catch(() => {})
    running.delete(sessionID)
  }

  function forget(sessionID: string): void {
    const pending = starting.get(sessionID)
    if (pending) {
      void pending
        .catch(() => {})
        .then(() => {
          const active = running.get(sessionID)
          if (!active) return
          void deps.opencode.removePty(active.directory, active.ptyID).catch(() => {})
          running.delete(sessionID)
        })
      return
    }
    const active = running.get(sessionID)
    if (!active) return
    void deps.opencode.removePty(active.directory, active.ptyID).catch(() => {})
    running.delete(sessionID)
  }

  return { status, start, stop, forget }
}
