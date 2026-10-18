import assert from "node:assert/strict"
import { readdirSync, readFileSync, existsSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

// Static guards for the per-worker Playwright harness (#175). The failure
// classes they lock out:
// - a server spawned once per run and shared by every worker (Playwright
//   `webServer`) while specs flip process-global mock controls and read
//   app-global lists: cross-worker collisions (measured 2026-10-17: w2 lost
//   5/103 tests, w4 lost 8/103),
// - clock/pid-derived scratch paths or ports diverging between the process
//   that spawns a worker's servers and the specs it runs against them,
// - a killed run's leftover servers or scratch state poisoning the next run,
// - a spec hardcoding the old fixed ports (or the run-global die file) after
//   the derivation moved to the worker index.
const e2eDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "e2e")

// Lazy on purpose: on a pre-fix revision a missing file must fail its own
// guard with a readable message, not crash the whole file at import time.
function read(name) {
  const file = path.join(e2eDir, name)
  assert.ok(existsSync(file), `e2e/${name} must exist`)
  return readFileSync(file, "utf8")
}

function number(source, pattern, what) {
  const match = pattern.exec(source)
  assert.ok(match, `could not extract ${what}`)
  return Number(match[1])
}

test("every worker provisions its own servers; no shared webServer", () => {
  const config = read("playwright.config.ts")
  const fixtures = read("fixtures.ts")
  // `webServer` starts exactly one mock/BFF for the whole run: that shared
  // harness is the failure class #175 removed.
  assert.ok(!/\bwebServer\b/.test(config), "config must not spawn shared servers; the worker fixture does")
  assert.ok(!config.includes("reuseExistingServer"), "a shared server must not come back behind a reuse flag")
  assert.match(fixtures, /scope:\s*"worker"/, "the harness fixture must be worker-scoped")
  assert.match(fixtures, /from ["']\.\/paths["']/, "the fixture must derive ports/paths from paths.ts")
  assert.match(fixtures, /spawn\(/, "the fixture must spawn the per-worker servers")
  assert.match(fixtures, /baseURL/, "the fixture must override the worker's baseURL")
  assert.ok(!/^\s*baseURL:/m.test(config), "baseURL must not be pinned globally in the config")
})

test("servers are awaited healthy before specs run and killed with the worker", () => {
  const fixtures = read("fixtures.ts")
  assert.match(fixtures, /\/global\/health/, "the mock must be health-polled")
  assert.match(fixtures, /\/api\/health/, "the BFF must be health-polled")
  assert.match(fixtures, /SIGTERM/, "teardown must SIGTERM the servers")
  assert.match(fixtures, /SIGKILL/, "teardown must SIGKILL survivors")
})

test("ports, scratch dirs and the die file derive from the worker index", () => {
  const paths = read("paths.ts")
  // The config/fixture module is evaluated once per process; anything derived
  // from Date.now() or process.pid would diverge between the runner, the
  // process spawning the servers and the one running the specs.
  assert.ok(!paths.includes("Date.now()"), "ports/paths must not depend on evaluation time")
  assert.ok(!paths.includes("process.pid"), "ports/paths must not depend on the process")
  assert.match(paths, /TEST_PARALLEL_INDEX/, "the worker index must come from Playwright")
  assert.match(paths, /e2eDieFile/, "the die file must be per-worker")
  const mockBase = number(paths, /E2E_MOCK_BASE_PORT = (\d+)/, "E2E_MOCK_BASE_PORT")
  const bffBase = number(paths, /E2E_BFF_BASE_PORT = (\d+)/, "E2E_BFF_BASE_PORT")
  const maxWorkers = number(paths, /E2E_MAX_WORKERS = (\d+)/, "E2E_MAX_WORKERS")
  assert.notEqual(mockBase, bffBase, "mock and BFF blocks must not overlap")
  assert.ok(maxWorkers >= 4, "the reserved space must support the pinned worker count")
})

test("the suite runs parallel workers within the reserved block", () => {
  const workers = number(read("playwright.config.ts"), /workers:\s*(\d+)/, "workers")
  const maxWorkers = number(read("paths.ts"), /E2E_MAX_WORKERS = (\d+)/, "E2E_MAX_WORKERS")
  assert.ok(workers >= 2, `workers must be > 1 (per-worker isolation, #175); saw ${workers}`)
  assert.ok(workers <= maxWorkers, `workers (${workers}) must stay inside E2E_MAX_WORKERS (${maxWorkers})`)
})

test("every run starts wiped and leaves no trace", () => {
  const config = read("playwright.config.ts")
  assert.ok(config.includes("globalSetup"), "config must wire a global setup")
  const setup = read("global-setup.ts")
  assert.ok((setup.match(/await rm\(/g) ?? []).length >= 2, "setup must wipe scratch before and after the run")
  // The shortened client deadlines are baked into the web bundle at build time;
  // losing them would silently slow down the stalled-send/lost-finish specs.
  assert.match(setup, /VITE_REQUEST_TIMEOUT_MS/, "the web build must keep the shortened request deadline")
  assert.match(setup, /VITE_FINISH_TIMEOUT_MS/, "the web build must keep the shortened finish deadline")
  // Each worker wipes its own dir before spawning its servers and after they die.
  const fixtures = read("fixtures.ts")
  assert.match(fixtures, /await rm\(scratchDir/, "the worker fixture must wipe its scratch dir")
  assert.match(fixtures, /await mkdir\(/, "the worker fixture must recreate its scratch dir")
})

test("test:e2e frees the whole derived port block and wipes the scratch root", () => {
  // A killed run orphans its per-worker mock/BFF; with servers spawned per
  // worker, only a block-wide reaper keeps the next run from dying on
  // "port is already used".
  const pkg = JSON.parse(readFileSync(path.join(e2eDir, "package.json"), "utf8"))
  for (const script of ["test:e2e", "test:e2e:ui"]) {
    assert.ok(pkg.scripts[script].includes("cleanup-ports"), `${script} must free ports before playwright`)
  }
  const paths = read("paths.ts")
  const cleanup = read("cleanup-ports.mjs")
  assert.match(cleanup, /\/proc\/net/, "cleanup must keep the /proc scan")
  assert.match(cleanup, /lsof/, "cleanup must keep the non-Linux fallback")
  assert.equal(
    number(cleanup, /MOCK_BASE = (\d+)/, "cleanup MOCK_BASE"),
    number(paths, /E2E_MOCK_BASE_PORT = (\d+)/, "E2E_MOCK_BASE_PORT"),
    "cleanup-ports must mirror the mock base port",
  )
  assert.equal(
    number(cleanup, /BFF_BASE = (\d+)/, "cleanup BFF_BASE"),
    number(paths, /E2E_BFF_BASE_PORT = (\d+)/, "E2E_BFF_BASE_PORT"),
    "cleanup-ports must mirror the BFF base port",
  )
  assert.equal(
    number(cleanup, /MAX_WORKERS = (\d+)/, "cleanup MAX_WORKERS"),
    number(paths, /E2E_MAX_WORKERS = (\d+)/, "E2E_MAX_WORKERS"),
    "cleanup-ports must mirror E2E_MAX_WORKERS so every worker port is freed",
  )
  const cleanupScratch = /SCRATCH_ROOT = "([^"]+)"/.exec(cleanup)
  const pathsScratch = /E2E_SCRATCH_ROOT = "([^"]+)"/.exec(paths)
  assert.ok(cleanupScratch && pathsScratch, "both files must define the scratch root")
  assert.equal(cleanupScratch[1], pathsScratch[1], "cleanup-ports must wipe the run's scratch root")
  assert.match(cleanup, /rmSync/, "cleanup-ports must reclaim a killed run's scratch dirs")
})

test("specs derive ports, preview port and die file from paths.ts", () => {
  const testsDir = path.join(e2eDir, "tests")
  const files = readdirSync(testsDir).filter((file) => file.endsWith(".ts"))
  assert.ok(files.length >= 30, `expected the spec suite, saw ${files.length} files`)
  for (const file of files) {
    const source = readFileSync(path.join(testsDir, file), "utf8")
    assert.ok(
      !/127\.0\.0\.1:(4097|8788)/.test(source),
      `${file} hardcodes a harness port; derive it from paths.ts`,
    )
    assert.ok(
      !source.includes("masterhand-e2e-cloudflared-die"),
      `${file} hardcodes the die file; derive it from paths.ts`,
    )
    // Every spec must import the extended `test` so the worker fixture runs.
    assert.ok(source.includes("../fixtures"), `${file} must import test/expect from ../fixtures`)
  }
  const run = readFileSync(path.join(testsDir, "run.spec.ts"), "utf8")
  assert.match(run, /e2ePreviewPort/, "run.spec must derive the reserved dev-server port")
  assert.match(run, /e2eMockURL/, "run.spec must derive the mock URL")
  const preview = readFileSync(path.join(testsDir, "preview.spec.ts"), "utf8")
  assert.match(preview, /e2eDieFile/, "preview.spec must derive the per-worker die file")
})
