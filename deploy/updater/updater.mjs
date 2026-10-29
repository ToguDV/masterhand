#!/usr/bin/env node
/**
 * MasterHand updater sidecar (#134).
 *
 * Runs as an opt-in Compose profile next to the BFF. It is the only process
 * that touches the Docker socket: the BFF calls this HTTP API with a shared
 * token, and the sidecar pulls/recreates exactly one Compose service. It knows
 * no arbitrary commands and exposes no host paths beyond the read-only deploy
 * directory.
 *
 * Why not Watchtower: the original project was archived in December 2025 and
 * still ships an embedded Docker SDK that cannot talk to Docker Engine 29+;
 * the maintained fork is third-party code with root-equivalent host access.
 * This is a small, auditable first-party alternative that pins the target tag
 * and keeps the BFF completely out of the Docker socket.
 */
import { spawn } from "node:child_process"
import { createHash, timingSafeEqual } from "node:crypto"
import { existsSync } from "node:fs"
import { createServer } from "node:http"
import { dirname } from "node:path"
import { pathToFileURL } from "node:url"

const MAX_BODY_BYTES = 4096
const PULL_TIMEOUT_MS = 180_000
const UP_TIMEOUT_MS = 180_000
const MAX_LOG_LINE = 2000

export function parseBearer(header) {
  if (typeof header !== "string") return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match ? match[1].trim() : null
}

/** Constant-time comparison (hash both sides so lengths never leak). */
export function tokenMatches(expected, actual) {
  if (typeof actual !== "string" || actual === "") return false
  const left = createHash("sha256").update(expected).digest()
  const right = createHash("sha256").update(actual).digest()
  return timingSafeEqual(left, right)
}

function json(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  })
  response.end(payload)
}

/**
 * Runs a child process with an argv array (never a shell), captures bounded
 * output and kills the whole process group on timeout.
 */
export function runProcess(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? PULL_TIMEOUT_MS
  const env = options.env ?? process.env
  const log = options.log ?? console.log
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"], detached: true })
    let output = ""
    const collect = (chunk) => {
      const text = chunk.toString()
      output = `${output}${text}`.slice(-MAX_LOG_LINE)
      for (const line of text.split("\n")) {
        if (line.trim()) log(`[updater] ${line.slice(0, MAX_LOG_LINE)}`)
      }
    }
    child.stdout.on("data", collect)
    child.stderr.on("data", collect)

    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL")
      } catch {
        child.kill("SIGKILL")
      }
      reject(new Error(`${command} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    timer.unref()

    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("exit", (code, signal) => {
      clearTimeout(timer)
      if (code === 0) {
        resolve(output)
        return
      }
      reject(new Error(`${command} exited with ${signal ?? code}${output ? `: ${output.slice(-500)}` : ""}`))
    })
  })
}

/**
 * Compose invocation shared by pull/up. `WORKSPACES_DIR` is overridden with
 * the host source of the running container's `/workspace` bind: the sidecar
 * resolves relative paths on its own filesystem, which would recreate the
 * container with the wrong volume.
 */
export function composeArgs(config, action) {
  const args = ["compose"]
  for (const file of config.composeFiles) args.push("-f", file)
  args.push("--project-directory", config.projectDir)
  if (config.envFile) args.push("--env-file", config.envFile)
  args.push("-p", config.project)
  if (action === "pull") {
    args.push("pull", config.service)
  } else if (action === "ps") {
    args.push("ps", "-q", config.service)
  } else {
    args.push("up", "-d", "--no-deps", "--wait", "--wait-timeout", String(config.waitTimeoutSeconds), config.service)
  }
  return args
}

async function hostWorkspaceDir(config, run, env) {
  try {
    const container = (
      await run("docker", composeArgs(config, "ps"), { ...env, timeoutMs: 30_000 })
    )
      .trim()
      .split("\n")[0]
    if (!container) return null
    const source = (
      await run(
        "docker",
        [
          "inspect",
          "--format",
          '{{range .Mounts}}{{if eq .Destination "/workspace"}}{{.Source}}{{end}}{{end}}',
          container,
        ],
        { ...env, timeoutMs: 30_000 },
      )
    ).trim()
    return source || null
  } catch (error) {
    console.warn(`[updater] could not read the current /workspace bind: ${error.message}`)
    return null
  }
}

/**
 * Builds the updater server. `run` is injectable for tests and resolves with
 * stdout or rejects on a non-zero exit.
 */
export function createUpdater(options) {
  const token = options.token
  if (!token) throw new Error("UPDATER_TOKEN is required")
  const config = options.compose
  const run = options.run ?? runProcess
  const log = options.log ?? console.log
  const baseEnv = { ...process.env }
  let inFlight = false
  let last = { startedAt: null, target: null, error: null }

  async function performUpdate(target) {
    inFlight = true
    last = { startedAt: new Date().toISOString(), target, error: null }
    try {
      const workspace = await hostWorkspaceDir(config, run, baseEnv)
      const env = {
        ...baseEnv,
        MASTERHAND_VERSION: target,
        ...(workspace ? { WORKSPACES_DIR: workspace } : {}),
      }
      log(`[updater] pulling ${config.service} (tag ${target})`)
      await run("docker", composeArgs(config, "pull"), { env, timeoutMs: PULL_TIMEOUT_MS, log })
      log("[updater] pull complete; recreating the service")
      await run("docker", composeArgs(config, "up"), { env, timeoutMs: UP_TIMEOUT_MS, log })
      log("[updater] update finished")
    } catch (error) {
      last = { ...last, error: error.message }
      console.error(`[updater] update failed: ${error.message}`)
    } finally {
      inFlight = false
    }
  }

  const handler = async (request, response) => {
    const url = request.url ?? "/"
    if (request.method === "GET" && url === "/health") {
      json(response, 200, { ok: true, updating: inFlight, last })
      return
    }
    if (request.method === "POST" && url === "/update") {
      if (!tokenMatches(token, parseBearer(request.headers.authorization))) {
        json(response, 401, { error: "unauthorized" })
        return
      }
      let size = 0
      try {
        for await (const chunk of request) {
          size += chunk.length
          if (size > MAX_BODY_BYTES) {
            json(response, 413, { error: "payload_too_large" })
            request.destroy()
            return
          }
        }
      } catch {
        json(response, 400, { error: "invalid_body" })
        return
      }
      if (inFlight) {
        json(response, 409, { error: "update_in_progress" })
        return
      }
      // The pull/recreate runs detached: the BFF is about to be restarted, so
      // the response must flush before the container goes away.
      inFlight = true
      void performUpdate(config.targetTag)
      json(response, 202, { accepted: true, target: config.targetTag })
      return
    }
    json(response, 404, { error: "not_found" })
  }

  return { handler, config }
}

function composeConfigFromEnv(env) {
  const files = (env.COMPOSE_FILE ?? "/deploy/docker-compose.yml")
    .split(",")
    .map((file) => file.trim())
    .filter(Boolean)
  if (files.length === 0) throw new Error("COMPOSE_FILE must name at least one compose file")
  for (const file of files) {
    if (!existsSync(file)) throw new Error(`compose file not found: ${file}`)
  }
  const envFile = env.COMPOSE_ENV_FILE ?? "/deploy/.env"
  if (!existsSync(envFile)) throw new Error(`compose env file not found: ${envFile}`)
  return {
    composeFiles: files,
    projectDir: env.COMPOSE_PROJECT_DIR ?? dirname(files[0]),
    envFile,
    project: env.COMPOSE_PROJECT ?? "masterhand",
    service: env.TARGET_SERVICE ?? "masterhand",
    targetTag: env.TARGET_TAG ?? "latest",
    waitTimeoutSeconds: Math.max(10, Number.parseInt(env.COMPOSE_WAIT_TIMEOUT ?? "120", 10) || 120),
  }
}

export function startUpdater(options) {
  const server = createServer((request, response) => {
    void options.handler(request, response).catch((error) => {
      console.error("[updater] request failed:", error)
      if (!response.headersSent) json(response, 500, { error: "internal_error" })
      else response.destroy()
    })
  })
  return server
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url
if (isMain) {
  try {
    const token = process.env.UPDATER_TOKEN ?? ""
    if (!token) throw new Error("UPDATER_TOKEN is required")
    if (Buffer.byteLength(token, "utf8") < 16) {
      throw new Error("UPDATER_TOKEN must be at least 16 bytes (generate one with `openssl rand -hex 32`)")
    }
    const compose = composeConfigFromEnv(process.env)
    const updater = createUpdater({ token, compose })
    const port = Number.parseInt(process.env.PORT ?? "8080", 10) || 8080
    const server = startUpdater(updater)
    server.listen(port, "0.0.0.0", () => {
      console.log(
        `[updater] listening on :${port}; service=${compose.service} project=${compose.project} target=${compose.targetTag}`,
      )
    })
  } catch (error) {
    console.error(`[updater] refusing to start: ${error instanceof Error ? error.message : error}`)
    process.exit(1)
  }
}
