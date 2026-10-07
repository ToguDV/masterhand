import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

// Static guards for the Playwright harness: a killed run once left its
// mock/BFF alive and its DATA_DIR behind; the next run silently reused both
// via `reuseExistingServer` and failed in unrelated specs. Every run must
// therefore start from wiped scratch state and never reuse a stale server.
const e2eDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "e2e")

function read(name) {
  return readFileSync(path.join(e2eDir, name), "utf8")
}

test("no webServer silently reuses a possibly-stale server", () => {
  const config = read("playwright.config.ts")
  assert.ok(!config.includes("reuseExistingServer: !"), "must not condition reuse on CI")
  const entries = config.match(/reuseExistingServer: [^,\n]+/g) ?? []
  assert.ok(entries.length >= 2, `expected a reuse flag per server, saw: ${entries}`)
  for (const entry of entries) {
    assert.equal(entry.trim(), "reuseExistingServer: false")
  }
})

test("scratch paths are constants shared by every process", () => {
  // The config file is evaluated once per process (runner AND each worker),
  // so anything derived from Date.now()/process.pid diverges between the
  // process that spawns the servers and the one that runs the specs.
  const helper = read("paths.ts")
  assert.ok(!helper.includes("Date.now()"), "scratch paths must not depend on evaluation time")
  assert.ok(!helper.includes("process.pid"), "scratch paths must not depend on the process")
  const config = read("playwright.config.ts")
  assert.ok(
    /from ["']\.\/paths["']/.test(config),
    "config must source its scratch dirs from the shared paths module",
  )
})

test("every run starts wiped and leaves no trace", () => {
  const config = read("playwright.config.ts")
  assert.ok(config.includes("globalSetup"), "config must wire a global setup")
  const setup = read("global-setup.ts")
  assert.ok(setup.includes("globalSetup"), "global setup must exist")
  assert.ok(setup.match(/await rm\(/g)?.length >= 2, "setup must wipe scratch before and after the run")
  assert.ok(setup.includes("mkdir"), "setup must recreate scratch after wiping")
})

test("specs resolve the cloudflared die file from the shared paths", () => {
  const spec = read(path.join("tests", "preview.spec.ts"))
  assert.ok(!spec.includes("/tmp/masterhand-e2e-cloudflared-die"), "spec must not hardcode the die file")
  assert.ok(spec.includes("paths"), "spec must import the die file from the shared paths module")
})
