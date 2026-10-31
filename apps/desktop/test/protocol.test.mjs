import test from "node:test"
import assert from "node:assert/strict"
import { resolve, sep } from "node:path"
import { APP_URL, isAppUrl, resolveAppAsset } from "../dist/protocol.js"

const root = resolve("/tmp/masterhand-renderer")

test("recognizes only the bundled app origin", () => {
  for (const url of [APP_URL, "masterhand://app/", "masterhand://app/assets/app.js?v=1"]) {
    assert.equal(isAppUrl(url), true, url)
  }
  for (const url of [
    "masterhand://other/index.html",
    "masterhand://app.evil/index.html",
    "https://app/index.html",
    "file:///tmp/index.html",
    "not a url",
  ]) {
    assert.equal(isAppUrl(url), false, url)
  }
})

test("serves index.html for the origin root and the explicit index", () => {
  for (const url of ["masterhand://app/", "masterhand://app", APP_URL, "masterhand://app/index.html?session=abc"]) {
    assert.deepEqual(resolveAppAsset(root, url), {
      file: resolve(root, "index.html"),
      mime: "text/html; charset=utf-8",
    })
  }
})

test("resolves nested assets with their content type and ignores query strings", () => {
  assert.deepEqual(resolveAppAsset(root, "masterhand://app/assets/app-123.js?v=2"), {
    file: resolve(root, "assets", "app-123.js"),
    mime: "text/javascript; charset=utf-8",
  })
  assert.equal(resolveAppAsset(root, "masterhand://app/assets/app.css")?.mime, "text/css; charset=utf-8")
  assert.equal(resolveAppAsset(root, "masterhand://app/fonts/inter.woff2")?.mime, "font/woff2")
  assert.equal(resolveAppAsset(root, "masterhand://app/favicon.svg")?.mime, "image/svg+xml")
})

test("rejects encoded separators that would escape the renderer root", () => {
  const rejected = [
    "masterhand://app/%2e%2e%2fsecret.txt",
    "masterhand://app/..%2f..%2fsecret.txt",
    "masterhand://app/assets%2f..%2f..%2fsecret.txt",
    "masterhand://other/index.html",
    "https://app/index.html",
    "masterhand://app/index%00.html",
    "not a url",
  ]
  for (const url of rejected) {
    assert.equal(resolveAppAsset(root, url), null, url)
  }
})

test("normalizes dot segments inside the renderer root", () => {
  for (const url of [
    "masterhand://app/%2e%2e/secret.txt",
    "masterhand://app/assets/%2e%2e/%2e%2e/secret.txt",
    "masterhand://app/assets/%2e%2e/index.html",
  ]) {
    const asset = resolveAppAsset(root, url)
    assert.ok(asset, url)
    assert.ok(asset.file.startsWith(`${root}${sep}`), url)
  }
})
