import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

// Static guards for the CI split. The failure classes they lock out:
// - a job added without the gate depending on it (a PR merges green while a
//   check is red or was never reported),
// - `paths:` trigger filters on a workflow whose check is required (the check
//   never reports for the skipped diff, so the PR can never merge),
// - the smoke list drifting from `e2e/tests` (a renamed spec silently stops
//   running in the smoke project, or runs twice in the full suite).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const ci = readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8")
const playwright = readFileSync(path.join(root, "e2e", "playwright.config.ts"), "utf8")

function jobNames(text) {
  const lines = text.slice(text.indexOf("\njobs:")).split("\n")
  return lines
    .filter((line) => /^  [a-z][a-z0-9-]*:$/.test(line))
    .map((line) => line.trim().slice(0, -1))
}

function jobBlock(text, name) {
  const lines = text.slice(text.indexOf("\njobs:")).split("\n")
  const start = lines.findIndex((line) => line === `  ${name}:`)
  assert.ok(start >= 0, `job "${name}" not found in ci.yml`)
  const end = lines.findIndex((line, index) => index > start && /^  [a-z][a-z0-9-]*:$/.test(line))
  return lines.slice(start, end === -1 ? lines.length : end).join("\n")
}

test("no trigger path filters: the required check must always report", () => {
  assert.ok(!/^\s+paths(-ignore)?:/m.test(ci), "ci.yml must not filter its triggers by path")
})

test("the gate depends on every job and never skips", () => {
  const names = jobNames(ci)
  assert.ok(names.includes("gate"), "ci.yml must define the gate job")
  const needs = jobBlock(ci, "gate").match(/needs: \[([^\]]*)\]/)
  assert.ok(needs, "gate must declare its needs as a flow list")
  const required = needs[1].split(",").map((name) => name.trim()).filter(Boolean)
  assert.deepEqual(
    [...required].sort(),
    names.filter((name) => name !== "gate").sort(),
    "every job must be listed in the gate's needs",
  )
  assert.match(jobBlock(ci, "gate"), /if: always\(\)/)
})

test("the required check keeps its published name", () => {
  // Branch protection requires exactly this context: renaming it blocks every
  // open PR until the repository setting is updated.
  assert.match(jobBlock(ci, "gate"), /^    name: CI gate$/m)
})

test("the full pipeline can be forced from an open PR", () => {
  assert.match(ci, /types: \[opened, synchronize, reopened, labeled\]/)
  assert.match(ci, /ci:full/)
})

test("smoke specs exist and belong to exactly one Playwright project", () => {
  const list = playwright.match(/const SMOKE_SPECS = \[([\s\S]*?)\]/)
  assert.ok(list, "playwright.config.ts must define SMOKE_SPECS")
  const specs = [...list[1].matchAll(/"([^"]+\.spec\.ts)"/g)].map((match) => match[1])
  assert.ok(specs.length >= 5, `expected a meaningful smoke list, saw ${specs.length}`)
  const files = readdirSync(path.join(root, "e2e", "tests"))
  for (const spec of specs) {
    assert.ok(files.includes(spec.replace(/^\*\*\//, "")), `${spec} does not exist under e2e/tests`)
  }
  assert.match(playwright, /name: "smoke", testMatch: SMOKE_SPECS/)
  assert.match(playwright, /name: "full", testIgnore: SMOKE_SPECS/)
})
