#!/usr/bin/env node
// Stops the dev stack started by `scripts/dev.mjs`.
//
// By default it only kills the PIDs the orchestrator registered (in a temp file
// keyed by this repo), so it can never take down unrelated processes — including
// MasterHand's own BFF/opencode or another project's dev server. The legacy
// sweep by process name/port is still available behind `--force` for the cases
// the registry cannot cover (a process started outside the orchestrator).
//
//   npm run dev:stop           # registry only (safe)
//   npm run dev:stop -- --force # registry + name/port sweep
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import process from "node:process"
import {
  commandMatches,
  MAX_AGE_MS,
  readRegistry,
  registryPath,
  unregisterProcess,
} from "./process-registry.mjs"

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..")
const isWindows = process.platform === "win32"
const isMac = process.platform === "darwin"
const force = process.argv.includes("--force")
const registryFile = registryPath(rootDir)

// Same env file the dev orchestrator loads, so the ports match (used by --force).
const envFile = join(rootDir, "apps/server/.env.local")
if (existsSync(envFile)) process.loadEnvFile(envFile)

const bffPort = Number(process.env.PORT ?? 8787)
const opencodePort = Number(new URL(process.env.OPENCODE_URL ?? "http://127.0.0.1:4096").port || 4096)

const targets = new Map() // pid -> label

// Never kill this process or anything that launched it (the shell running
// `npm run dev:stop`, whose command line may mention the same patterns).
const excluded = new Set([process.pid])
if (!isWindows) {
  let current = process.pid
  while (current > 1) {
    try {
      current = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(current)], { encoding: "utf8" }).trim())
      excluded.add(current)
    } catch {
      break
    }
  }
}

function add(pid, label) {
  const value = Number(pid)
  if (value && !excluded.has(value)) targets.set(value, label)
}

// 1. Registry entries (the default path): only processes `dev.mjs` started.
for (const entry of readRegistry(registryFile).entries) {
  if (Date.now() - entry.at > MAX_AGE_MS) continue
  if (!commandMatches(entry.pid, entry.command)) {
    console.log(`[stop] skipping stale registry entry ${entry.label ?? "process"} (pid ${entry.pid})`)
    unregisterProcess(registryFile, entry.pid)
    continue
  }
  add(entry.pid, entry.label ?? "dev process")
}

// 2. Optional sweep by name/port (--force only).
function fromCommand(pattern, label) {
  if (isWindows) return
  try {
    const out = execFileSync("pgrep", ["-f", pattern], { encoding: "utf8" })
    for (const pid of out.split("\n")) add(pid.trim(), label)
  } catch {
    // pgrep exits non-zero when nothing matches
  }
}

function fromPort(port, label) {
  try {
    if (isWindows) {
      const out = execFileSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8" })
      for (const line of out.split("\n")) {
        if (line.includes(`:${port} `) && line.includes("LISTENING")) add(line.trim().split(/\s+/).pop(), label)
      }
      return
    }
    const out = isMac
      ? execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" })
      : execFileSync("ss", ["-ltnp", `sport = :${port}`], { encoding: "utf8" })
    if (isMac) {
      for (const pid of out.split("\n")) add(pid.trim(), label)
      return
    }
    for (const match of out.matchAll(/pid=(\d+)/g)) add(match[1], label)
  } catch {
    // ss/lsof/netstat missing or nothing listening
  }
}

if (force) {
  console.log("[stop] --force: also sweeping by process name and port")
  fromCommand(join(rootDir, "scripts/dev.mjs"), "dev orchestrator")
  fromCommand("scripts/dev.mjs", "dev orchestrator")
  for (const bin of ["vite", "tsx", "expo", "electron"]) fromCommand(join(rootDir, "node_modules/.bin", bin), bin)
  fromPort(opencodePort, "opencode")
  fromPort(bffPort, "BFF")
}

if (targets.size === 0) {
  console.log(
    force
      ? "[stop] nothing to stop"
      : "[stop] nothing to stop (only processes started by scripts/dev.mjs are targeted; use --force to sweep by name/port)",
  )
  process.exit(0)
}

function kill(pid, signal) {
  if (isWindows) {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" })
      return true
    } catch {
      return false
    }
  }
  try {
    process.kill(-pid, signal) // the whole process group, when pid leads one
    return true
  } catch {
    // pid is not a process-group leader
  }
  try {
    process.kill(pid, signal)
    return true
  } catch {
    return false
  }
}

for (const [pid, label] of targets) {
  if (kill(pid, "SIGTERM")) console.log(`[stop] ${label}: SIGTERM (pid ${pid})`)
}

setTimeout(() => {
  let forced = 0
  for (const [pid, label] of targets) {
    if (kill(pid, "SIGKILL")) {
      console.log(`[stop] ${label}: SIGKILL (pid ${pid})`)
      forced++
    }
    unregisterProcess(registryFile, pid)
  }
  console.log(`[stop] done (${targets.size} targeted${forced ? `, ${forced} forced` : ""})`)
}, 1500)
