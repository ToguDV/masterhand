import assert from "node:assert/strict"
import { test } from "node:test"
import {
  REQUIRED_NO_ARG_CONSTRUCTORS,
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
