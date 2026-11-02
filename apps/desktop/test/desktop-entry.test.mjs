import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

/**
 * Linux window association depends on three values agreeing: Electron's
 * WM_CLASS (`desktopName` in package.json), `StartupWMClass` and the installed
 * `.desktop` filename. electron-builder derives the last two from the first
 * when `syncDesktopName` is on; this guard keeps a future edit from silently
 * reintroducing the duplicate taskbar icon.
 */
test("packages a .desktop entry that matches Electron's WM_CLASS", () => {
  const metadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  assert.equal(metadata.desktopName, "masterhand")

  const builder = readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8")
  assert.match(builder, /syncDesktopName:\s*true/)
  assert.match(builder, /assets\/icon\.png/)
})
