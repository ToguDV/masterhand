import assert from "node:assert/strict"
import test from "node:test"
import {
  androidVersionCode as checkVersionCode,
  checkReleaseVersions,
} from "./check-release-versions.mjs"
import { androidVersionCode, releaseIdentity } from "./release.mjs"

const VERSION = "0.2.0"
const CODE = 200

function fixtures(overrides = {}) {
  const files = {
    "package.json": { name: "masterhand", version: VERSION },
    "apps/server/package.json": { name: "@masterhand/server", version: VERSION },
    "apps/web/package.json": { name: "@masterhand/web", version: VERSION },
    "apps/desktop/package.json": { name: "@masterhand/desktop", version: VERSION },
    "apps/mobile/package.json": { name: "@masterhand/mobile", version: VERSION },
    "packages/client-core/package.json": { name: "@masterhand/client-core", version: VERSION },
    "e2e/package.json": { name: "@masterhand/e2e", version: VERSION },
    "apps/mobile/app.json": {
      expo: { version: VERSION, android: { versionCode: CODE } },
    },
    ...overrides,
  }
  return (path) => {
    if (!(path in files)) throw new Error(`ENOENT: ${path}`)
    return JSON.stringify(files[path])
  }
}

test("releaseIdentity derives the tag and the monotonic versionCode", () => {
  assert.deepEqual(releaseIdentity("0.2.0"), { version: "0.2.0", tag: "v0.2.0", versionCode: 200 })
  assert.deepEqual(releaseIdentity("1.3.7"), { version: "1.3.7", tag: "v1.3.7", versionCode: 10307 })
  assert.equal(androidVersionCode("0.1.0"), 100)
})

test("releaseIdentity rejects leading v and prereleases", () => {
  for (const value of ["v0.2.0", "0.2.0-rc1", "0.2", "latest", ""]) {
    assert.throws(() => releaseIdentity(value), /final X\.Y\.Z/)
  }
})

test("checkReleaseVersions accepts a fully consistent tree", () => {
  const result = checkReleaseVersions({ tag: "v0.2.0", readFile: fixtures() })
  assert.deepEqual(result, { ok: true, version: VERSION, tag: "v0.2.0", versionCode: CODE })
  assert.equal(checkVersionCode(VERSION), CODE)
})

test("checkReleaseVersions rejects a stale package version", () => {
  const readFile = fixtures({
    "apps/desktop/package.json": { name: "@masterhand/desktop", version: "0.1.0" },
  })
  const result = checkReleaseVersions({ tag: "v0.2.0", readFile })
  assert.equal(result.ok, false)
  assert.match(result.errors.join("\n"), /apps\/desktop\/package\.json version is 0\.1\.0, expected 0\.2\.0/)
})

test("checkReleaseVersions rejects a stale mobile version and versionCode", () => {
  const staleVersion = checkReleaseVersions({
    tag: "v0.2.0",
    readFile: fixtures({ "apps/mobile/app.json": { expo: { version: "0.1.0", android: { versionCode: CODE } } } }),
  })
  assert.equal(staleVersion.ok, false)
  assert.match(staleVersion.errors.join("\n"), /expo\.version is 0\.1\.0/)

  const staleCode = checkReleaseVersions({
    tag: "v0.2.0",
    readFile: fixtures({ "apps/mobile/app.json": { expo: { version: VERSION, android: { versionCode: 100 } } } }),
  })
  assert.equal(staleCode.ok, false)
  assert.match(staleCode.errors.join("\n"), /versionCode is 100, expected 200/)
})

test("checkReleaseVersions rejects non-final tags and missing files", () => {
  assert.equal(checkReleaseVersions({ tag: "v0.2.0-rc1", readFile: fixtures() }).ok, false)
  assert.equal(checkReleaseVersions({ tag: "0.2.0", readFile: fixtures() }).ok, false)

  const missing = checkReleaseVersions({
    tag: "v0.2.0",
    readFile: (path) => {
      if (path === "package.json") throw new Error("ENOENT")
      return fixtures()(path)
    },
  })
  assert.equal(missing.ok, false)
  assert.match(missing.errors.join("\n"), /package\.json could not be read/)
})
