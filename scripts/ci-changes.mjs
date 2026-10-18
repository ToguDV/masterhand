#!/usr/bin/env node
// Decides, from the files a PR or push touched, how much CI has to run
// (see WORKFLOW.md §CI). The one rule that matters: fail **open**. Any case
// this script cannot prove small — a missing/undetermined range, an unknown
// event, an empty diff, an unrecognized file — resolves to the full pipeline,
// never to a silently skipped gate.
//
// Usage (from the `changes` job):
//   node scripts/ci-changes.mjs >> "$GITHUB_OUTPUT"
// with CI_EVENT_NAME, CI_BASE_SHA/CI_HEAD_SHA (pull_request),
// CI_BEFORE_SHA/CI_AFTER_SHA (push) and CI_LABELS in the environment.
// Prints `key=value` lines: docs_only, full, smoke, workspaces, scripts.

import { execFileSync } from "node:child_process"
import { pathToFileURL } from "node:url"

const AREA_PATTERNS = {
  server: /^apps\/server\//,
  "client-core": /^packages\/client-core\//,
  web: /^apps\/web\//,
  mobile: /^apps\/mobile\//,
  desktop: /^apps\/desktop\//,
  scripts: /^scripts\//,
  e2e: /^e2e\//,
  ci: /^\.github\//,
  deps: /(^|\/)package(-lock)?\.json$/,
}

// Changing these can break anything: run the whole pipeline.
const CRITICAL_AREAS = ["server", "client-core", "e2e", "deps", "ci"]

// Areas with a `test:coverage` script, in the order unit tests should run.
const TESTABLE_AREAS = ["server", "client-core", "web", "mobile"]

const DOCS_PATTERNS = [/^docs\//, /^design\//, /\.md$/, /^LICENSE$/]

// Only the browser E2E suite backs these areas; a mobile-only or tooling-only
// diff cannot break it (mobile flows are covered by the manual Maestro run).
const SMOKE_AREAS = ["web", "desktop"]

const SHA_RE = /^[0-9a-f]{40}$/i

function isDocsFile(file) {
  return DOCS_PATTERNS.some((pattern) => pattern.test(file))
}

/**
 * Pure classification: given the changed files and the event context, decide
 * what CI must run. All values are strings so they can be written straight to
 * `$GITHUB_OUTPUT`.
 */
export function classify(files, { eventName = "", labels = [], forceAll = false } = {}) {
  const changed = files.map((file) => file.trim()).filter(Boolean)
  const docsOnly = !forceAll && changed.length > 0 && changed.every(isDocsFile)
  if (docsOnly) {
    return { docs_only: "true", full: "false", smoke: "false", workspaces: "", scripts: "false" }
  }

  const areas = new Set()
  if (forceAll || changed.length === 0) {
    // No trustworthy list (or nothing applied): assume everything changed.
    for (const area of Object.keys(AREA_PATTERNS)) areas.add(area)
  } else {
    for (const file of changed) {
      for (const [area, pattern] of Object.entries(AREA_PATTERNS)) {
        if (pattern.test(file)) areas.add(area)
      }
    }
    if (areas.size === 0) {
      // Unrecognized files (deploy, dotfiles, root configs): same assumption.
      for (const area of Object.keys(AREA_PATTERNS)) areas.add(area)
    }
  }

  const critical = CRITICAL_AREAS.some((area) => areas.has(area))
  const full = forceAll || eventName === "push" || labels.includes("ci:full") || critical
  const smoke = !full && SMOKE_AREAS.some((area) => areas.has(area))
  const workspaces = full ? TESTABLE_AREAS : TESTABLE_AREAS.filter((area) => areas.has(area))

  return {
    docs_only: "false",
    full: String(full),
    smoke: String(smoke),
    workspaces: workspaces.join(" "),
    scripts: String(areas.has("scripts")),
  }
}

function assertSha(sha, label) {
  if (!SHA_RE.test(sha ?? "")) {
    throw new Error(`missing or invalid ${label} sha`)
  }
}

/** Resolves the changed files for the event, or throws when it cannot. */
export function detectChangedFiles({ eventName, baseSha, headSha, beforeSha, afterSha }) {
  const diff = (range) =>
    execFileSync("git", ["diff", "--name-only", range], { encoding: "utf8" })
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)

  if (eventName === "push") {
    assertSha(beforeSha, "before")
    assertSha(afterSha, "after")
    return diff(`${beforeSha}..${afterSha}`)
  }
  if (eventName === "pull_request") {
    // Three-dot: only the commits the PR itself adds, excluding anything that
    // landed on the base branch after the branch point.
    assertSha(baseSha, "base")
    assertSha(headSha, "head")
    return diff(`${baseSha}...${headSha}`)
  }
  throw new Error(`event "${eventName || "(missing)"}" has no diff range`)
}

export function main() {
  const eventName = process.env.CI_EVENT_NAME ?? ""
  const labels = (process.env.CI_LABELS ?? "")
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean)

  let files = []
  let forceAll = false
  try {
    files = detectChangedFiles({
      eventName,
      baseSha: process.env.CI_BASE_SHA,
      headSha: process.env.CI_HEAD_SHA,
      beforeSha: process.env.CI_BEFORE_SHA,
      afterSha: process.env.CI_AFTER_SHA,
    })
  } catch (error) {
    forceAll = true
    console.error(`[ci-changes] cannot diff (${error.message}); running the full pipeline`)
  }

  const outputs = classify(files, { eventName, labels, forceAll })
  console.error(
    `[ci-changes] event=${eventName || "?"} files=${files.length} docs_only=${outputs.docs_only} ` +
      `full=${outputs.full} smoke=${outputs.smoke} workspaces="${outputs.workspaces}" scripts=${outputs.scripts}`,
  )
  for (const [key, value] of Object.entries(outputs)) {
    console.log(`${key}=${value}`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
