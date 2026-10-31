#!/usr/bin/env node
/**
 * Release gate for plain-HTTP LAN support: `expo-build-properties` sets
 * `android.usesCleartextTraffic: true`, and Android merges it into
 * `android:usesCleartextTraffic` on `<application>`. Without that flag a
 * release build blocks every `http://` request, so a self-hosted MasterHand
 * reached over a private LAN (ADR-47) becomes unreachable — the same silent
 * regression class as the v0.2.0 R8 crash, which a release gate now catches.
 *
 * A plugin/SDK bump could drop the merge again, so inspect the binary
 * manifest inside the built APK and fail the release when the flag is not
 * exactly `true`. Any unreadable value fails closed: this gate never passes on
 * a manifest it cannot prove.
 *
 * Usage: node scripts/check-android-manifest.mjs <apk> [aapt2]
 * `aapt2` defaults to $AAPT2, then the newest build-tools binary under
 * $ANDROID_HOME/$ANDROID_SDK_ROOT, then `aapt2` on PATH.
 */
import { execFileSync } from "node:child_process"
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const MANIFEST = "AndroidManifest.xml"

/**
 * An `aapt2 dump xmltree` attribute line for `android:usesCleartextTraffic`.
 * Only the literal Android namespace prefix
 * (`http://schemas.android.com/apk/res/android:`) is accepted, so an attribute
 * declared in a foreign namespace is ignored. The resource-id suffix is
 * optional so both `name(0x010104ec)=value` and a bare `name=value` are
 * accepted; requiring the `(`/`=` boundary keeps a similar name
 * (`usesCleartextTrafficFoo`) out.
 */
const ATTRIBUTE_LINE =
  /^\s*A:\s+http:\/\/schemas\.android\.com\/apk\/res\/android:usesCleartextTraffic(?:\([^)]*\))?=(.*)$/

function cleartextLine(xmltree) {
  return String(xmltree)
    .split(/\r?\n/)
    .find((candidate) => ATTRIBUTE_LINE.test(candidate)) ?? null
}

/**
 * Cleartext state read from an `aapt2 dump xmltree` text.
 *
 * Returns "true", "false", "absent" (no Android-namespace attribute line) or
 * "unknown" (unrecognized value — callers must treat it as a failure).
 *
 * Accepted values are exactly the literal booleans newer build-tools print
 * (`=true`, `=false`) and the boolean-typed form older `aapt`/`aapt2` print:
 * `(type 0x12)0xffffffff` → true, and an all-zero payload (`0x0`,
 * `0x00000000`) → false. Any other type id (not the boolean `0x12`), type or
 * payload is "unknown" and fails closed.
 */
export function readCleartextState(xmltree) {
  const line = cleartextLine(xmltree)
  if (line === null) return "absent"

  const value = (ATTRIBUTE_LINE.exec(line)?.[1] ?? "").trim()
  if (value === "true") return "true"
  if (value === "false") return "false"

  const typed = /^\(type\s+0x12\)(0x[0-9a-f]+)$/i.exec(value)
  if (!typed) return "unknown"
  const payload = typed[1].toLowerCase()
  if (payload === "0xffffffff") return "true"
  if (/^0x0+$/.test(payload)) return "false"
  return "unknown"
}

/** Latest `build-tools/<version>/aapt2` under an Android SDK root. */
export function findAapt2(env = process.env, pathExists = existsSync) {
  if (env.AAPT2) return env.AAPT2
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
        const candidate = join(buildTools, version, "aapt2")
        if (pathExists(candidate)) return candidate
      }
    }
  }
  return "aapt2"
}

/**
 * Check an APK. Returns `{ ok, state, line, errors }`; `ok` is true only when
 * the binary manifest carries `usesCleartextTraffic=true`.
 */
export function checkApk({ apk, aapt2 = findAapt2(), run = execFileSync }) {
  if (!existsSync(apk)) {
    return { ok: false, state: "unknown", line: null, errors: [`APK not found: ${apk}`] }
  }

  let dump
  try {
    dump = String(
      run(aapt2, ["dump", "xmltree", "--file", MANIFEST, apk], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      }),
    )
  } catch (error) {
    return {
      ok: false,
      state: "unknown",
      line: null,
      errors: [`aapt2 failed: ${error instanceof Error ? error.message : error}`],
    }
  }

  const raw = cleartextLine(dump)
  const state = readCleartextState(dump)
  const line = raw === null ? null : raw.trim()
  const errors = []
  if (state !== "true") {
    if (state === "absent") {
      errors.push(`usesCleartextTraffic is absent from ${MANIFEST}: release builds block plain HTTP`)
    } else if (state === "false") {
      errors.push(`usesCleartextTraffic=false in ${MANIFEST}: release builds block plain HTTP`)
    } else {
      errors.push(`unrecognized usesCleartextTraffic value${line ? `: ${line}` : ""}`)
    }
    errors.push(
      "keep android.usesCleartextTraffic: true in apps/mobile/app.json (expo-build-properties)",
    )
  }

  return { ok: state === "true", state, line, errors }
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url
if (isMain) {
  const apk = process.argv[2]
  if (!apk) {
    console.error("usage: node scripts/check-android-manifest.mjs <apk> [aapt2]")
    process.exit(2)
  }
  let result
  try {
    result = checkApk({ apk, ...(process.argv[3] ? { aapt2: process.argv[3] } : {}) })
  } catch (error) {
    console.error(
      `android-release: manifest check failed: ${error instanceof Error ? error.message : error}`,
    )
    process.exit(1)
  }
  if (!result.ok) {
    if (result.line) console.error(`android-release: ${result.line}`)
    for (const error of result.errors) console.error(`android-release: ${error}`)
    process.exit(1)
  }
  console.log(`android-release: usesCleartextTraffic=true in ${apk}`)
}
