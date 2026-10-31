/**
 * Copies the compiled web app next to the Electron main process so
 * `electron-builder` packages it and `main.ts` can serve it from
 * `masterhand://app`. `build:renderer` builds the web workspace first.
 */

import { cp, mkdir, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const scriptsDir = dirname(fileURLToPath(import.meta.url))
const desktopDir = join(scriptsDir, "..")
const source = join(desktopDir, "..", "web", "dist")
const target = join(desktopDir, "dist", "renderer")

await rm(target, { recursive: true, force: true })
await mkdir(target, { recursive: true })
await cp(source, target, { recursive: true })

console.log(`[desktop] bundled the web build into ${target}`)
