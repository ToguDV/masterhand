#!/usr/bin/env node
// Docker-based development stack.
//
//   node scripts/dev-docker.mjs web|server      foreground stack (Ctrl+C stops it)
//   node scripts/dev-docker.mjs desktop|mobile  stack detached + host front end
//   node scripts/dev-docker.mjs stop            stop the stack (keeps volumes)
//   node scripts/dev-docker.mjs logs            follow the stack logs
//
// It wraps exactly the deployment Compose files plus docker-compose.dev.yml, so
// development and production share services, images, network, paths and the
// environment contract; only the BFF and web run hot-reloading. The native
// `scripts/dev.mjs` flow stays available as `npm run dev:native:*`.
import { spawn } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import process from "node:process"

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..")

export const COMPOSE_FILES = ["-f", "deploy/docker-compose.yml", "-f", "deploy/docker-compose.dev.yml"]
export const ENV_FILE = "deploy/.env.dev"
export const ACTIONS = ["web", "server", "desktop", "mobile", "stop", "logs"]

/** Compose arguments for a subcommand, always with the base + dev files and env file. */
export function composeArgs(args) {
  return ["compose", ...COMPOSE_FILES, "--env-file", ENV_FILE, ...args]
}

/** The `dev.mjs` front end the stack should run for each action. */
export function targetFor(action) {
  return action === "server" ? "server" : "web"
}

const FRONTS = {
  desktop: ["run", "dev", "-w", "@masterhand/desktop"],
  mobile: ["start", "-w", "@masterhand/mobile"],
}

function usage() {
  console.error(`[dev] usage: node scripts/dev-docker.mjs <${ACTIONS.join("|")}>`)
}

function ensureEnvFile() {
  const envFile = join(rootDir, ENV_FILE)
  if (existsSync(envFile)) return
  const example = join(rootDir, `${ENV_FILE}.example`)
  if (!existsSync(example)) {
    console.error(`[dev] missing ${ENV_FILE} (and ${ENV_FILE}.example)`)
    process.exit(1)
  }
  copyFileSync(example, envFile)
  console.log(`[dev] created ${ENV_FILE} from ${ENV_FILE}.example`)
}

/**
 * Docker creates missing bind sources as root, which the BFF (uid 1000) then
 * cannot write. Create them as the invoking user so ownership matches.
 */
function ensureDirs() {
  for (const dir of [join(rootDir, "data", "dev"), join(rootDir, "workspace")]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }
}

function runCompose(args, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn("docker", composeArgs(args), {
      cwd: rootDir,
      stdio: "inherit",
      env: { ...process.env, ...extraEnv },
    })
    child.on("error", (error) => {
      if (error.code === "ENOENT") {
        console.error("[dev] docker not found. Install Docker with the Compose plugin (https://docs.docker.com/get-docker/).")
      } else {
        console.error(`[dev] docker failed: ${error.message}`)
      }
      resolve(1)
    })
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 130 : 0)))
  })
}

function runHost(action) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm"
  const child = spawn(npm, ["run", ...FRONTS[action]], { cwd: rootDir, stdio: "inherit" })
  child.on("error", (error) => {
    console.error(`[dev] ${action} failed: ${error.message}`)
    process.exit(1)
  })
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      try {
        child.kill(signal)
      } catch {
        // already gone
      }
    })
  }
  child.on("exit", (code) => {
    console.log(`[dev] ${action} exited. The Docker stack is still running; stop it with \`npm run dev:stop\`.`)
    process.exit(code ?? 0)
  })
}

async function main() {
  const action = process.argv[2] ?? "web"
  if (!ACTIONS.includes(action)) {
    usage()
    process.exit(1)
  }

  ensureEnvFile()
  ensureDirs()

  if (action === "stop") {
    process.exit(await runCompose(["down"]))
  }
  if (action === "logs") {
    process.exit(await runCompose(["logs", "-f"]))
  }

  const env = { MASTERHAND_DEV_TARGET: targetFor(action) }

  if (action === "web" || action === "server") {
    console.log(`[dev] starting the Docker stack (${action}); Ctrl+C stops it`)
    process.exit(await runCompose(["up", "--build"], env))
  }

  // desktop/mobile run on the host (GUI/device) against the Dockerized BFF.
  console.log(`[dev] starting the Docker stack for ${action}`)
  const code = await runCompose(["up", "-d", "--build"], env)
  if (code !== 0) process.exit(code)
  console.log(`[dev] stack is up (opencode + BFF + web). Starting ${action} on the host...`)
  runHost(action)
}

const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url
if (invokedDirectly) main()
