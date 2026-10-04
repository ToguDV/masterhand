#!/usr/bin/env node
// Single-command dev orchestrator: starts opencode serve (unless already
// running), the BFF, and the requested front end together.
//
//   node scripts/dev.mjs web      -> opencode + BFF + web
//   node scripts/dev.mjs mobile   -> opencode + BFF + Expo
//   node scripts/dev.mjs desktop  -> opencode + BFF + Electron
//   node scripts/dev.mjs server   -> opencode + BFF
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import net from "node:net"
import process from "node:process"
import { registerProcess, registryPath, unregisterProcess } from "./process-registry.mjs"

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..")

// `dev:stop` reads this to target only the processes this orchestrator started.
const registryFile = registryPath(rootDir)

// Each target maps to the npm script (and extra args) it runs as the "front".
// `null` means no front end: opencode + BFF only.
const TARGETS = {
  server: null,
  web: ["dev", "-w", "@masterhand/web"],
  desktop: ["dev", "-w", "@masterhand/desktop"],
  mobile: ["start", "-w", "@masterhand/mobile"],
}

const target = process.argv[2]
if (!(target in TARGETS)) {
  console.error(`[dev] usage: node scripts/dev.mjs <${Object.keys(TARGETS).join("|")}>`)
  process.exit(1)
}

// Development env shared by the BFF and opencode (password, ports, ...).
const envFile = join(rootDir, "apps/server/.env.local")
if (existsSync(envFile)) {
  process.loadEnvFile(envFile)
  console.log(`[dev] loaded ${envFile}`)
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm"
const opencodeUrl = new URL(process.env.OPENCODE_URL ?? "http://127.0.0.1:4096")
const opencodeHost = opencodeUrl.hostname
const opencodePort = Number(opencodeUrl.port || 4096)

const children = []
let shuttingDown = false

function isPortOpen(host, port, timeout = 500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    socket.setTimeout(timeout)
    socket.once("connect", () => {
      socket.destroy()
      resolve(true)
    })
    socket.once("timeout", () => {
      socket.destroy()
      resolve(false)
    })
    socket.once("error", () => resolve(false))
  })
}

/**
 * When MasterHand reuses an opencode that it did not start, the pair only
 * works if both share OPENCODE_SERVER_PASSWORD. Probe it and warn early
 * instead of failing later with 401s and a "could not load conversation".
 */
async function warnOnOpencodeAuthMismatch() {
  const url = `http://${opencodeHost}:${opencodePort}/api/info`
  try {
    const probe = await fetch(url, { signal: AbortSignal.timeout(1500) })
    if (probe.status !== 401 && probe.status !== 403) return
    const password = process.env.OPENCODE_SERVER_PASSWORD
    if (!password) {
      console.error("[dev] WARNING: the running opencode requires a password but OPENCODE_SERVER_PASSWORD is not set.")
      console.error("[dev]   opencode v2 always requires auth; when started without the env var it generates and prints one (`server password <value>`).")
      console.error("[dev]   Copy that value into apps/server/.env.local, or stop that opencode and let this script start it.")
      return
    }
    const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode"
    const auth = "Basic " + Buffer.from(`${username}:${password}`).toString("base64")
    const check = await fetch(url, { headers: { authorization: auth }, signal: AbortSignal.timeout(1500) })
    if (check.status === 401 || check.status === 403) {
      console.error("[dev] WARNING: OPENCODE_SERVER_PASSWORD does not match the running opencode's password.")
      console.error("[dev]   Restart the reused opencode with the same value, or update apps/server/.env.local.")
    }
  } catch {
    // The BFF reports reachability; this is just an early hint.
  }
}

function killTree(child) {
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" })
    } else {
      process.kill(-child.pid, "SIGTERM")
    }
  } catch {
    // already gone
  }
}

function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  for (const { child } of children) {
    if (child.exitCode === null && child.signalCode === null) killTree(child)
    unregisterProcess(registryFile, child.pid)
  }
  process.exit(code)
}

function spawnChild(label, command, args) {
  const child = spawn(command, args, {
    cwd: rootDir,
    stdio: "inherit",
    detached: process.platform !== "win32",
  })
  // Record the process (and its group, since it is a group leader on POSIX) so
  // `dev:stop` can target exactly what this run started.
  if (child.pid) registerProcess(registryFile, { pid: child.pid, label, command: `${command} ${args.join(" ")}` })
  child.on("error", (error) => {
    if (error.code === "ENOENT") {
      console.error(`[dev] ${label}: command not found (${command})`)
      if (label === "opencode") {
        console.error("[dev] install opencode v2 (npm install -g @opencode/cli) or set MASTERHAND_SKIP_OPENCODE=1")
      }
    } else {
      console.error(`[dev] ${label} failed: ${error.message}`)
    }
    shutdown(1)
  })
  child.on("exit", (code, signal) => {
    unregisterProcess(registryFile, child.pid)
    if (shuttingDown) return
    console.log(`[dev] ${label} exited (${signal ?? code})`)
    shutdown(code ?? 0)
  })
  children.push({ label, child })
}

async function main() {
  if (process.env.MASTERHAND_SKIP_OPENCODE === "1") {
    console.log("[dev] opencode skipped (MASTERHAND_SKIP_OPENCODE=1)")
    await warnOnOpencodeAuthMismatch()
  } else if (await isPortOpen(opencodeHost, opencodePort)) {
    console.log(`[dev] opencode already listening on ${opencodeHost}:${opencodePort}, skipping`)
    await warnOnOpencodeAuthMismatch()
  } else {
    // opencode v2 always requires HTTP basic auth; when no password is
    // configured it generates one and the BFF could never know it. Generate a
    // shared password so both children authenticate against each other.
    if (!process.env.OPENCODE_SERVER_PASSWORD) {
      process.env.OPENCODE_SERVER_PASSWORD = randomBytes(18).toString("base64url")
      console.log("[dev] generated OPENCODE_SERVER_PASSWORD for this session (shared by opencode and the BFF)")
    }
    console.log(`[dev] starting opencode serve on ${opencodeHost}:${opencodePort}`)
    spawnChild("opencode", "opencode", ["serve", "--hostname", opencodeHost, "--port", String(opencodePort)])
  }

  console.log(`[dev] starting BFF on :${process.env.PORT ?? 8787}`)
  spawnChild("BFF", npm, ["run", "dev", "-w", "@masterhand/server"])

  const front = TARGETS[target]
  if (front) {
    console.log(`[dev] starting ${target}`)
    const extra = process.argv.slice(3)
    spawnChild(target, npm, ["run", ...front, ...(extra.length ? ["--", ...extra] : [])])
  }

  console.log("[dev] Ctrl+C stops this run; if a reused/leftover process survives, run: npm run dev:stop")
}

process.on("SIGINT", () => shutdown(0))
process.on("SIGTERM", () => shutdown(0))

main()
