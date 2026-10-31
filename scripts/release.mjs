#!/usr/bin/env node
/**
 * Cuts a release locally: bump every version reference, sync the lockfile,
 * commit and create the annotated tag. It NEVER pushes: the release workflow
 * runs on `git push origin main vX.Y.Z`, and that step stays explicit.
 *
 * Usage: node scripts/release.mjs 0.2.0 [--no-git]
 *
 * Final versions only (`X.Y.Z`): prereleases would notify stable users as if
 * they were final (the semver compare strips suffixes, see release.yml).
 */
import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
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

export function androidVersionCode(version) {
  const [major, minor, patch] = version.split(".").map(Number)
  return major * 10000 + minor * 100 + patch
}

export function releaseIdentity(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`version "${version}" must be a final X.Y.Z version (no leading v, no prerelease)`)
  }
  return { version, tag: `v${version}`, versionCode: androidVersionCode(version) }
}

function bumpJson(file, mutate) {
  const path = join(repoRoot, file)
  const body = JSON.parse(readFileSync(path, "utf8"))
  mutate(body)
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`)
}

function bumpText(file, pattern, replace) {
  const path = join(repoRoot, file)
  const text = readFileSync(path, "utf8")
  const next = text.replace(pattern, replace)
  if (next === text) {
    throw new Error(`release: ${file} has no version placeholder to bump`)
  }
  writeFileSync(path, next)
}

function run(command, args) {
  // Rule 30 (docs/past-mistakes.md): never let a leaked GIT_DIR/WORK_TREE
  // redirect a release commit/tag into another repository.
  const { GIT_DIR: _dir, GIT_WORK_TREE: _work, GIT_INDEX_FILE: _index, ...cleanEnv } = process.env
  execFileSync(command, args, { cwd: repoRoot, stdio: "inherit", env: cleanEnv })
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url
if (isMain) {
  const [rawVersion, ...flags] = process.argv.slice(2)
  let identity
  try {
    identity = releaseIdentity(rawVersion ?? "")
  } catch (error) {
    console.error(`release: ${error instanceof Error ? error.message : error}`)
    process.exit(2)
  }

  for (const file of PACKAGE_FILES) {
    bumpJson(file, (body) => {
      body.version = identity.version
    })
  }
  bumpJson("apps/mobile/app.json", (body) => {
    body.expo.version = identity.version
    body.expo.android.versionCode = identity.versionCode
  })
  // `deploy/docker-compose.yml` and the server image default keep the app
  // version in sync with the packages; a stale default makes a source build
  // report the previous version and offer a permanent update.
  bumpText(
    "deploy/docker-compose.yml",
    /(MASTERHAND_VERSION: \$\{MASTERHAND_VERSION:-)[^}]+(\})/g,
    (_match, prefix, suffix) => `${prefix}${identity.version}${suffix}`,
  )
  bumpText(
    "deploy/server.Dockerfile",
    /(^ARG MASTERHAND_VERSION=).+$/gm,
    (_match, prefix) => `${prefix}${identity.version}`,
  )

  // Keep workspace versions in the lockfile in sync without reinstalling.
  run("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"])
  console.log(`release: bumped to ${identity.version} (versionCode ${identity.versionCode})`)

  if (flags.includes("--no-git")) {
    console.log("release: files updated; --no-git skipped the commit and tag")
  } else {
    run("git", [
      "add",
      ...PACKAGE_FILES,
      "apps/mobile/app.json",
      "deploy/docker-compose.yml",
      "deploy/server.Dockerfile",
      "package-lock.json",
    ])
    run("git", ["commit", "-m", `chore(release): ${identity.version}`])
    run("git", ["tag", "-a", identity.tag, "-m", identity.version])
    console.log(`release: committed and tagged ${identity.tag}`)
    console.log(`release: next: git push origin main ${identity.tag}`)
  }
}
