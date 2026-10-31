import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import {
  REQUIRED_NO_ARG_CONSTRUCTORS,
  checkApk,
  dexEntries,
  noArgConstructorStatus,
} from "./check-android-dex.mjs"

const WORK_DATABASE = "Landroidx/work/impl/WorkDatabase_Impl;"

function dump({ direct = "", virtual = "", next = "" } = {}) {
  return [
    `  Class descriptor  : '${WORK_DATABASE}'`,
    "  Access flags      : 0x0011 (PUBLIC FINAL)",
    "  Superclass        : 'Landroidx/work/impl/WorkDatabase;'",
    "  Interfaces        -",
    "  Static fields     -",
    "  Instance fields   -",
    "  Direct methods    -",
    ...direct.split("\n"),
    "  Virtual methods   -",
    ...virtual.split("\n"),
    ...(next ? [next] : []),
  ].join("\n")
}

const constructor = [
  "    #0              : (in Landroidx/work/impl/WorkDatabase_Impl;)",
  "      name          : '<init>'",
  "      type          : '()V'",
  "      access        : 0x10001 (PUBLIC CONSTRUCTOR)",
].join("\n")

test("detects the no-arg constructor kept in the direct methods", () => {
  assert.equal(noArgConstructorStatus(dump({ direct: constructor }), WORK_DATABASE), "present")
})

test("reports a stripped constructor when the class has no direct methods", () => {
  assert.equal(noArgConstructorStatus(dump(), WORK_DATABASE), "missing")
})

test("does not accept a constructor listed as a virtual method", () => {
  assert.equal(noArgConstructorStatus(dump({ virtual: constructor }), WORK_DATABASE), "missing")
})

test("does not leak a constructor from the next class", () => {
  const next = [
    "  Class descriptor  : 'Landroidx/work/impl/WorkDatabase;'",
    "  Direct methods    -",
    constructor,
  ].join("\n")
  assert.equal(noArgConstructorStatus(dump({ next }), WORK_DATABASE), "missing")
})

test("reports a class that is absent from the dex", () => {
  assert.equal(noArgConstructorStatus(dump(), "Landroidx/work/Missing;"), "absent")
})

test("lists every classes*.dex entry and ignores unrelated zip entries", () => {
  const listing = [
    "AndroidManifest.xml",
    "classes.dex",
    "classes2.dex",
    "classes10.dex",
    "lib/arm64-v8a/libreactnative.so",
    "classes.dex.bak",
  ].join("\n")
  assert.deepEqual(dexEntries(listing), ["classes.dex", "classes2.dex", "classes10.dex"])
})

test("guards the Room database and both WorkManager input mergers", () => {
  assert.deepEqual(REQUIRED_NO_ARG_CONSTRUCTORS, [
    WORK_DATABASE,
    "Landroidx/work/ArrayCreatingInputMerger;",
    "Landroidx/work/OverwritingInputMerger;",
  ])
})

function classDump(descriptor, ctor) {
  return [
    `  Class descriptor  : '${descriptor}'`,
    "  Access flags      : 0x0011 (PUBLIC FINAL)",
    "  Instance fields   -",
    "  Direct methods    -",
    ...(ctor
      ? [
          `    #0              : (in ${descriptor})`,
          "      name          : '<init>'",
          "      type          : '()V'",
          "      access        : 0x10001 (PUBLIC CONSTRUCTOR)",
        ]
      : []),
    "  Virtual methods   -",
  ].join("\n")
}

function apkFixture({ first, second }) {
  const dir = mkdtempSync(join(tmpdir(), "masterhand-dex-test-"))
  const apk = join(dir, "MasterHand-0.2.1.apk")
  writeFileSync(apk, "fake apk")
  const run = (command, args) => {
    if (command === "unzip" && args[0] === "-Z1") return "classes.dex\nclasses2.dex\n"
    if (command === "unzip" && args[0] === "-p") return Buffer.from("fake dex")
    if (command === "dexdump") {
      return String(args[0]).endsWith("classes2.dex") ? second : first
    }
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`)
  }
  return { apk, dir, run }
}

test("resolves a constructor found in a later multidex entry", () => {
  const first = [
    classDump(WORK_DATABASE, false),
    classDump("Landroidx/work/ArrayCreatingInputMerger;", true),
    classDump("Landroidx/work/OverwritingInputMerger;", true),
  ].join("\n")
  const second = classDump(WORK_DATABASE, true)
  const { apk, dir, run } = apkFixture({ first, second })
  try {
    const result = checkApk({ apk, dexdump: "dexdump", run })
    assert.equal(result.ok, true)
    assert.equal(result.checked.length, 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("fails when every multidex entry lost the constructors", () => {
  const first = REQUIRED_NO_ARG_CONSTRUCTORS.map((descriptor) => classDump(descriptor, false)).join("\n")
  const { apk, dir, run } = apkFixture({ first, second: first })
  try {
    const result = checkApk({ apk, dexdump: "dexdump", run })
    assert.equal(result.ok, false)
    assert.equal(result.errors.length, 3)
    assert.match(result.errors[0], /R8 stripped it/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
