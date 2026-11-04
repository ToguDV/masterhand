#!/usr/bin/env node
/**
 * MasterHand resilience supervisor (`watchdog`).
 *
 * Runs next to the BFF as the only container allowed to restart the two
 * services with the Docker socket. It is deliberately small and has no host
 * paths: it resolves `masterhand`/`opencode` by Compose labels, watches their
 * health, restart count and memory, restarts them with a bounded budget and
 * opens a circuit (stops the service) when the budget is exhausted.
 *
 * The BFF never sees the Docker socket (rule 44 / ADR-41); it calls this
 * sidecar with a shared token on the internal network. Containers are
 * addressed only by the internally resolved id, never by a request value.
 */
import { spawn } from "node:child_process"
import { createHash, timingSafeEqual } from "node:crypto"
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { dirname } from "node:path"
import { pathToFileURL } from "node:url"

const MAX_BODY_BYTES = 1024
const MAX_LOG_LINE = 2000
const STATE_VERSION = 1

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
  const timeoutMs = options.timeoutMs ?? 30_000
  const env = options.env ?? process.env
  const log = options.log ?? console.log
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"], detached: true })
    let output = ""
    const collect = (chunk) => {
      const text = chunk.toString()
      output = `${output}${text}`.slice(-MAX_LOG_LINE)
      for (const line of text.split("\n")) {
        if (line.trim()) log(`[watchdog] ${line.slice(0, MAX_LOG_LINE)}`)
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

const BYTE_FACTORS = {
  B: 1,
  KB: 1000,
  MB: 1000 ** 2,
  GB: 1000 ** 3,
  TB: 1000 ** 4,
  KIB: 1024,
  MIB: 1024 ** 2,
  GIB: 1024 ** 3,
  TIB: 1024 ** 4,
}

export function parseBytes(text) {
  if (typeof text !== "string") return null
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*([KMGTP]?i?B)$/i.exec(text.trim())
  if (!match) return null
  const value = Number(match[1])
  const factor = BYTE_FACTORS[match[2].toUpperCase()]
  if (!Number.isFinite(value) || !factor) return null
  return Math.round(value * factor)
}

/** `docker stats` renders `used / limit` (e.g. `1.2GiB / 4GiB`). */
export function parseMemoryUsage(text) {
  if (typeof text !== "string") return null
  const [usedText, limitText] = text.split("/").map((part) => part.trim())
  const usedBytes = parseBytes(usedText)
  const limitBytes = parseBytes(limitText)
  if (usedBytes === null || limitBytes === null || limitBytes <= 0) return null
  return { usedBytes, limitBytes }
}

function defaultState() {
  return { version: STATE_VERSION, services: {} }
}

function loadState(file, log) {
  if (!file) return defaultState()
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.version === STATE_VERSION &&
      parsed.services &&
      typeof parsed.services === "object"
    ) {
      return parsed
    }
    log(`[watchdog] ignoring incompatible state file ${file}`)
  } catch {
    // Missing or corrupt: start fresh. A corrupt budget must never block boot.
  }
  return defaultState()
}

function saveState(file, state, log) {
  if (!file) return
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    const temp = `${file}.tmp`
    writeFileSync(temp, JSON.stringify(state), { mode: 0o600 })
    renameSync(temp, file)
    chmodSync(file, 0o600)
  } catch (error) {
    log(`[watchdog] could not persist state: ${error.message}`)
  }
}

/** Compose labels are how the sidecar resolves a service without host paths. */
export function composeFilters(project, service) {
  return [
    "--filter",
    `label=com.docker.compose.project=${project}`,
    "--filter",
    `label=com.docker.compose.service=${service}`,
  ]
}

function numberOr(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/**
 * Builds the supervisor. `run` is injectable for tests and resolves with
 * stdout (rejects on a non-zero exit).
 */
export function createWatchdog(options) {
  const run = options.run ?? runProcess
  const log = options.log ?? console.log
  const now = options.now ?? Date.now
  const project = options.project ?? "masterhand"
  const services = (options.services ?? ["masterhand", "opencode"]).filter(Boolean)
  const stateFile = options.stateFile ?? null
  const config = {
    pollMs: Math.max(2_000, numberOr(options.pollMs, 10_000)),
    maxAttempts: Math.max(1, numberOr(options.maxAttempts, 3)),
    stabilityMs: Math.max(1_000, numberOr(options.stabilityMs, 5 * 60_000)),
    startupGraceMs: Math.max(0, numberOr(options.startupGraceMs, 180_000)),
    restartCooldownMs: Math.max(0, numberOr(options.restartCooldownMs, 30_000)),
    unhealthySamples: Math.max(1, numberOr(options.unhealthySamples, 2)),
    memorySamples: Math.max(1, numberOr(options.memorySamples, 6)),
    memoryPct: Math.max(1, numberOr(options.memoryPct, 95)),
    stopOnCircuit: options.stopOnCircuit !== false,
    token: options.token ?? "",
    webhookUrl: options.webhookUrl ?? null,
    actionCooldownMs: Math.max(0, numberOr(options.actionCooldownMs, 10_000)),
  }

  const state = loadState(stateFile, log)
  for (const service of services) {
    if (!state.services[service]) state.services[service] = {}
    state.services[service] = {
      attempts: 0,
      lastFailureAt: null,
      lastRestartAt: null,
      lastRestartCount: null,
      healthySince: null,
      circuitOpen: false,
      stoppedByCircuit: false,
      restarting: false,
      actionInFlight: false,
      unhealthyStreak: 0,
      memoryStreak: 0,
      memoryWarning: false,
      memory: null,
      state: "unknown",
      health: "none",
      lastIncident: null,
      containerID: null,
      initialized: false,
      ...state.services[service],
    }
    state.services[service].restarting = false
    state.services[service].actionInFlight = false
  }

  let timer = null
  let started = false
  let stopped = false
  let tickRunning = false
  const lastActionAt = new Map()
  /** Services whose container could not be resolved (logged once per outage). */
  const missing = new Set()

  function persist() {
    saveState(stateFile, state, log)
  }

  function entryFor(service) {
    return state.services[service]
  }

  function resetBudget(service, reason) {
    const entry = entryFor(service)
    entry.attempts = 0
    entry.circuitOpen = false
    entry.stoppedByCircuit = false
    entry.healthySince = null
    entry.unhealthyStreak = 0
    entry.memoryStreak = 0
    entry.memoryWarning = false
    persist()
    log(`[watchdog] ${service}: budget reset (${reason})`)
  }

  async function resolveContainer(service) {
    const output = await run(
      "docker",
      ["ps", "-a", ...composeFilters(project, service), "--format", "{{.ID}}"],
      { timeoutMs: 30_000, log },
    )
    return output.trim().split("\n").filter(Boolean)[0] ?? null
  }

  async function inspectContainer(id) {
    const output = await run("docker", ["inspect", "--format", "{{json .State}}", id], {
      timeoutMs: 30_000,
      log,
    })
    return JSON.parse(output.trim())
  }

  async function readMemory(id) {
    try {
      const output = await run("docker", ["stats", "--no-stream", "--format", "{{.MemUsage}}", id], {
        timeoutMs: 30_000,
        log,
      })
      return parseMemoryUsage(output.trim())
    } catch {
      return null // a failed stats read never triggers a restart
    }
  }

  function notifyWebhook(event, service, reason, attempt) {
    if (!config.webhookUrl) return
    const entry = entryFor(service)
    const payload = JSON.stringify({
      event,
      service,
      reason,
      attempt,
      at: now(),
      circuitOpen: entry.circuitOpen,
    })
    void fetch(config.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
      signal: AbortSignal.timeout(5_000),
    }).catch((error) => log(`[watchdog] webhook failed: ${error.message}`))
  }

  async function stopService(service, reason) {
    const entry = entryFor(service)
    entry.stoppedByCircuit = true
    entry.actionInFlight = true
    persist()
    try {
      const id = await resolveContainer(service)
      if (!id) return
      log(`[watchdog] ${service}: stopping after the circuit opened (${reason})`)
      await run("docker", ["stop", "--time", String(service === "masterhand" ? 30 : 20), id], {
        timeoutMs: 90_000,
        log,
      })
    } catch (error) {
      log(`[watchdog] ${service}: stop failed: ${error.message}`)
    } finally {
      entry.actionInFlight = false
      entry.state = "exited"
      entry.health = "none"
      entry.restarting = false
      persist()
    }
  }

  async function openCircuit(service, reason) {
    const entry = entryFor(service)
    if (entry.circuitOpen) return
    entry.circuitOpen = true
    entry.healthySince = null
    persist()
    log(`[watchdog] ${service}: circuit OPEN after ${entry.attempts} attempt(s) (${reason})`)
    notifyWebhook("circuit_open", service, reason, entry.attempts)
    if (config.stopOnCircuit) await stopService(service, reason)
  }

  async function restartService(service, reason) {
    const entry = entryFor(service)
    if (entry.actionInFlight) return
    // Mark before the first await so the poll and a manual action never stack
    // a second `docker restart` on the same service.
    entry.actionInFlight = true
    entry.restarting = true
    entry.lastRestartAt = now()
    persist()
    try {
      const id = await resolveContainer(service)
      if (!id) return
      log(`[watchdog] ${service}: restarting (${reason})`)
      await run("docker", ["restart", "--time", String(service === "masterhand" ? 30 : 20), id], {
        timeoutMs: 120_000,
        log,
      })
      notifyWebhook("restarted", service, reason, entry.attempts)
    } catch (error) {
      log(`[watchdog] ${service}: restart failed: ${error.message}`)
    } finally {
      entry.restarting = false
      entry.actionInFlight = false
      entry.state = entry.circuitOpen ? entry.state : "running"
      entry.health = "starting"
      persist()
    }
  }

  async function recordFailure(service, reason, memory, restart = true) {
    const entry = entryFor(service)
    if (entry.circuitOpen) return
    const at = now()
    if (entry.lastFailureAt !== null && at - entry.lastFailureAt < config.restartCooldownMs) return
    entry.lastFailureAt = at
    const nextAttempt = entry.attempts + 1
    entry.lastIncident = {
      at,
      service,
      reason,
      attempt: Math.min(nextAttempt, config.maxAttempts),
      memory: memory ?? null,
    }
    entry.memoryWarning = false
    if (entry.attempts >= config.maxAttempts) {
      entry.attempts = config.maxAttempts
      persist()
      await openCircuit(service, reason)
      return
    }
    entry.attempts += 1
    persist()
    log(`[watchdog] ${service}: failure ${entry.attempts}/${config.maxAttempts} (${reason})`)
    notifyWebhook("incident", service, reason, entry.attempts)
    // Docker's own restart policy already brought an externally-restarted
    // container back: count the incident but do not bounce it a second time.
    if (restart) await restartService(service, reason)
  }

  async function evaluate(service) {
    const entry = entryFor(service)
    // A restart/stop is in flight: the container state is mid-transition and
    // the poll must not stack a second action. The next tick re-reads it.
    if (entry.actionInFlight) return
    let id
    try {
      id = await resolveContainer(service)
    } catch (error) {
      log(`[watchdog] ${service}: container lookup failed: ${error.message}`)
      return
    }
    if (!id) {
      // Silent before: a sidecar pointed at another Compose project reported
      // `state: "unknown"` every tick and logged nothing, so the only symptom
      // was a banner whose Start answered 404 not_found. Log the transition
      // once (not every 10 s) so the cause is in the logs after a restart.
      if (!missing.has(service)) {
        missing.add(service)
        log(
          `[watchdog] ${service}: no container for Compose project "${project}" — check WATCHDOG_PROJECT (the stack may use a prefixed project name)`,
        )
      }
      entry.state = "unknown"
      entry.health = "none"
      persist()
      return
    }
    missing.delete(service)
    // A new container id means Compose recreated the service (updater, manual
    // `up compose up`), not a restart: clear the budget instead of counting it.
    if (entry.containerID && entry.containerID !== id) {
      entry.containerID = id
      entry.initialized = false
      resetBudget(service, "container_recreated")
    } else if (!entry.containerID) {
      entry.containerID = id
    }
    let inspected
    try {
      inspected = await inspectContainer(id)
    } catch (error) {
      log(`[watchdog] ${service}: inspect failed: ${error.message}`)
      return
    }
    const status = typeof inspected.Status === "string" ? inspected.Status : "unknown"
    const health = typeof inspected.Health?.Status === "string" ? inspected.Health.Status : "none"
    const restartCount = Number.isFinite(Number(inspected.RestartCount)) ? Number(inspected.RestartCount) : 0
    const startedAt = Date.parse(inspected.StartedAt ?? "")
    const startedAge = Number.isNaN(startedAt) ? null : now() - startedAt
    entry.state = status
    entry.health = health
    entry.restarting = status === "restarting" || entry.actionInFlight
    entry.memory = status === "running" ? await readMemory(id) : null

    if (!entry.initialized) {
      entry.initialized = true
      entry.lastRestartCount = restartCount
      persist()
      return
    }

    // A lower count means the container was recreated (updater / compose up),
    // not restarted: external intent, clear the budget rather than punish it.
    if (restartCount < entry.lastRestartCount) {
      entry.lastRestartCount = restartCount
      resetBudget(service, "container_recreated")
      return
    }

    // Docker's own restart policy brought it back (OOM/crash) before we saw
    // the exit. A watchdog `docker restart` does NOT increment this counter
    // (verified on Docker 29.9.1), so every increment is an external restart:
    // count it, but do not bounce an already-recovered container a second time.
    if (restartCount > entry.lastRestartCount) {
      const delta = restartCount - entry.lastRestartCount
      entry.lastRestartCount = restartCount
      for (let index = 0; index < delta; index += 1) {
        await recordFailure(service, "container_restarted", entry.memory, false)
        if (entry.circuitOpen) return
      }
    }

    if (status !== "running") {
      entry.healthySince = null
      entry.unhealthyStreak = 0
      entry.memoryStreak = 0
      entry.memoryWarning = false
      if (status === "exited" || status === "dead") {
        const exitCode = Number(inspected.ExitCode)
        if (inspected.OOMKilled === true) {
          await recordFailure(service, "oom", entry.memory)
        } else if (Number.isFinite(exitCode) && exitCode !== 0) {
          await recordFailure(service, `exit_${exitCode}`, entry.memory)
        } else if (!entry.circuitOpen && entry.stoppedByCircuit === false) {
          // A clean stop is user intent (docker stop): clear the budget.
          resetBudget(service, "stopped_cleanly")
        }
      }
      persist()
      return
    }

    // Do not judge a boot: the healthcheck start period and the supervisor's
    // own grace cover a cold engine (the preview-probe lesson, rule 69).
    const withinGrace = startedAge !== null && startedAge < config.startupGraceMs
    if (withinGrace || health === "starting") {
      entry.healthySince = null
      persist()
      return
    }

    if (entry.memory && entry.memory.limitBytes > 0) {
      const pct = (entry.memory.usedBytes / entry.memory.limitBytes) * 100
      if (pct >= config.memoryPct) {
        entry.memoryStreak += 1
        if (entry.memoryStreak >= config.memorySamples) entry.memoryWarning = true
      } else {
        entry.memoryStreak = 0
        entry.memoryWarning = false
      }
    }

    if (health === "unhealthy") {
      entry.unhealthyStreak += 1
      entry.healthySince = null
      if (entry.unhealthyStreak >= config.unhealthySamples) {
        await recordFailure(service, "unhealthy", entry.memory)
      }
      persist()
      return
    }

    entry.unhealthyStreak = 0
    if (health === "healthy" || health === "none") {
      entry.healthySince = entry.healthySince ?? now()
      if (now() - entry.healthySince >= config.stabilityMs) {
        if (entry.attempts > 0 || entry.circuitOpen) resetBudget(service, "stable")
        else persist()
      } else {
        persist()
      }
    } else {
      entry.healthySince = null
      persist()
    }
  }

  async function tick() {
    if (tickRunning || stopped) return
    tickRunning = true
    try {
      // Services are independent; a 120 s restart of one must not stop the
      // other from being watched/restarted during that window.
      await Promise.all(services.map((service) => evaluate(service)))
    } catch (error) {
      log(`[watchdog] tick failed: ${error.message}`)
    } finally {
      tickRunning = false
    }
  }

  function status() {
    const snapshot = {}
    for (const service of services) {
      const entry = entryFor(service)
      snapshot[service] = {
        service,
        state: entry.state,
        health: entry.health,
        memory: entry.memory,
        attempts: entry.attempts,
        maxAttempts: config.maxAttempts,
        circuitOpen: entry.circuitOpen,
        restarting: entry.restarting,
        memoryWarning: entry.memoryWarning,
        restartCount: entry.lastRestartCount,
        lastIncident: entry.lastIncident,
      }
    }
    return { ok: true, project, services: snapshot }
  }

  function actionAllowed(service) {
    const at = now()
    const previous = lastActionAt.get(service) ?? 0
    if (at - previous < config.actionCooldownMs) return false
    lastActionAt.set(service, at)
    return true
  }

  async function handleAction(service, action) {
    const entry = entryFor(service)
    if (entry.actionInFlight) return { status: 409, body: { error: "action_in_progress" } }
    if (action === "reset") {
      resetBudget(service, "manual")
      return { status: 200, body: { ok: true, service } }
    }
    // Manual start/restart overrides the circuit: the user asked for it.
    entry.attempts = 0
    entry.circuitOpen = false
    entry.stoppedByCircuit = false
    entry.lastFailureAt = null
    entry.healthySince = null
    persist()
    const id = await resolveContainer(service)
    if (!id) return { status: 404, body: { error: "not_found" } }
    if (action === "start") {
      entry.restarting = true
      entry.actionInFlight = true
      persist()
      void run("docker", ["start", id], { timeoutMs: 60_000, log })
        .catch((error) => log(`[watchdog] ${service}: start failed: ${error.message}`))
        .finally(() => {
          entry.restarting = false
          entry.actionInFlight = false
          entry.state = "running"
          entry.health = "starting"
          persist()
        })
      return { status: 202, body: { accepted: true, service, action } }
    }
    // Detached: the BFF (or its client) must not block on a 30 s restart.
    void restartService(service, "manual")
    return { status: 202, body: { accepted: true, service, action } }
  }

  const handler = async (request, response) => {
    const url = request.url ?? "/"
    if (request.method === "GET" && url === "/health") {
      json(response, 200, { ok: true })
      return
    }
    if (!config.token) {
      json(response, 503, { error: "supervisor_disabled" })
      return
    }
    if (!tokenMatches(config.token, parseBearer(request.headers.authorization))) {
      json(response, 401, { error: "unauthorized" })
      return
    }
    if (request.method === "GET" && url === "/status") {
      json(response, 200, status())
      return
    }
    const actionMatch = /^\/?(restart|reset|start)$/.exec(url)
    if (request.method === "POST" && actionMatch) {
      let size = 0
      let body = ""
      try {
        for await (const chunk of request) {
          size += chunk.length
          if (size > MAX_BODY_BYTES) {
            json(response, 413, { error: "payload_too_large" })
            request.destroy()
            return
          }
          body += chunk.toString()
        }
      } catch {
        json(response, 400, { error: "invalid_body" })
        return
      }
      let service = ""
      let parsed = null
      try {
        parsed = JSON.parse(body || "{}")
      } catch {
        json(response, 400, { error: "invalid_body" })
        return
      }
      if (parsed && typeof parsed === "object" && typeof parsed.service === "string") service = parsed.service
      if (!services.includes(service)) {
        json(response, 404, { error: "not_found" })
        return
      }
      if (!actionAllowed(service)) {
        json(response, 409, { error: "action_in_progress" })
        return
      }
      try {
        const result = await handleAction(service, actionMatch[1])
        json(response, result.status, result.body)
      } catch (error) {
        log(`[watchdog] ${service} ${actionMatch[1]} failed: ${error.message}`)
        json(response, 503, { error: "docker_unavailable" })
      }
      return
    }
    json(response, 404, { error: "not_found" })
  }

  return {
    tick,
    status,
    handler,
    start() {
      if (started || stopped) return
      started = true
      void tick()
      timer = setInterval(() => void tick(), config.pollMs)
      timer.unref?.()
    },
    stop() {
      stopped = true
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}

function configFromEnv(env) {
  const services = (env.WATCHDOG_SERVICES ?? "masterhand,opencode")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
  return {
    project: env.WATCHDOG_PROJECT?.trim() || "masterhand",
    services,
    stateFile: env.WATCHDOG_STATE_FILE?.trim() || "/state/watchdog.json",
    token: env.WATCHDOG_TOKEN?.trim() || "",
    pollMs: env.WATCHDOG_POLL_MS,
    maxAttempts: env.WATCHDOG_MAX_ATTEMPTS,
    stabilityMs: env.WATCHDOG_STABILITY_MS,
    startupGraceMs: env.WATCHDOG_STARTUP_GRACE_MS,
    restartCooldownMs: env.WATCHDOG_RESTART_COOLDOWN_MS,
    unhealthySamples: env.WATCHDOG_UNHEALTHY_SAMPLES,
    memorySamples: env.WATCHDOG_MEMORY_SAMPLES,
    memoryPct: env.WATCHDOG_MEMORY_PCT,
    stopOnCircuit: env.WATCHDOG_STOP_ON_CIRCUIT !== "false",
    webhookUrl: env.WATCHDOG_WEBHOOK_URL?.trim() || null,
  }
}

export function startWatchdog(options) {
  const watchdog = createWatchdog(options)
  const server = createServer((request, response) => {
    void watchdog.handler(request, response).catch((error) => {
      console.error("[watchdog] request failed:", error)
      if (!response.headersSent) json(response, 500, { error: "internal_error" })
      else response.destroy()
    })
  })
  return { watchdog, server }
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url
if (isMain) {
  const config = configFromEnv(process.env)
  if (!config.token) {
    console.warn("[watchdog] WATCHDOG_TOKEN is empty: automatic restarts still run, the BFF cannot read status or control them")
  }
  const watchdog = createWatchdog(config)
  const port = Number.parseInt(process.env.PORT ?? "8080", 10) || 8080
  const server = createServer((request, response) => {
    void watchdog.handler(request, response).catch((error) => {
      console.error("[watchdog] request failed:", error)
      if (!response.headersSent) json(response, 500, { error: "internal_error" })
      else response.destroy()
    })
  })
  server.listen(port, "0.0.0.0", () => {
    console.log(`[watchdog] listening on :${port} for ${config.project} (${config.services.join(", ")})`)
    watchdog.start()
  })
  const shutdown = () => {
    watchdog.stop()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 5_000).unref()
  }
  process.on("SIGTERM", shutdown)
  process.on("SIGINT", shutdown)
}
