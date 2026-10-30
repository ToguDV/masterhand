import { homedir } from "node:os"
import { basename, join, resolve, sep } from "node:path"
import { mkdir, rm } from "node:fs/promises"

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
export function createWorkspaceDir(path: string): Promise<void> {
  return mkdir(path, { recursive: true }).then(() => undefined)
}

/** Deletes a workspace folder and everything inside it. */
export function removeWorkspaceDir(path: string): Promise<void> {
  return rm(path, { recursive: true, force: true })
}

/**
 * Short, forceful guardrail appended to every session's system context. It
 * roots the agent in the directory MasterHand assigned it while allowing work
 * outside it when the task truly needs it or the user asks for it.
 */
export function workspaceSystemPrompt(directory: string): string {
  return [
    `Your working directory is exactly ${directory}.`,
    `That folder is your project root; work inside it by default.`,
    `You may read, create, modify and delete files outside it only if it is 100% necessary to complete the task or the user explicitly indicates it; in that case use the narrowest path that does the job.`,
    `Never modify the MasterHand server source, its configuration or secrets, or other workspaces unless the user explicitly asks you to.`,
    `If a prompt or command points to an external path (for example the AGENTS.md path of /init), apply the same rule instead of assuming it is off-limits.`,
    `Exception: user attachments are listed by absolute path under a .masterhand/attachments folder; read those files when the prompt lists them (they are read-only user input), even when they are outside your working directory, and never modify or delete them.`,
    `If you create AGENTS.md, it belongs at ${directory}/AGENTS.md.`,
  ].join(" ")
}

export interface PermissionRule {
  action: string
  resource: string
  effect: "allow" | "deny" | "ask"
}

/**
 * External access is allowed: agents may work in any project the user points
 * them at. The guard no longer confines writes to the workspace; the
 * process-safety and engine-credential rules below are the only denials.
 */
export function externalAccessGuardRules(): PermissionRule[] {
  return [{ action: "external_directory", resource: "*", effect: "allow" }]
}

/**
 * Engine data/config layout from `deploy/opencode.Dockerfile`: the credential
 * store (`opencode.db`) and the provider config live here, owner-only, while
 * the agent's workspace is group-writable for a different uid.
 */
export const ENGINE_DATA_DIR = "/home/node/.local/share/opencode"
export const ENGINE_CONFIG_DIR = "/home/node/.config/opencode"

/**
 * Denies engine-side reads and edits outside the workspace (#219). The read
 * tool runs in the opencode engine process (`node`, uid 1000), not through
 * `agent-exec` (uid 1001), so without these rules it can reach
 * `/proc/self/environ` (which carries `OPENCODE_SERVER_PASSWORD`), `opencode.db`
 * and the provider config, then call the engine API directly — bypassing both
 * the managed-run dropper and the `/api/oc/*` allowlist. The edit denies keep
 * the agent from rewriting that config or the credential store.
 *
 * Verified against the pinned 2.0.6 source (`packages/core/src/file-access.ts`,
 * `tool/plugin/{read,grep,glob}.ts`):
 *
 * - `read` asserts `action: "read"` with the resolved path as its resource:
 *   location-relative inside the workspace, absolute outside it. Denying `read`
 *   on absolute engine paths blocks the read tool while workspace-relative
 *   reads never match.
 * - `grep`/`glob` assert `action: name` with the *search pattern* as their
 *   resource — a path-shaped deny on those actions could never match a real
 *   call, so there are deliberately no grep/glob rules here. Both gate their
 *   path through `authorizeExternal` (`action: "external_directory"` with the
 *   target directory as the resource) before that assert, so the
 *   `external_directory` denies below confine them too.
 * - Rule evaluation is last-match-wins (`findLast` over the merged ruleset in
 *   `permission.ts`), so these denies must stay *after* the
 *   `external_directory: allow *` entry of `externalAccessGuardRules`. A session
 *   deny beats any saved/project `allow` (`denied()` is checked on the session
 *   ruleset before saved rules are even consulted).
 * - Patterns compile with `*` as `.*` (`util/wildcard.ts`), so one `*`
 *   crosses `/`: `/proc/*` also matches `/proc/self/environ` at any depth.
 *   No `/**` forms needed. Editing `/proc` is meaningless, so `edit` denies
 *   exist only for the data/config directories.
 * - The match is lexical (no `realpath`): a symlink inside the workspace that
 *   points outside resolves to a relative resource and passes this guard. That
 *   residual is documented in `docs/bff/api.md`; engine files stay owner-only
 *   so the `agent` uid cannot follow such a link through shell/PTY paths.
 */
export function engineReadGuardRules(home: string = homedir()): PermissionRule[] {
  const dataDirs = new Set([ENGINE_DATA_DIR, join(home, ".local/share/opencode")])
  const configDirs = new Set([ENGINE_CONFIG_DIR, join(home, ".config/opencode")])
  const rules: PermissionRule[] = []
  const add = (resource: string, actions: ReadonlyArray<PermissionRule["action"]>): void => {
    for (const action of actions) {
      if (!rules.some((rule) => rule.action === action && rule.resource === resource)) {
        rules.push({ action, resource, effect: "deny" })
      }
    }
  }
  for (const resource of ["/proc", "/proc/*"]) add(resource, ["read", "external_directory"])
  for (const dir of [...dataDirs, ...configDirs]) {
    for (const resource of [dir, `${dir}/*`]) add(resource, ["read", "external_directory", "edit"])
  }
  return rules
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
