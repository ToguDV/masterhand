import { basename, resolve, sep } from "node:path"
import { mkdirSync, rmSync } from "node:fs"

const MAX_SLUG_LENGTH = 64

export type WorkspaceSlugResult =
  | { ok: true; slug: string }
  | { ok: false; error: "invalid_name" }

/**
 * Turns a user-provided workspace name into a safe single path segment. Anything
 * that could escape the workspace root (separators, traversal, hidden names) or
 * break the filesystem is rejected.
 */
export function normalizeWorkspaceSlug(input: unknown): WorkspaceSlugResult {
  if (typeof input !== "string") return { ok: false, error: "invalid_name" }
  const slug = input.trim()
  if (!slug || slug.length > MAX_SLUG_LENGTH) return { ok: false, error: "invalid_name" }
  if (slug === "." || slug === "..") return { ok: false, error: "invalid_name" }
  if (slug.startsWith(".")) return { ok: false, error: "invalid_name" }
  if (slug.includes("/") || slug.includes("\\")) return { ok: false, error: "invalid_name" }
  if (/[\u0000-\u001f]/.test(slug)) return { ok: false, error: "invalid_name" }
  return { ok: true, slug }
}

/** Absolute path of a workspace, guaranteed to live directly under `root`. */
export function workspacePath(root: string, slug: string): string {
  const normalizedRoot = resolve(root)
  const path = resolve(normalizedRoot, slug)
  if (!path.startsWith(normalizedRoot + sep)) {
    throw new Error("workspace_slug_escapes_root")
  }
  return path
}

/** True when `path` is strictly inside `root` (used to guard folder deletion). */
export function isInsideRoot(root: string, path: string): boolean {
  const normalizedRoot = resolve(root)
  const target = resolve(path)
  return target !== normalizedRoot && target.startsWith(normalizedRoot + sep)
}

export function workspaceName(path: string): string {
  return basename(path) || path
}

/** Creates the workspace folder (and the root itself) if missing. */
export function createWorkspaceDir(path: string): void {
  mkdirSync(path, { recursive: true })
}

/** Deletes a workspace folder and everything inside it. */
export function removeWorkspaceDir(path: string): void {
  rmSync(path, { recursive: true, force: true })
}

/**
 * Short, forceful guardrail appended to every session's system context. It pins
 * the agent to the directory MasterHand assigned it (its own project root) so it
 * never confuses itself with the MasterHand server repo or a sibling workspace.
 */
export function workspaceSystemPrompt(directory: string): string {
  return [
    `Your working directory is exactly ${directory}.`,
    `That folder is your project root and the only area you own: read, create, modify and delete files only inside it.`,
    `Never touch anything outside it — in particular the MasterHand server source, its .git, its configuration or secrets, or other workspaces — not even through shell commands.`,
    `If a prompt or command points to a path outside your working directory (for example the AGENTS.md path of /init), ignore that path and use your working directory instead.`,
    `If you create AGENTS.md, it belongs at ${directory}/AGENTS.md.`,
  ].join(" ")
}

export interface PermissionRule {
  action: string
  resource: string
  effect: "allow" | "deny" | "ask"
}

/**
 * opencode tags files outside the session directory with an **absolute** resource
 * (or a `../`-prefixed one when they still fall under a wrongly-resolved project
 * root) and workspace files with a plain relative one. Allowing external access
 * and then denying `edit` (the action the write, edit and patch tools all assert)
 * on those patterns blocks writes outside the workspace while reads stay allowed.
 * The second and third patterns also cover Windows drive paths and `../` paths.
 */
export function externalWriteGuardRules(): PermissionRule[] {
  return [
    { action: "external_directory", resource: "*", effect: "allow" },
    { action: "edit", resource: "/*", effect: "deny" },
    { action: "edit", resource: "?:/*", effect: "deny" },
    { action: "edit", resource: "../*", effect: "deny" },
  ]
}

/**
 * Shell commands that can take down the MasterHand stack. In production the
 * agent shares a container and user with `opencode serve`, so a broad kill
 * (`pkill -f vite`, `kill $(lsof -ti:5173)`, `npm run dev:stop`, ...) kills the
 * engine itself; in native development it can also kill the BFF and the web dev
 * server. The rules use `deny` (not `ask`) because MasterHand's auto-accept
 * answers `ask` requests automatically, and only an explicit deny is enforced
 * regardless. Killing the exact PID the agent started (`kill <pid>`) stays
 * allowed; the run/preview controls are the preferred way to stop a server.
 *
 * Verified against opencode v2.0.21: the permission action for the shell tool is
 * `shell` (a `bash` action does not match) and `kill $*` blocks `kill $(...)`
 * while `kill 999999` passes. A denied command surfaces as a tool part with
 * `error.type = "permission.rejected"`.
 */
export function processGuardRules(): PermissionRule[] {
  const denied = [
    "pkill*",
    "killall*",
    "fuser*",
    "xargs kill*",
    "kill $*",
    "kill `*",
    "kill -9 $*",
    "kill -9 `*",
    "kill -TERM $*",
    "kill -KILL $*",
    "kill -1*",
    "npm run dev:stop*",
    "docker compose down*",
    "docker kill*",
    "docker stop*",
    "systemctl stop*",
    "systemctl restart*",
    "service * stop*",
    "shutdown*",
    "reboot*",
    "init 0*",
    "sudo pkill*",
    "sudo killall*",
  ]
  return denied.flatMap((resource) => [
    { action: "shell", resource, effect: "deny" as const },
    // `bash` was the action name before v2 renamed the tool to `shell`; keeping
    // both covers servers that still key on the old name.
    { action: "bash", resource, effect: "deny" as const },
  ])
}

/**
 * Forceful guardrail appended to every session's system context: process safety.
 * Instructions alone are not enforcement (the permission guard does that), but
 * they steer less capable models away from the broad-kill reflex and toward the
 * supported lifecycle.
 */
export function processSystemPrompt(): string {
  return [
    "Process safety: never stop processes by name, pattern or port.",
    "Commands such as `pkill`, `killall`, `fuser`, `kill $(...)` or `npm run dev:stop` are blocked because they can kill the MasterHand server or the agent engine itself.",
    "If you start a background server, capture its exact PID when you start it (`echo $!`) and stop it later with `kill <that pid>` only.",
    "Prefer MasterHand's Run and Preview controls to start and stop the project's dev server instead of managing processes yourself.",
  ].join(" ")
}
