import assert from "node:assert/strict"
import test from "node:test"
import { composeArgs, createUpdater, parseBearer, startUpdater, tokenMatches } from "../deploy/updater/updater.mjs"

const TOKEN = "0123456789abcdef0123456789abcdef"

function compose(overrides = {}) {
  return {
    composeFiles: ["/deploy/docker-compose.yml"],
    projectDir: "/deploy",
    envFile: "/deploy/.env",
    project: "masterhand",
    service: "masterhand",
    targetTag: "latest",
    waitTimeoutSeconds: 120,
    ...overrides,
  }
}

/** Records compose invocations. Returning "" for `ps` means "no container". */
function fakeRun(handler = () => "") {
  const calls = []
  const run = async (command, args, options = {}) => {
    calls.push({ command, args, env: options.env })
    return handler(command, args, calls) ?? ""
  }
  return { run, calls }
}

async function withServer(run, fn) {
  const updater = createUpdater({ token: TOKEN, compose: compose(), run, log: () => {} })
  const server = startUpdater(updater)
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address()
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("condition not met in time")
}

test("parseBearer extracts only a bearer token", () => {
  assert.equal(parseBearer("Bearer abc"), "abc")
  assert.equal(parseBearer("bearer  abc  "), "abc")
  assert.equal(parseBearer("Basic abc"), null)
  assert.equal(parseBearer(undefined), null)
})

test("tokenMatches compares hashes without leaking length", () => {
  assert.equal(tokenMatches(TOKEN, TOKEN), true)
  assert.equal(tokenMatches(TOKEN, `${TOKEN}x`), false)
  assert.equal(tokenMatches(TOKEN, ""), false)
  assert.equal(tokenMatches(TOKEN, null), false)
})

test("composeArgs pins the project, service and target action", () => {
  const pull = composeArgs(compose(), "pull")
  assert.deepEqual(pull, [
    "compose",
    "-f",
    "/deploy/docker-compose.yml",
    "--project-directory",
    "/deploy",
    "--env-file",
    "/deploy/.env",
    "-p",
    "masterhand",
    "pull",
    "masterhand",
  ])
  const up = composeArgs(compose(), "up")
  assert.ok(up.includes("--no-deps"))
  assert.ok(up.includes("--wait"))
  assert.equal(up.at(-1), "masterhand")
  const ps = composeArgs(compose(), "ps")
  assert.deepEqual(ps.slice(-3), ["ps", "-q", "masterhand"])
})

test("health is public; update requires the shared token", async () => {
  const { run } = fakeRun()
  await withServer(run, async (base) => {
    const health = await fetch(`${base}/health`)
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), { ok: true, updating: false, last: { startedAt: null, target: null, error: null } })

    const missing = await fetch(`${base}/update`, { method: "POST" })
    assert.equal(missing.status, 401)

    const wrong = await fetch(`${base}/update`, {
      method: "POST",
      headers: { authorization: "Bearer nope" },
    })
    assert.equal(wrong.status, 401)

    const unknown = await fetch(`${base}/nope`)
    assert.equal(unknown.status, 404)
  })
})

test("a valid trigger pulls then recreates only the masterhand service", async () => {
  const { run, calls } = fakeRun()
  await withServer(run, async (base) => {
    const response = await fetch(`${base}/update`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ version: "0.2.0" }),
    })
    assert.equal(response.status, 202)
    assert.deepEqual(await response.json(), { accepted: true, target: "latest" })

    await waitFor(() => calls.some((call) => call.args.includes("up")))
    const actions = calls.map((call) => (call.args.includes("up") ? "up" : call.args.includes("pull") ? "pull" : "ps"))
    assert.deepEqual(actions, ["ps", "pull", "up"])
    const pull = calls.find((call) => call.args.includes("pull"))
    assert.equal(pull.env.MASTERHAND_VERSION, "latest")
    const up = calls.find((call) => call.args.includes("up"))
    assert.ok(up.args.includes("--no-deps"))
  })
})

test("rejects a concurrent update while one is running", async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const { run, calls } = fakeRun(async (_command, args) => {
    if (args.includes("pull")) await gate
    return ""
  })
  await withServer(run, async (base) => {
    const first = await fetch(`${base}/update`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } })
    assert.equal(first.status, 202)
    await waitFor(() => calls.some((call) => call.args.includes("pull")))
    const second = await fetch(`${base}/update`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } })
    assert.equal(second.status, 409)
    assert.deepEqual(await second.json(), { error: "update_in_progress" })
    release()
    await waitFor(() => calls.some((call) => call.args.includes("up")))
  })
})

test("a failed pull is reported without crashing and allows a retry", async () => {
  let fail = true
  const { run, calls } = fakeRun(async (_command, args) => {
    if (args.includes("pull") && fail) throw new Error("registry unreachable")
    return ""
  })
  await withServer(run, async (base) => {
    const first = await fetch(`${base}/update`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } })
    assert.equal(first.status, 202)

    let health
    for (let index = 0; index < 100; index += 1) {
      health = await (await fetch(`${base}/health`)).json()
      if (health.last.error) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.match(health.last.error, /registry unreachable/)

    fail = false
    const retry = await fetch(`${base}/update`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } })
    assert.equal(retry.status, 202)
    await waitFor(() => calls.some((call) => call.args.includes("up")))
  })
})

test("uses the host /workspace bind when recreating the container", async () => {
  const { run, calls } = fakeRun(async (_command, args) => {
    if (args.includes("ps")) return "container-id\n"
    if (args.includes("inspect")) return "/srv/masterhand/workspace\n"
    return ""
  })
  await withServer(run, async (base) => {
    await fetch(`${base}/update`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } })
    await waitFor(() => calls.some((call) => call.args.includes("up")))
    const up = calls.find((call) => call.args.includes("up"))
    assert.equal(up.env.WORKSPACES_DIR, "/srv/masterhand/workspace")
  })
})
