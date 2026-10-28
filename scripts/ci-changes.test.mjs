import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import { classify } from "./ci-changes.mjs"

// The classifier decides how much CI runs for a diff. Its one hard rule:
// fail **open**. Whenever it cannot prove the diff is small — missing or
// invalid SHAs, an unknown event, an empty diff, an unrecognized file — the
// answer must be the full pipeline, never a silently skipped gate.

const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "ci-changes.mjs")

function pullRequest(files, options = {}) {
  return classify(files, { eventName: "pull_request", labels: [], ...options })
}

test("docs-only diffs run nothing heavy", () => {
  const out = pullRequest(["README.md", "docs/bff/api.md", "design/DESIGN.html", "LICENSE"])
  assert.deepEqual(out, {
    docs_only: "true",
    full: "false",
    smoke: "false",
    workspaces: "",
    scripts: "false",
    builds: "",
  })
})

test("client diffs run typecheck, their unit tests and the E2E smoke project", () => {
  const out = pullRequest(["apps/web/src/App.tsx", "apps/mobile/src/App.tsx"])
  assert.deepEqual(out, {
    docs_only: "false",
    full: "false",
    smoke: "true",
    workspaces: "web mobile",
    scripts: "false",
    builds: "web",
  })
})

test("core diffs escalate to the full pipeline", () => {
  assert.equal(pullRequest(["apps/server/src/index.ts"]).full, "true")
  assert.equal(pullRequest(["packages/client-core/src/api.ts"]).full, "true")
  assert.equal(
    pullRequest(["apps/server/src/index.ts"]).workspaces,
    "server client-core web mobile",
  )
})

test("dependency, harness and CI diffs escalate to the full pipeline", () => {
  for (const file of ["package-lock.json", "e2e/tests/chat.spec.ts", ".github/workflows/ci.yml", "apps/web/package.json"]) {
    assert.equal(pullRequest([file]).full, "true", `${file} must run the full pipeline`)
  }
})

test("pushes to main always run the full pipeline", () => {
  const out = pullRequest(["apps/web/src/App.tsx"], { eventName: "push" })
  assert.equal(out.full, "true")
  assert.equal(out.smoke, "false")
})

test("the ci:full label escalates an open PR", () => {
  const out = pullRequest(["apps/web/src/App.tsx"], { labels: ["ci:full"] })
  assert.equal(out.full, "true")
  assert.equal(out.smoke, "false")
})

test("unrecognized files fail safe", () => {
  const out = pullRequest(["deploy/docker-compose.yml", ".nvmrc"])
  assert.equal(out.docs_only, "false")
  assert.equal(out.full, "true")
  assert.equal(out.workspaces, "server client-core web mobile")
  assert.equal(out.builds, "server web desktop")
})

test("tooling-only and mobile-only diffs skip E2E", () => {
  const tooling = pullRequest(["scripts/dev-docker.mjs"])
  assert.equal(tooling.smoke, "false")
  assert.equal(tooling.scripts, "true")
  assert.equal(tooling.workspaces, "")

  const mobile = pullRequest(["apps/mobile/src/App.tsx"])
  assert.equal(mobile.smoke, "false")
  assert.equal(mobile.full, "false")
  assert.equal(mobile.workspaces, "mobile")
})

test("detection failures force the full pipeline", () => {
  for (const out of [classify([], { forceAll: true }), classify([], { eventName: "workflow_dispatch" })]) {
    assert.equal(out.docs_only, "false")
    assert.equal(out.full, "true")
    assert.equal(out.builds, "server web desktop")
  }
})

test("builds follow the changed areas, not the E2E verdict", () => {
  // client-core ships inside every bundle; dependency changes can break any build.
  for (const file of ["packages/client-core/src/api.ts", "package-lock.json", "apps/web/package.json"]) {
    assert.equal(pullRequest([file]).builds, "server web desktop", `${file} builds`)
  }
  assert.equal(pullRequest(["apps/web/src/App.tsx"]).builds, "web")
  assert.equal(pullRequest(["apps/server/src/index.ts"]).builds, "server")
  assert.equal(pullRequest(["apps/desktop/src/main.ts"]).builds, "desktop")
  // No production build exists for these areas (the E2E harness builds the
  // web app itself), so the build job is skipped.
  for (const file of ["apps/mobile/src/App.tsx", "scripts/dev-docker.mjs", "e2e/tests/chat.spec.ts", ".github/workflows/ci.yml"]) {
    assert.equal(pullRequest([file]).builds, "", `${file} needs no build`)
  }
})

// --- git-range integration: real repos, real ranges ---

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
}

function tempRepo() {
  const cwd = mkdtempSync(path.join(tmpdir(), "ci-changes-"))
  git(cwd, "init", "-q", "-b", "main")
  git(cwd, "config", "user.email", "ci-changes@test.invalid")
  git(cwd, "config", "user.name", "ci-changes")
  git(cwd, "config", "commit.gpgsign", "false")
  return cwd
}

function commit(cwd, file, message) {
  const full = path.join(cwd, file)
  mkdirSync(path.dirname(full), { recursive: true })
  writeFileSync(full, `${message}\n`)
  git(cwd, "add", "-A")
  git(cwd, "commit", "-qm", message)
  return git(cwd, "rev-parse", "HEAD")
}

function runScript(cwd, env) {
  return execFileSync(process.execPath, [scriptPath], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      CI_EVENT_NAME: "",
      CI_BASE_SHA: "",
      CI_HEAD_SHA: "",
      CI_BEFORE_SHA: "",
      CI_AFTER_SHA: "",
      CI_LABELS: "",
      ...env,
    },
  })
}

function parseOutput(stdout) {
  const out = {}
  for (const line of stdout.trim().split("\n")) {
    const index = line.indexOf("=")
    assert.ok(index > 0, `expected key=value output lines, saw: ${JSON.stringify(line)}`)
    out[line.slice(0, index)] = line.slice(index + 1)
  }
  return out
}

test("push ranges classify exactly the pushed commits", () => {
  const repo = tempRepo()
  try {
    const base = commit(repo, "README.md", "base")
    const head = commit(repo, "apps/web/src/App.tsx", "web change")
    const out = parseOutput(runScript(repo, { CI_EVENT_NAME: "push", CI_BEFORE_SHA: base, CI_AFTER_SHA: head }))
    assert.equal(out.docs_only, "false")
    assert.equal(out.full, "true")
    assert.equal(out.workspaces, "server client-core web mobile")
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test("pull-request ranges exclude base-only commits", () => {
  const repo = tempRepo()
  try {
    const forkPoint = commit(repo, "README.md", "base")
    git(repo, "checkout", "-q", "-b", "feature")
    const head = commit(repo, "apps/web/src/Feature.tsx", "the PR's own change")
    git(repo, "checkout", "-q", "main")
    const base = commit(repo, "apps/server/src/unrelated.ts", "main moved on")
    const out = parseOutput(
      runScript(repo, { CI_EVENT_NAME: "pull_request", CI_BASE_SHA: base, CI_HEAD_SHA: head }),
    )
    assert.notEqual(base, forkPoint)
    assert.equal(out.docs_only, "false")
    assert.equal(out.full, "false")
    assert.equal(out.smoke, "true")
    assert.equal(out.workspaces, "web")
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test("an undiffable range falls back to the full pipeline", () => {
  const repo = tempRepo()
  try {
    commit(repo, "README.md", "base")
    const missing = "a".repeat(40)
    const out = parseOutput(
      runScript(repo, { CI_EVENT_NAME: "pull_request", CI_BASE_SHA: missing, CI_HEAD_SHA: missing }),
    )
    assert.equal(out.docs_only, "false")
    assert.equal(out.full, "true")
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})
