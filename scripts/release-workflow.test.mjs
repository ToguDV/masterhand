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
const builderConfig = readFileSync(join(repoRoot, "apps", "desktop", "electron-builder.yml"), "utf8")
const fdroidWorkflow = readFileSync(join(repoRoot, ".github", "workflows", "fdroid.yml"), "utf8")
const fdroidScript = readFileSync(join(repoRoot, "scripts", "fdroid-repo.sh"), "utf8")
const mobileApp = JSON.parse(readFileSync(join(repoRoot, "apps", "mobile", "app.json"), "utf8"))
const mobilePackage = JSON.parse(readFileSync(join(repoRoot, "apps", "mobile", "package.json"), "utf8"))

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
  // apksigner prints the digest without colons and keytool with colons; both
  // sides must be normalized before comparing (the first real APK build proved
  // the fingerprints matched but the string comparison failed).
  assert.match(release, /tr -d ':'/)
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

test("the desktop bundle ships the web build with the release identity", () => {
  const desktop = release.slice(release.indexOf("\n  desktop:"), release.indexOf("\n  publish:"))
  // The shell serves `dist/renderer`; package it and bake the tag's identity so
  // the bundled UI matches the server image (no `dev` build id in releases).
  assert.match(desktop, /MASTERHAND_VERSION="\$\{GITHUB_REF_NAME#v\}"/)
  assert.match(desktop, /MASTERHAND_BUILD="\$GITHUB_SHA"/)
  assert.match(builderConfig, /files:\s*\n\s*- dist\/\*\*\/\*/)
  assert.match(builderConfig, /- static\/\*\*\/\*/)
})

test("the Linux desktop target ships both the AppImage and a .deb", () => {
  assert.match(builderConfig, /- AppImage\s*\n\s*- deb/)
  assert.match(builderConfig, /artifactName: "MasterHand-\$\{version\}-\$\{arch\}\.deb"/)
  assert.match(release, /-name '\*\.deb'/)
})

test("the publish job attaches the desktop channel files", () => {
  assert.match(release, /find assets\/desktop-\* -maxdepth 1 -type f -print0/)
  assert.match(release, /gh release upload "\$TAG" --clobber "\$file"/)
})

test("publish downloads only release artifacts, never buildx cache artifacts", () => {
  assert.match(release, /name: version-json\s*\n\s*path: assets\/version-json/)
  assert.match(release, /name: android-apk\s*\n\s*path: assets\/android-apk/)
  assert.match(release, /pattern: desktop-\*/)
  assert.doesNotMatch(release, /Download the release assets/)
})

test("version.json reads the annotated tag, not the checked-out commit", () => {
  // v0.2.0's manifest shipped "chore(release): 0.2.0 (#256)" because
  // actions/checkout turns the tag ref into a lightweight tag (GITHUB_SHA is
  // the commit). The step must fetch the tag object before reading its message.
  const image = release.slice(release.indexOf("\n  image:"), release.indexOf("\n  android:"))
  assert.match(image, /git fetch --force origin "refs\/tags\/\$TAG:refs\/tags\/\$TAG"/)
  assert.match(image, /git for-each-ref "refs\/tags\/\$TAG" --format='%\(contents:subject\)'/)
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

test("the F-Droid repo is rebuilt by the shared script (release + manual repair)", () => {
  assert.match(release, /scripts\/fdroid-repo\.sh/)
  assert.match(fdroidWorkflow, /workflow_dispatch:/)
  assert.match(fdroidWorkflow, /contents: write/)
  assert.match(fdroidWorkflow, /scripts\/fdroid-repo\.sh/)
  // Current fdroidserver uses config.yml/repo_keyalias and creates metadata
  // with -c; the old config.py format fails with "repo_keyalias not found".
  assert.match(fdroidScript, /config\.yml/)
  assert.match(fdroidScript, /repo_keyalias/)
  assert.match(fdroidScript, /fdroid update -c/)
  assert.doesNotMatch(fdroidScript, /config\.py/)
})

test("the Android release keeps the constructors R8 strips from reflective classes", () => {
  // v0.2.0 crash: expo-background-task 58.0.11 → WorkManager 2.9.1 → Room
  // 2.5.0; R8 full mode removed WorkDatabase_Impl.<init> and the app died in
  // androidx.startup.InitializationProvider before React Native started.
  const plugin = mobileApp.expo.plugins.find(
    (entry) => Array.isArray(entry) && entry[0] === "expo-build-properties",
  )
  assert.ok(plugin, "expo-build-properties must be configured")
  const rules = plugin[1]?.android?.extraProguardRules ?? ""
  assert.match(rules, /-keep class \* extends androidx\.room\.RoomDatabase \{ <init>\(\); \}/)
  assert.match(rules, /-keep class \* extends androidx\.work\.InputMerger \{ <init>\(\); \}/)
  // Keep the upstream fix that stops relying on package-local InputMerger rules.
  assert.match(mobilePackage.dependencies["expo-background-task"], /58\.0\.12/)
  assert.match(mobilePackage.dependencies["expo-task-manager"], /58\.0\.13/)
})

test("the release APK is named after the app and version, and its dex is gated", () => {
  const android = release.slice(release.indexOf("\n  android:"), release.indexOf("\n  desktop:"))
  const build = android.indexOf("assembleRelease")
  const guard = android.indexOf("scripts/check-android-dex.mjs")
  const upload = android.indexOf("actions/upload-artifact")
  assert.ok(build >= 0 && guard > build && upload > guard, "the dex guard must run between build and upload")
  assert.match(android, /MasterHand-\$\{\{ needs\.image\.outputs\.version \}\}\.apk/)
  assert.match(android, /path: apps\/mobile\/android\/app\/build\/outputs\/apk\/release\/MasterHand-\$\{\{ needs\.image\.outputs\.version \}\}\.apk/)
  assert.match(android, /path: .*MasterHand-[\s\S]*?if-no-files-found: error/)
  assert.doesNotMatch(android, /path: apps\/mobile\/android\/app\/build\/outputs\/apk\/release\/app-release\.apk/)
})

test("the published APK asset includes the version and old tags remain repairable", () => {
  assert.match(release, /"assets\/android-apk\/MasterHand-\$\{VERSION\}\.apk"/)
  assert.doesNotMatch(release, /app-release\.apk#app-release\.apk/)
  assert.match(
    release,
    /APK_SOURCE: assets\/android-apk\/MasterHand-\$\{\{ needs\.image\.outputs\.version \}\}\.apk/,
  )
  assert.match(fdroidScript, /MasterHand-\$\{VERSION\}\.apk/)
  assert.match(fdroidScript, /--pattern app-release\.apk/)
})

