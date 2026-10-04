// Shared process registry between scripts/dev.mjs (writer) and scripts/stop.mjs
// (reader). The dev orchestrator records every process it starts so the stop
// script targets exactly those PIDs instead of sweeping by process name or port
// — a sweep can kill unrelated processes, including MasterHand's own BFF and
// opencode (the incident `dev:stop` was involved in) or another project's dev
// server. The registry lives in the OS temp directory, keyed by the repo path,
// so it never pollutes the working tree.
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

/** Entries older than this are ignored (a stale pid may have been reused). */
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/** Stable registry path for a repository root. */
export function registryPath(rootDir) {
  const hash = createHash("sha1").update(rootDir).digest("hex").slice(0, 12)
  return join(tmpdir(), "masterhand-dev", `${hash}.json`)
}

/** Reads the registry; a missing or corrupt file reads as empty. */
export function readRegistry(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    if (!parsed || !Array.isArray(parsed.entries)) return { entries: [] }
    return { entries: parsed.entries }
  } catch {
    return { entries: [] }
  }
}

/** True when the pid exists (or exists but belongs to another user). */
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === "EPERM"
  }
}

export function writeRegistry(file, entries) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ entries }, null, 2)}\n`)
}

/**
 * Adds or refreshes an entry (keyed by pid) and drops dead or stale ones, so
 * concurrent `dev:*` runs keep each other's live entries.
 */
export function registerProcess(file, entry) {
  const now = Date.now()
  const kept = readRegistry(file).entries.filter(
    (item) => item.pid !== entry.pid && isAlive(item.pid) && now - item.at < MAX_AGE_MS,
  )
  writeRegistry(file, [...kept, { ...entry, at: entry.at ?? now }])
}

/** Removes one pid; deletes the file when nothing is left. */
export function unregisterProcess(file, pid) {
  const kept = readRegistry(file).entries.filter((item) => item.pid !== pid)
  if (kept.length === 0) {
    rmSync(file, { force: true })
    return
  }
  writeRegistry(file, kept)
}

/**
 * Best-effort pid-reuse guard: on Linux, check that the live process command
 * still looks like the recorded one before signalling it. Elsewhere (or when
 * the recorded command is empty) it assumes the entry is valid.
 */
export function commandMatches(pid, command) {
  if (process.platform !== "linux") return true
  const needle = String(command ?? "").trim().split(/\s+/)[0]
  if (!needle) return true
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ")
    return cmdline.includes(needle)
  } catch {
    return false
  }
}
