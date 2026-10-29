import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

// Static guards for the release workflow (see WORKFLOW.md §CI for the
// rationale behind static guards: the tag/APK/F-Droid flow never runs
// locally, so its wiring is pinned by tests, not by green runs).
//
// Failure classes locked out:
// - a tag that CI cannot map to a versionCode (stale installs forever),
// - debug-signed release APKs (stock `expo prebuild` signs `release` with
//   the debug key; `key.properties` is read by nothing),
// - a retry of `publish` dying on an existing release,
// - over-broad workflow permissions.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const release = readFileSync(join(repoRoot, ".github", "workflows", "release.yml"), "utf8")

test("releases trigger on tags only, never on branches", () => {
  assert.match(release, /push:\s*\n\s*tags:\s*\n\s*- "v\*"/)
  assert.doesNotMatch(release, /branches:/)
})

test("each job carries least-privilege permissions", () => {
  assert.match(release, /permissions:\s*\n\s*contents: read/)
  for (const job of ["image", "android", "publish"]) {
    const start = release.indexOf(`\n  ${job}:`)
    assert.ok(start >= 0, `job "${job}" not found`)
    const next = release.indexOf("\n  publish:", start + 1)
    const block = release.slice(start, job === "publish" ? release.length : next)
    assert.match(block, /permissions:/, `${job} must declare its own permissions`)
  }
  const imageBlock = release.slice(release.indexOf("\n  image:"), release.indexOf("\n  android:"))
  assert.match(imageBlock, /packages: write/, "only image pushes to GHCR")
  assert.doesNotMatch(
    release.slice(release.indexOf("\n  android:"), release.indexOf("\n  publish:")),
    /packages: write/,
    "android must not push packages",
  )
})

test("the tag pins both the version string and the versionCode", () => {
  assert.match(release, /APP_VERSION.*!=.*exit 1/s)
  assert.match(release, /major\*10000\+minor\*100\+patch/)
  assert.match(release, /versionCode.*EXPECTED_CODE|EXPECTED_CODE.*versionCode/s)
})

test("release signing is wired from secrets, not key.properties", () => {
  assert.match(release, /signingConfigs\.release/)
  assert.match(release, /System\.getenv\("ANDROID_KEYSTORE_PASSWORD"\)/)
  assert.match(release, /APKSIGNER.*" verify --print-certs/s)
  assert.match(release, /keytool -list.*release\.keystore/s)
  // The stock convention file must never be created: nothing reads it, so a
  // `cat > key.properties` step would only leave secrets on disk.
  assert.doesNotMatch(release, /cat > key\.properties/)
  assert.doesNotMatch(release, /storeFile file\('key\.properties'\)/)
})

test("creating the GitHub release is retry-safe", () => {
  assert.match(release, /gh release view "\$TAG"/)
  assert.match(release, /gh release upload "\$TAG" --clobber/)
})

test("a preflight gates the release on the tag matching every version", () => {
  assert.match(release, /\n  preflight:/)
  assert.match(release, /node scripts\/check-release-versions\.mjs "\$GITHUB_REF_NAME"/)
  const image = release.slice(release.indexOf("\n  image:"), release.indexOf("\n  android:"))
  assert.match(image, /needs: preflight/)
  const desktop = release.slice(release.indexOf("\n  desktop:"), release.indexOf("\n  publish:"))
  assert.match(desktop, /needs: preflight/)
})

test("the desktop job packages Linux, Windows and macOS with electron-builder", () => {
  const desktop = release.slice(release.indexOf("\n  desktop:"), release.indexOf("\n  publish:"))
  for (const target of ["linux", "win", "mac"]) {
    assert.match(desktop, new RegExp(`target: ${target}`), `missing desktop target ${target}`)
  }
  assert.match(desktop, /electron-builder --\$\{\{ matrix\.target \}\} --publish never/)
  assert.match(desktop, /latest\*\.yml/)
  assert.match(desktop, /if-no-files-found: error/)
  assert.match(release, /needs: \[image, android, desktop\]/)
})

test("the publish job attaches the desktop channel files", () => {
  assert.match(release, /find assets\/desktop-\* -maxdepth 1 -type f -print0/)
  assert.match(release, /gh release upload "\$TAG" --clobber "\$file"/)
})

test("the updater sidecar image is published next to the server image", () => {
  assert.match(release, /context: deploy\s*\n\s*file: deploy\/updater\.Dockerfile/s)
  assert.match(release, /\$\{\{ env\.IMAGE \}\}-updater:\$\{\{ steps\.meta\.outputs\.version \}\}/)
})

test("the Android SDK action is the maintained v4 (no removed 'tools' package)", () => {
  assert.match(release, /android-actions\/setup-android@v4/)
  assert.doesNotMatch(release, /android-actions\/setup-android@v3/)
})

test("desktop signing is opt-in and never exports an empty CSC_LINK", () => {
  const desktop = release.slice(release.indexOf("\n  desktop:"), release.indexOf("\n  publish:"))
  // An empty CSC_LINK makes electron-builder treat it as a certificate path;
  // on macOS it resolves the project directory and fails with "not a file".
  assert.doesNotMatch(desktop, /^\s+CSC_LINK:/m)
  assert.match(desktop, /WINDOWS_CSC_LINK/)
  assert.match(desktop, /MACOS_CSC_LINK/)
  assert.match(desktop, /export CSC_LINK=/)
})

