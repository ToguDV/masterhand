import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { createWatchdog, parseMemoryUsage, tokenMatches } from "../deploy/watchdog/watchdog.mjs"

/**
 * Fake Docker CLI. `containers` keeps the state per Compose service; restart
 * and stop mutate it exactly like Docker would (restart count increments).
 */
function fakeDocker(options = {}) {
  const containers = {
    opencode: {
      id: "id-opencode",
      status: "running",
      health: "healthy",
      restartCount: 0,
      oomKilled: false,
      exitCode: 0,
      startedAt: new Date(0).toISOString(),
      memory: "100MiB / 1GiB",
      ...(options.opencode ?? {}),
    },
  }
  const calls = []
  const run = async (command, args) => {
    calls.push([command, ...args])
    if (args[0] === "ps") {
      const filter = args.find((arg) => arg.startsWith("label=com.docker.compose.service="))
      const service = filter?.split("=").pop()
      const container = containers[service]
      return container ? `${container.id}\n` : ""
    }
    if (args[0] === "inspect") {
      const id = args.at(-1)
      const container = Object.values(containers).find((entry) => entry.id === id)
      if (!container) throw new Error("no such container")
      return JSON.stringify({
        Status: container.status,
        Running: container.status === "running",
        RestartCount: container.restartCount,
        OOMKilled: container.oomKilled,
        ExitCode: container.exitCode,
        StartedAt: container.startedAt,
        Health: { Status: container.health },
      })
    }
    if (args[0] === "stats") {
      const id = args.at(-1)
      const container = Object.values(containers).find((entry) => entry.id === id)
      return container?.memory ?? "0B / 0B"
    }
    if (args[0] === "restart") {
      const id = args.at(-1)
      const container = Object.values(containers).find((entry) => entry.id === id)
      if (container) {
        container.status = "running"
        container.health = "starting"
        // Faithful to Docker 29.x: `docker restart` does NOT increment
        // RestartCount (only restart-policy restarts do).
        container.startedAt = new Date(0).toISOString()
      }
      return ""
    }
    if (args[0] === "stop") {
      const id = args.at(-1)
      const container = Object.values(containers).find((entry) => entry.id === id)
      if (container) {
        container.status = "exited"
        container.health = "none"
        container.exitCode = 0
      }
      return ""
    }
    return ""
  }
  return { containers, calls, run }
}

function makeWatchdog(fake, overrides = {}) {
  let clock = 1_000_000
  const watchdog = createWatchdog({
    run: fake.run,
    services: ["opencode"],
    project: "masterhand",
    stateFile: null,
    token: "secret",
    now: () => clock,
    log: () => {},
    pollMs: 10_000,
    maxAttempts: 3,
    stabilityMs: 300_000,
    startupGraceMs: 0,
    restartCooldownMs: 0,
    unhealthySamples: 1,
    memorySamples: 1,
    stopOnCircuit: true,
    actionCooldownMs: 0,
    ...overrides,
  })
  return {
    watchdog,
    advance(ms) {
      clock += ms
    },
    get clock() {
      return clock
    },
  }
}

async function callHandler(handler, { method = "GET", url = "/", headers = {}, body = "" }) {
  return new Promise((resolve) => {
    const request = (async function* () {
      if (body) yield Buffer.from(body)
    })()
    request.method = method
    request.url = url
    request.headers = headers
    request.destroy = () => {}
    const response = {
      statusCode: 0,
      body: "",
      headersSent: false,
      writeHead(status) {
        this.statusCode = status
        this.headersSent = true
      },
      end(payload) {
        this.body = payload
        resolve({ status: this.statusCode, body: payload ? JSON.parse(payload) : null })
      },
      destroy() {},
    }
    void handler(request, response)
  })
}

test("parses docker stats memory strings", () => {
  assert.deepEqual(parseMemoryUsage("1.2GiB / 4GiB"), { usedBytes: 1288490189, limitBytes: 4294967296 })
  assert.deepEqual(parseMemoryUsage("0B / 512MiB"), { usedBytes: 0, limitBytes: 536870912 })
  assert.equal(parseMemoryUsage("garbage"), null)
})

test("token comparison is exact and never accepts an empty token", () => {
  assert.equal(tokenMatches("secret", "secret"), true)
  assert.equal(tokenMatches("secret", "secre"), false)
  assert.equal(tokenMatches("secret", ""), false)
})

test("does nothing while the service is healthy", async () => {
  const fake = fakeDocker()
  const h = makeWatchdog(fake)
  await h.watchdog.tick()
  await h.watchdog.tick()
  h.advance(400_000)
  await h.watchdog.tick()
  assert.equal(fake.calls.filter((call) => call[1] === "restart").length, 0)
  const status = h.watchdog.status()
  assert.equal(status.services.opencode.state, "running")
  assert.equal(status.services.opencode.attempts, 0)
  assert.equal(status.services.opencode.circuitOpen, false)
})

test("restarts an unhealthy service and resets the budget after a stable window", async () => {
  const fake = fakeDocker()
  const h = makeWatchdog(fake)
  await h.watchdog.tick() // initialize
  fake.containers.opencode.health = "unhealthy"
  await h.watchdog.tick() // failure 1 -> restart
  assert.equal(fake.calls.filter((call) => call[1] === "restart").length, 1)
  assert.equal(h.watchdog.status().services.opencode.attempts, 1)
  // Docker's restart brings it back; the expected increment is consumed.
  fake.containers.opencode.health = "healthy"
  await h.watchdog.tick()
  h.advance(300_001)
  await h.watchdog.tick()
  assert.equal(h.watchdog.status().services.opencode.attempts, 0)
})

test("opens the circuit after three fast failures and stops the service", async () => {
  const fake = fakeDocker()
  const h = makeWatchdog(fake)
  await h.watchdog.tick()
  for (let attempt = 0; attempt < 4; attempt += 1) {
    fake.containers.opencode.health = "unhealthy"
    fake.containers.opencode.startedAt = new Date(h.clock - 10_000).toISOString()
    await h.watchdog.tick()
  }
  const restarts = fake.calls.filter((call) => call[1] === "restart").length
  const stops = fake.calls.filter((call) => call[1] === "stop").length
  assert.equal(restarts, 3, `expected 3 restarts, got ${restarts}`)
  assert.equal(stops, 1)
  const status = h.watchdog.status().services.opencode
  assert.equal(status.circuitOpen, true)
  assert.equal(status.attempts, 3)
})

test("counts an external restart without bouncing the service a second time", async () => {
  const fake = fakeDocker()
  const h = makeWatchdog(fake)
  await h.watchdog.tick() // initialize at count 0
  fake.containers.opencode.restartCount = 1
  fake.containers.opencode.health = "healthy"
  await h.watchdog.tick()
  assert.equal(fake.calls.filter((call) => call[1] === "restart").length, 0)
  assert.equal(h.watchdog.status().services.opencode.attempts, 1)
})

test("a watchdog restart does not forgive a later external crash", async () => {
  const fake = fakeDocker()
  const h = makeWatchdog(fake)
  await h.watchdog.tick()
  fake.containers.opencode.health = "unhealthy"
  await h.watchdog.tick()
  assert.equal(h.watchdog.status().services.opencode.attempts, 1)
  assert.equal(fake.containers.opencode.restartCount, 0)
  // Docker's restart policy brings it back after a genuine crash: that count
  // is a new failure, not "our restart".
  fake.containers.opencode.restartCount = 1
  fake.containers.opencode.health = "healthy"
  await h.watchdog.tick()
  assert.equal(h.watchdog.status().services.opencode.attempts, 2)
})

test("resets the budget when the container is recreated externally", async () => {
  const fake = fakeDocker()
  const h = makeWatchdog(fake)
  await h.watchdog.tick()
  fake.containers.opencode.health = "unhealthy"
  await h.watchdog.tick()
  assert.equal(h.watchdog.status().services.opencode.attempts, 1)
  fake.containers.opencode.id = "id-opencode-2" // a new container (recreate)
  fake.containers.opencode.restartCount = 0
  fake.containers.opencode.health = "healthy"
  await h.watchdog.tick()
  assert.equal(h.watchdog.status().services.opencode.attempts, 0)
  assert.equal(h.watchdog.status().services.opencode.circuitOpen, false)
})

test("status and actions require the token and a known service", async () => {
  const fake = fakeDocker()
  const h = makeWatchdog(fake)
  await h.watchdog.tick()

  const unauthorized = await callHandler(h.watchdog.handler, { url: "/status" })
  assert.equal(unauthorized.status, 401)
  const status = await callHandler(h.watchdog.handler, {
    url: "/status",
    headers: { authorization: "Bearer secret" },
  })
  assert.equal(status.status, 200)
  assert.equal(status.body.services.opencode.state, "running")

  const unknown = await callHandler(h.watchdog.handler, {
    method: "POST",
    url: "/restart",
    headers: { authorization: "Bearer secret" },
    body: JSON.stringify({ service: "masterhand" }),
  })
  assert.equal(unknown.status, 404)

  const restarted = await callHandler(h.watchdog.handler, {
    method: "POST",
    url: "/restart",
    headers: { authorization: "Bearer secret" },
    body: JSON.stringify({ service: "opencode" }),
  })
  assert.equal(restarted.status, 202)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(fake.calls.some((call) => call[1] === "restart"))
})

test("a manual restart clears the open circuit", async () => {
  const fake = fakeDocker()
  const h = makeWatchdog(fake)
  await h.watchdog.tick()
  for (let attempt = 0; attempt < 4; attempt += 1) {
    fake.containers.opencode.health = "unhealthy"
    fake.containers.opencode.startedAt = new Date(h.clock - 10_000).toISOString()
    await h.watchdog.tick()
  }
  assert.equal(h.watchdog.status().services.opencode.circuitOpen, true)
  const response = await callHandler(h.watchdog.handler, {
    method: "POST",
    url: "/restart",
    headers: { authorization: "Bearer secret" },
    body: JSON.stringify({ service: "opencode" }),
  })
  assert.equal(response.status, 202)
  assert.equal(h.watchdog.status().services.opencode.circuitOpen, false)
  assert.equal(h.watchdog.status().services.opencode.attempts, 0)
})

test("logs an unresolved service once and never reports it as running", async () => {
  // Regression: a watchdog pointed at the wrong Compose project (prod runs as
  // `masterhand-prod`, the sidecar looked for `masterhand`) found no container,
  // reported `state: unknown` and logged nothing at all, so the only symptom
  // was a banner whose Start button answered 404 not_found.
  const fake = fakeDocker()
  delete fake.containers.opencode
  const logs = []
  const h = makeWatchdog(fake, { log: (message) => logs.push(message) })
  await h.watchdog.tick()
  await h.watchdog.tick()
  assert.equal(h.watchdog.status().services.opencode.state, "unknown")
  const missing = logs.filter((line) => line.includes("masterhand"))
  assert.equal(missing.length, 1)
  assert.match(missing[0], /no container/i)
  assert.match(missing[0], /WATCHDOG_PROJECT/)
})

test("persists the restart budget across supervisor restarts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "masterhand-watchdog-"))
  const stateFile = join(dir, "watchdog.json")
  try {
    const fake = fakeDocker()
    const first = makeWatchdog(fake, { stateFile })
    await first.watchdog.tick()
    fake.containers.opencode.health = "unhealthy"
    await first.watchdog.tick()
    assert.equal(first.watchdog.status().services.opencode.attempts, 1)
    const persisted = JSON.parse(readFileSync(stateFile, "utf8"))
    assert.equal(persisted.services.opencode.attempts, 1)

    const second = makeWatchdog(fake, { stateFile })
    assert.equal(second.watchdog.status().services.opencode.attempts, 1)
    second.watchdog.stop()
    first.watchdog.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
