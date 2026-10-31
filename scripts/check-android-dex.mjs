#!/usr/bin/env node
/**
 * Regression guard for the Android release APK: R8 full mode (SDK 58 / AGP 9)
 * strips the no-arg constructors of classes that are only instantiated by
 * reflection, and the app crashes before React Native starts.
 *
 * The published v0.2.0 APK lost `androidx.work.impl.WorkDatabase_Impl.<init>`:
 * `androidx.startup.InitializationProvider` runs `WorkManagerInitializer` at
 * process start, Room instantiates the generated database by reflection, and
 * the missing constructor aborted launch. WorkManager also reflects on
 * `InputMerger` constructors. The Expo config plugin keeps all three; this
 * script fails the release when the built dex does not.
 *
 * Usage: node scripts/check-android-dex.mjs <apk> [dexdump]
 * `dexdump` defaults to $DEXDUMP, then the newest build-tools binary under
 * $ANDROID_HOME/$ANDROID_SDK_ROOT, then `dexdump` on PATH.
 */
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

/** Classes whose no-arg constructor is required at runtime (reflection). */
export const REQUIRED_NO_ARG_CONSTRUCTORS = [
  "Landroidx/work/impl/WorkDatabase_Impl;",
  "Landroidx/work/ArrayCreatingInputMerger;",
  "Landroidx/work/OverwritingInputMerger;",
]

const CLASS_DESCRIPTOR = /^  Class descriptor  : '(.+)'$/
const SECTION_WITH_MEMBERS = /^  (Virtual methods|Static fields|Instance fields|Interfaces)/

/**
 * Whether a dexdump text contains `descriptor` with a public no-arg
 * constructor (`<init>()V`) in its direct methods.
 *
 * Returns "present", "missing" (class found, constructor gone) or
 * "absent" (class not in this dex).
 */
export function noArgConstructorStatus(dexdump, descriptor) {
  const lines = String(dexdump).split(/\r?\n/)
  const start = lines.findIndex((line) => line === `  Class descriptor  : '${descriptor}'`)
  if (start < 0) return "absent"
  const next = lines.findIndex((line, index) => index > start && CLASS_DESCRIPTOR.test(line))
  const block = lines.slice(start, next < 0 ? undefined : next)

  let inDirect = false
  for (let index = 0; index < block.length; index += 1) {
    const line = block[index]
    if (/^  Direct methods/.test(line)) {
      inDirect = true
      continue
    }
    if (SECTION_WITH_MEMBERS.test(line)) {
      inDirect = false
      continue
    }
    if (inDirect && /name\s+: '<init>'/.test(line)) {
      const type = block[index + 1] ?? ""
      if (/type\s+: '\(\)V'/.test(type)) return "present"
    }
  }
  return "missing"
}

/** Latest `build-tools/<version>/dexdump` under an Android SDK root. */
export function findDexdump(env = process.env, pathExists = existsSync) {
  if (env.DEXDUMP) return env.DEXDUMP
  const root = env.ANDROID_HOME ?? env.ANDROID_SDK_ROOT
  if (root) {
    const buildTools = join(root, "build-tools")
    if (pathExists(buildTools)) {
      const versions = readdirSync(buildTools)
        .filter((name) => /^\d+\.\d+\.\d+$/.test(name))
        .sort((a, b) => {
          const left = a.split(".").map(Number)
          const right = b.split(".").map(Number)
          for (let index = 0; index < 3; index += 1) {
            if (left[index] !== right[index]) return left[index] - right[index]
          }
          return 0
        })
      for (const version of versions.reverse()) {
        const candidate = join(buildTools, version, "dexdump")
        if (pathExists(candidate)) return candidate
      }
    }
  }
  return "dexdump"
}

/** Dex entry names inside the APK (`classes.dex`, `classes2.dex`, ...). */
export function dexEntries(zipListing) {
  return String(zipListing)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^classes\d*\.dex$/.test(line))
}

/**
 * Check an APK. Returns `{ ok, checked, errors }`; the CLI exits non-zero when
 * a class is missing or lost its constructor.
 */
export function checkApk({ apk, dexdump = findDexdump(), run = execFileSync }) {
  if (!existsSync(apk)) {
    return { ok: false, checked: [], errors: [`APK not found: ${apk}`] }
  }
  const listing = String(run("unzip", ["-Z1", apk], { encoding: "utf8" }))
  const entries = dexEntries(listing)
  if (entries.length === 0) {
    return { ok: false, checked: [], errors: ["APK contains no classes*.dex"] }
  }

  const work = mkdtempSync(join(tmpdir(), "masterhand-dex-"))
  const checked = []
  const errors = []
  try {
    for (const entry of entries) {
      const dex = join(work, entry)
      writeFileSync(
        dex,
        run("unzip", ["-p", apk, entry], {
          encoding: "buffer",
          maxBuffer: 256 * 1024 * 1024,
        }),
      )
      const dump = String(run(dexdump, ["-d", dex], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }))
      for (const descriptor of REQUIRED_NO_ARG_CONSTRUCTORS) {
        if (checked.includes(descriptor)) continue
        const status = noArgConstructorStatus(dump, descriptor)
        if (status === "present") {
          checked.push(descriptor)
        } else if (status === "missing") {
          errors.push(`${descriptor}: class present but <init>()V is missing (R8 stripped it)`)
        }
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }

  for (const descriptor of REQUIRED_NO_ARG_CONSTRUCTORS) {
    if (!checked.includes(descriptor) && !errors.some((error) => error.startsWith(descriptor))) {
      errors.push(`${descriptor}: class not found in the APK`)
    }
  }
  return { ok: errors.length === 0, checked, errors }
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url
if (isMain) {
  const apk = process.argv[2]
  if (!apk) {
    console.error("usage: node scripts/check-android-dex.mjs <apk> [dexdump]")
    process.exit(2)
  }
  const result = checkApk({
    apk,
    ...(process.argv[3] ? { dexdump: process.argv[3] } : {}),
  })
  if (!result.ok) {
    for (const error of result.errors) console.error(`android-release: ${error}`)
    console.error(
      "android-release: the minified APK would crash at startup; keep the constructors in apps/mobile/app.json (expo-build-properties extraProguardRules)",
    )
    process.exit(1)
  }
  console.log(`android-release: kept ${result.checked.length} reflective constructors in ${apk}`)
}
