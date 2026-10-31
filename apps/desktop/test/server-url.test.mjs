import test from "node:test"
import assert from "node:assert/strict"
import { DEV_WEB_URL, normalizeDesktopServerUrl } from "../dist/server-url.js"

test("accepts https and normalizes to the origin", () => {
  assert.deepEqual(normalizeDesktopServerUrl("https://masterhand.example.com"), {
    ok: true,
    url: "https://masterhand.example.com",
  })
  assert.deepEqual(normalizeDesktopServerUrl("  https://masterhand.example.com/  "), {
    ok: true,
    url: "https://masterhand.example.com",
  })
  assert.deepEqual(normalizeDesktopServerUrl("http://192.168.1.20:8787"), {
    ok: true,
    url: "http://192.168.1.20:8787",
  })
})

test("rejects paths, queries, fragments and credentials", () => {
  for (const input of [
    "https://example.com/app",
    "https://example.com/?x=1",
    "https://example.com/#top",
    "https://user:pass@example.com",
  ]) {
    assert.equal(normalizeDesktopServerUrl(input).ok, false, input)
  }
})

test("development prefills the Vite dev server, not the BFF root", () => {
  // The BFF still listens on :8787, but in dev only Vite serves the web app;
  // loading :8787 shows a 404. Packaged builds keep the empty field.
  assert.equal(DEV_WEB_URL, "http://localhost:5173")
  assert.equal(normalizeDesktopServerUrl(DEV_WEB_URL).ok, true)
})

test("rejects non-http protocols and empty values", () => {
  for (const input of ["", "   ", "ftp://example.com", "file:///etc/passwd", "not a url", null, 42]) {
    assert.equal(normalizeDesktopServerUrl(input).ok, false, String(input))
  }
})

test("rejects overly long URLs", () => {
  const result = normalizeDesktopServerUrl(`https://example.com/${"a".repeat(4096)}`)
  assert.equal(result.ok, false)
})
