import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const compose = readFileSync(join(repoRoot, "deploy", "docker-compose.yml"), "utf8")

// #218: project-level opencode plugins/config execute as the engine user
// (verified with a marker plugin against the pinned 2.0.6 image: it ran on
// session creation; with the flag it never loads). The flag is the only
// supported disable (opencode 2.0.6 `ServerOptions.config.project`, fed by
// `OPENCODE_CONFIG_PROJECT_DISABLE`/`OPENCODE_DISABLE_PROJECT_CONFIG`), so
// pin it here; the runtime probe is recorded in the PR, not in this file.
test("the opencode service disables project-level config/plugin discovery (#218)", () => {
  assert.match(compose, /OPENCODE_CONFIG_PROJECT_DISABLE:\s*["']?true["']?/)
})

test("the shell dropper stays configured alongside the project disable (#218)", () => {
  // `OPENCODE_CONFIG_CONTENT` is explicit config: it still applies with
  // project discovery off, so agent shells keep dropping to `agent`.
  assert.match(compose, /OPENCODE_CONFIG_CONTENT:.*agent-exec/)
})
