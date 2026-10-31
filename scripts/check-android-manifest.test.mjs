import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { checkApk, findAapt2, readCleartextState } from "./check-android-manifest.mjs"

const NS = "http://schemas.android.com/apk/res/android"
const attr = (value) => `        A: ${NS}:usesCleartextTraffic(0x010104ec)=${value}`

function xmltree(...lines) {
  return [
    "N: android=http://schemas.android.com/apk/res/android (line=2)",
    "  E: manifest (line=2)",
    "    A: http://schemas.android.com/apk/res/android:versionCode(0x0101021b)=200",
    ...lines,
    "      E: uses-sdk (line=7)",
    "        A: http://schemas.android.com/apk/res/android:minSdkVersion(0x0101020c)=24",
  ].join("\n")
}

test("reads a build-tools 37 boolean attribute", () => {
  assert.equal(readCleartextState(xmltree(attr("true"))), "true")
  assert.equal(readCleartextState(xmltree(attr("false"))), "false")
})

test("reads the older typed aapt/aapt2 boolean forms", () => {
  assert.equal(readCleartextState(xmltree(attr("(type 0x12)0xffffffff"))), "true")
  assert.equal(readCleartextState(xmltree(attr("(type 0x12)0x0"))), "false")
  assert.equal(readCleartextState(xmltree(attr("(type 0x12)0x00000000"))), "false")
})

test("reports the attribute as absent when the manifest does not carry it", () => {
  assert.equal(readCleartextState(xmltree()), "absent")
  assert.equal(readCleartextState(""), "absent")
})

test("fails closed on an unrecognized value", () => {
  assert.equal(readCleartextState(xmltree(attr("maybe"))), "unknown")
  assert.equal(readCleartextState(xmltree(attr("(type 0x12)0x1"))), "unknown")
  assert.equal(readCleartextState(xmltree(attr(""))), "unknown")
})

test("accepts only the boolean resource type in the typed form", () => {
  assert.equal(readCleartextState(xmltree(attr("(type 0x10)0xffffffff"))), "unknown")
})

test("matches only the fully-qualified attribute in the Android namespace", () => {
  // A similar attribute must never satisfy the gate.
  assert.equal(
    readCleartextState(xmltree(`        A: ${NS}:usesCleartextTrafficFoo(0x010104ec)=true`)),
    "absent",
  )
  assert.equal(
    readCleartextState(xmltree(`        A: ${NS}:allowBackup(0x01010280)=true`)),
    "absent",
  )
  // A foreign namespace is a different attribute, even with the same name.
  assert.equal(
    readCleartextState(xmltree(`        A: http://example.com/ns:usesCleartextTraffic(0x1)=true`)),
    "absent",
  )
  // The real, fully-qualified attribute is found even after other attributes.
  assert.equal(readCleartextState(xmltree(attr("(type 0x12)0xffffffff"))), "true")
})

test("finds the newest build-tools aapt2 under the Android SDK", () => {
  const root = mkdtempSync(join(tmpdir(), "masterhand-manifest-test-"))
  try {
    for (const version of ["36.0.0", "37.0.0", "35.0.1"]) {
      mkdirSync(join(root, "build-tools", version), { recursive: true })
      writeFileSync(join(root, "build-tools", version, "aapt2"), "")
    }
    mkdirSync(join(root, "build-tools", "38.0.0"), { recursive: true })
    assert.equal(
      findAapt2({ ANDROID_HOME: root }),
      join(root, "build-tools", "37.0.0", "aapt2"),
      "the newest build-tools that actually ships aapt2 wins",
    )
    assert.equal(
      findAapt2({ ANDROID_SDK_ROOT: root }),
      join(root, "build-tools", "37.0.0", "aapt2"),
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("prefers $AAPT2 and falls back to aapt2 on PATH", () => {
  assert.equal(findAapt2({ AAPT2: "/opt/aapt2" }, () => false), "/opt/aapt2")
  assert.equal(findAapt2({ AAPT2: "/opt/aapt2", ANDROID_HOME: "/sdk" }, () => false), "/opt/aapt2")
  assert.equal(findAapt2({}, () => false), "aapt2")
  assert.equal(findAapt2({ ANDROID_HOME: "/sdk" }, () => false), "aapt2")
})

function apkFixture() {
  const dir = mkdtempSync(join(tmpdir(), "masterhand-manifest-apk-"))
  const apk = join(dir, "MasterHand-0.2.1.apk")
  writeFileSync(apk, "fake apk")
  return { apk, dir }
}

test("passes only when the binary manifest allows cleartext traffic", () => {
  const { apk, dir } = apkFixture()
  try {
    const calls = []
    const run = (command, args) => {
      calls.push([command, args])
      return xmltree(attr("true"))
    }
    const result = checkApk({ apk, aapt2: "aapt2", run })
    assert.equal(result.ok, true)
    assert.equal(result.state, "true")
    assert.deepEqual(result.errors, [])
    assert.equal(result.line, attr("true").trim())
    assert.deepEqual(calls, [
      ["aapt2", ["dump", "xmltree", "--file", "AndroidManifest.xml", apk]],
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("fails with an actionable error when the flag is absent", () => {
  const { apk, dir } = apkFixture()
  try {
    const result = checkApk({ apk, aapt2: "aapt2", run: () => xmltree() })
    assert.equal(result.ok, false)
    assert.equal(result.state, "absent")
    assert.equal(result.line, null)
    assert.match(result.errors.join("\n"), /absent/)
    assert.match(result.errors.join("\n"), /app\.json/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("fails when the flag is false or unreadable", () => {
  const { apk, dir } = apkFixture()
  try {
    const disabled = checkApk({ apk, aapt2: "aapt2", run: () => xmltree(attr("false")) })
    assert.equal(disabled.ok, false)
    assert.equal(disabled.state, "false")
    assert.match(disabled.errors.join("\n"), /usesCleartextTraffic=false/)

    const garbage = checkApk({ apk, aapt2: "aapt2", run: () => xmltree(attr("maybe")) })
    assert.equal(garbage.ok, false)
    assert.equal(garbage.state, "unknown")
    assert.match(garbage.errors.join("\n"), /unrecognized/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("reports a missing APK and an aapt2 failure as errors, never as a pass", () => {
  const missing = checkApk({ apk: "/nonexistent/MasterHand.apk", aapt2: "aapt2", run: () => "" })
  assert.equal(missing.ok, false)
  assert.match(missing.errors.join("\n"), /APK not found/)

  const { apk, dir } = apkFixture()
  try {
    const failed = checkApk({
      apk,
      aapt2: "aapt2",
      run: () => {
        throw new Error("aapt2: command not found")
      },
    })
    assert.equal(failed.ok, false)
    assert.equal(failed.state, "unknown")
    assert.match(failed.errors.join("\n"), /aapt2.*command not found/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
