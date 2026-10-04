import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import {
  commandMatches,
  isAlive,
  readRegistry,
  registerProcess,
  registryPath,
  unregisterProcess,
} from "./process-registry.mjs"

test("registryPath is stable and keyed by the repo root", () => {
  assert.equal(registryPath("/a/b"), registryPath("/a/b"))
  assert.notEqual(registryPath("/a/b"), registryPath("/a/c"))
  assert.ok(registryPath("/a/b").includes("masterhand-dev"))
})

test("register/read/unregister round-trip refreshes the same pid", () => {
  const dir = mkdtempSync(join(tmpdir(), "mh-registry-"))
  const file = join(dir, "registry.json")
  try {
    registerProcess(file, { pid: process.pid, label: "self", command: "node" })
    assert.equal(readRegistry(file).entries.length, 1)
    assert.equal(readRegistry(file).entries[0].label, "self")

    registerProcess(file, { pid: process.pid, label: "self-2", command: "node" })
    const entries = readRegistry(file).entries
    assert.equal(entries.length, 1)
    assert.equal(entries[0].label, "self-2")

    unregisterProcess(file, process.pid)
    assert.equal(readRegistry(file).entries.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("registerProcess drops dead pids instead of keeping stale entries", () => {
  const dir = mkdtempSync(join(tmpdir(), "mh-registry-"))
  const file = join(dir, "registry.json")
  try {
    registerProcess(file, { pid: 2 ** 30, label: "dead", command: "whatever" })
    registerProcess(file, { pid: process.pid, label: "self", command: "node" })
    assert.deepEqual(
      readRegistry(file).entries.map((entry) => entry.pid),
      [process.pid],
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a missing or corrupt registry reads as empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "mh-registry-"))
  try {
    assert.deepEqual(readRegistry(join(dir, "missing.json")), { entries: [] })
    const corrupt = join(dir, "corrupt.json")
    writeFileSync(corrupt, "{not json")
    assert.deepEqual(readRegistry(corrupt), { entries: [] })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("isAlive reports the current process and rejects invalid/dead pids", () => {
  assert.equal(isAlive(process.pid), true)
  assert.equal(isAlive(2 ** 30), false)
  assert.equal(isAlive(1), false)
  assert.equal(isAlive(Number.NaN), false)
})

test("commandMatches guards against pid reuse", () => {
  assert.equal(commandMatches(process.pid, "node"), true)
  assert.equal(commandMatches(process.pid, "definitely-not-this-process"), false)
  assert.equal(commandMatches(2 ** 30, "node"), false)
})
