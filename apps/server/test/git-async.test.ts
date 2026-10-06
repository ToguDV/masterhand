import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createWorktreeManager } from "../src/worktrees.js"

/**
 * Regression for #77: git (and every external CLI) must run through async
 * `spawn`, never `spawnSync`/blocking fs work — a slow Finish & PR used to
 * freeze the whole BFF (no requests, no SSE events) for up to the 60 s git
 * timeout. The shim on PATH makes `git` deterministically slow.
 */
describe("async git runner (#77)", () => {
  const dirs: string[] = []

  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
  })

  function shimGit(script: string): string {
    const dir = mkdtempSync(join(tmpdir(), "mh-git-shim-"))
    dirs.push(dir)
    writeFileSync(join(dir, "git"), `#!/bin/sh\n${script}\n`, { mode: 0o755 })
    return dir
  }

  function withShim<T>(shim: string, work: () => Promise<T>): Promise<T> {
    const original = process.env.PATH
    process.env.PATH = `${shim}:${original ?? ""}`
    return work().finally(() => {
      process.env.PATH = original
    })
  }

  it("keeps the event loop responsive while git runs", async () => {
    const shim = shimGit("sleep 0.4\necho shim-branch")
    await withShim(shim, async () => {
      const manager = createWorktreeManager()
      const ticks: number[] = []
      const timer = setInterval(() => ticks.push(Date.now()), 10)
      try {
        const branch = await manager.headBranch("/tmp")
        expect(branch).toBe("shim-branch")
      } finally {
        clearInterval(timer)
      }
      // ~40 interval ticks fit in the 400 ms child; a synchronous spawn leaves ~0.
      expect(ticks.length).toBeGreaterThanOrEqual(10)
    })
  })

  it("kills a git command that exceeds its timeout instead of hanging forever", async () => {
    const shim = shimGit("sleep 3")
    await withShim(shim, async () => {
      const manager = createWorktreeManager({ gitTimeoutMs: 200 })
      const started = Date.now()
      const result = await manager.headBranch("/tmp")
      const elapsed = Date.now() - started
      expect(elapsed).toBeLessThan(1500)
      expect(result).not.toBe("shim-branch")
    })
  })
})
