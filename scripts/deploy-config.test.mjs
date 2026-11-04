import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const compose = readFileSync(join(repoRoot, "deploy", "docker-compose.yml"), "utf8")
const devCompose = readFileSync(join(repoRoot, "deploy", "docker-compose.dev.yml"), "utf8")

// #218: project-level opencode plugins/config execute as the engine user
// (verified with a marker plugin against the pinned 2.0.6 image: it ran on
// session creation; with the flag it never loads). The flag feeds opencode
// 2.0.6 `ServerOptions.config.project`, so pin it here; the runtime probe is
// recorded in the PR, not in this file.
test("the opencode service disables project-level config/plugin discovery (#218)", () => {
  assert.match(compose, /OPENCODE_CONFIG_PROJECT_DISABLE:\s*["']?true["']?/)
})

test("the shell dropper stays configured alongside the project disable (#218)", () => {
  // `OPENCODE_CONFIG_CONTENT` is explicit config: it still applies with
  // project discovery off, so agent shells keep dropping to `agent`.
  assert.match(compose, /OPENCODE_CONFIG_CONTENT:.*agent-exec/)
})

test("the dev overlay tags its own image instead of the production tag", () => {
  // A dev build (`NODE_ENV=development`, Vite + tsx watch) once reused
  // `ghcr.io/togudv/masterhand:latest`; a later production `docker compose up`
  // silently ran that image and skipped the production secret checks.
  assert.match(devCompose, /image:\s*\$\{MASTERHAND_DEV_IMAGE:-masterhand-dev:local\}/)
  assert.doesNotMatch(devCompose, /image:\s*ghcr\.io\/togudv\/masterhand:/)
})

test("the opencode service keeps the engine kill capability (#307)", () => {
  // ADR-54: the engine binary carries cap_kill=ep, and the capability must be
  // in the service's bounding set even when a runtime drops defaults. The
  // setuid dropper needs SETUID/SETGID; no-new-privileges would disable both
  // the file capability and the dropper.
  // Match the service header exactly: `  opencode:` also appears as a
  // `depends_on` key with deeper indentation inside the BFF service.
  const opencodeStart = compose.indexOf("\n  opencode:\n")
  assert.ok(opencodeStart >= 0, "missing opencode service")
  const opencodeBlock = compose.slice(opencodeStart, compose.indexOf("\n  watchdog:\n", opencodeStart))
  assert.match(opencodeBlock, /cap_add:\s*\n\s*-\s*KILL/)
  assert.match(opencodeBlock, /-\s*SETFCAP/)
  assert.doesNotMatch(opencodeBlock, /-\s*SETPCAP/)
  assert.match(opencodeBlock, /-\s*SETUID/)
  assert.match(opencodeBlock, /-\s*SETGID/)
  assert.doesNotMatch(opencodeBlock, /no-new-privileges:\s*true/)
  // Least privilege: the BFF never gets CAP_KILL.
  const masterhandStart = compose.indexOf("\n  masterhand:\n")
  assert.ok(masterhandStart >= 0, "missing masterhand service")
  const masterhandBlock = compose.slice(masterhandStart, opencodeStart)
  assert.doesNotMatch(masterhandBlock, /-\s*KILL/)
})

test("the resilience watchdog is the only always-on Docker-socket consumer", () => {
  assert.match(compose, /^ {2}watchdog:/m)
  assert.match(compose, /ghcr\.io\/togudv\/masterhand-watchdog:/)
  assert.match(compose, /WATCHDOG_SERVICES:\s*masterhand,opencode/)
  assert.match(compose, /WATCHDOG_STOP_ON_CIRCUIT:/)
  assert.match(compose, /watchdog_state:\/state/)
  // The BFF and the engine must never see the socket.
  const masterhandBlock = compose.slice(compose.indexOf("  masterhand:"), compose.indexOf("  opencode:"))
  const opencodeBlock = compose.slice(compose.indexOf("  opencode:"), compose.indexOf("  watchdog:"))
  assert.doesNotMatch(masterhandBlock, /docker\.sock/)
  assert.doesNotMatch(opencodeBlock, /docker\.sock/)
  assert.match(compose, /WATCHDOG_URL:\s*http:\/\/watchdog:8080/)
  assert.match(compose, /WATCHDOG_TOKEN:/)
})

test("the supervised sidecars follow the Compose project", () => {
  // The project name prefixes the named volumes, so a deployment that renames
  // it (dev + prod on one host) must not leave the watchdog looking for
  // `masterhand` and reporting `state: unknown` while the engine is running.
  assert.match(compose, /^name: masterhand$/m)
  assert.match(compose, /WATCHDOG_PROJECT:\s*\$\{COMPOSE_PROJECT_NAME:-masterhand\}/)
  assert.match(compose, /COMPOSE_PROJECT:\s*\$\{COMPOSE_PROJECT_NAME:-masterhand\}/)
})

test("the dev overlay owns its own Compose project", () => {
  // Dev and production coexist without configuration: the overlay overrides
  // the base project name and therefore gets its own containers and volumes.
  assert.match(devCompose, /^name: masterhand-dev$/m)
})

test("the watchdog has no published ports and a token-gated control surface", () => {
  const block = compose.slice(compose.indexOf("  watchdog:"), compose.indexOf("  # Opt-in one-click BFF updater"))
  assert.doesNotMatch(block, /ports:/)
  assert.match(block, /security_opt:\s*\n\s*- no-new-privileges:true/)
  // The BFF's env_file carries the token into the process, never into a client.
  assert.doesNotMatch(block, /env_file:/)
})

test("container hardening is pinned (init, pids, OOM score, heap caps)", () => {
  assert.match(compose, /init: true/)
  assert.match(compose, /pids:\s*\$\{MASTERHAND_PIDS_LIMIT:-256\}/)
  assert.match(compose, /pids:\s*\$\{OPENCODE_PIDS_LIMIT:-1024\}/)
  assert.match(compose, /oom_score_adj:\s*\$\{MASTERHAND_OOM_SCORE_ADJ:--500\}/)
  assert.match(compose, /oom_score_adj:\s*\$\{OPENCODE_OOM_SCORE_ADJ:--500\}/)
  assert.match(compose, /NODE_OPTIONS:\s*--max-old-space-size=\$\{MASTERHAND_HEAP_MB:-768\}/)
  assert.match(compose, /NODE_OPTIONS:\s*--max-old-space-size=\$\{OPENCODE_HEAP_MB:-2048\}/)
  assert.match(compose, /stop_grace_period: 30s/)
  assert.match(compose, /start_period: 60s/)
})

test("the release workflow publishes the watchdog image", () => {
  const workflow = readFileSync(join(repoRoot, ".github", "workflows", "release.yml"), "utf8")
  assert.match(workflow, /-watchdog:/)
  assert.match(workflow, /deploy\/watchdog\.Dockerfile/)
})

test("the env example documents the resilience knobs", () => {
  const example = readFileSync(join(repoRoot, "deploy", ".env.example"), "utf8")
  assert.match(example, /WATCHDOG_TOKEN=/)
  assert.match(example, /WATCHDOG_MAX_ATTEMPTS=3/)
  assert.match(example, /RESILIENCE_AUTO_RESUME=true/)
  assert.match(example, /RESILIENCE_AUTO_CONTINUE_CHATS=true/)
})
