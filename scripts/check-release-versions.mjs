#!/usr/bin/env node
/**
 * Release preflight: every version reference must match the tag.
 *
 * The tag is the single source of truth (`vX.Y.Z`). `apps/mobile/app.json` is
 * enforced by the Android job and `apps/desktop/package.json` by
 * electron-builder, but a stale root/workspace version silently ships a wrong
 * About box; this guard fails the release before any image or installer is
 * built. `android.versionCode` is derived as major*10000+minor*100+patch and
 * must never decrease (F-Droid/Android refuse downgrades).
 *
 * Usage: node scripts/check-release-versions.mjs v0.1.0
 */
import { appendFileSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..")

const PACKAGE_FILES = [
  "package.json",
  "apps/server/package.json",
  "apps/web/package.json",
  "apps/desktop/package.json",
  "apps/mobile/package.json",
  "packages/client-core/package.json",
  "e2e/package.json",
]

/**
 * Non-JSON files that also carry the release identity. A stale default makes
 * a source-built image report the old version (and a permanent update notice).
 */
const TEXT_VERSION_FILES = [
  {
    file: "deploy/docker-compose.yml",
    pattern: /MASTERHAND_VERSION: \$\{MASTERHAND_VERSION:-([^}]+)\}/g,
  },
  {
    file: "deploy/server.Dockerfile",
    pattern: /^ARG MASTERHAND_VERSION=(\S+)$/gm,
  },
]

export function androidVersionCode(version) {
  const [major, minor, patch] = version.split(".").map(Number)
  return major * 10000 + minor * 100 + patch
}

/**
 * Pure checker. `readFile` is injectable so the test can use fixtures without
 * touching the real workspace.
 */
export function checkReleaseVersions({ tag, readFile = (path) => readFileSync(join(repoRoot, path), "utf8") }) {
  const errors = []
  const match = /^v(\d+\.\d+\.\d+)$/.exec(String(tag ?? "").trim())
  if (!match) {
    return {
      ok: false,
      errors: [`tag "${tag}" must be a final vX.Y.Z tag (prereleases are not supported)`],
    }
  }
  const version = match[1]
  const versionCode = androidVersionCode(version)

  for (const file of PACKAGE_FILES) {
    try {
      const body = JSON.parse(readFile(file))
      if (body.version !== version) {
        errors.push(`${file} version is ${body.version ?? "(missing)"}, expected ${version}`)
      }
    } catch (error) {
      errors.push(`${file} could not be read: ${error instanceof Error ? error.message : error}`)
    }
  }

  try {
    const app = JSON.parse(readFile("apps/mobile/app.json"))
    const appVersion = app?.expo?.version
    const code = app?.expo?.android?.versionCode
    if (appVersion !== version) {
      errors.push(`apps/mobile/app.json expo.version is ${appVersion ?? "(missing)"}, expected ${version}`)
    }
    if (code !== versionCode) {
      errors.push(
        `apps/mobile/app.json android.versionCode is ${code ?? "(missing)"}, expected ${versionCode} (major*10000+minor*100+patch)`,
      )
    }
  } catch (error) {
    errors.push(`apps/mobile/app.json could not be read: ${error instanceof Error ? error.message : error}`)
  }

  for (const { file, pattern } of TEXT_VERSION_FILES) {
    try {
      const values = [...readFile(file).matchAll(pattern)].map((match) => match[1])
      if (values.length === 0) {
        errors.push(`${file} has no MASTERHAND_VERSION entry`)
        continue
      }
      for (const value of new Set(values)) {
        if (value !== version) {
          errors.push(`${file} MASTERHAND_VERSION is ${value}, expected ${version}`)
        }
      }
    } catch (error) {
      errors.push(`${file} could not be read: ${error instanceof Error ? error.message : error}`)
    }
  }

  return errors.length === 0
    ? { ok: true, version, tag: `v${version}`, versionCode }
    : { ok: false, errors }
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url
if (isMain) {
  const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? ""
  const result = checkReleaseVersions({ tag })
  if (!result.ok) {
    for (const error of result.errors) console.error(`release: ${error}`)
    console.error("release: bump the versions with `node scripts/release.mjs <version>` before tagging")
    process.exit(1)
  }
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `version=${result.version}\nversion-code=${result.versionCode}\ntag=${result.tag}\n`,
    )
  }
  console.log(`release: ${result.tag} is consistent (versionCode ${result.versionCode})`)
}
