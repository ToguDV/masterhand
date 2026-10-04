import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  createRunManager,
  isInsideOrEqual,
  readRunFile,
  renderRunArgs,
  validateRunConfig,
  type RunOpencode,
  type RunPty,
} from "../src/runs.js"

describe("validateRunConfig", () => {
  it("accepts an argv command with a {port} placeholder", () => {
    const result = validateRunConfig(
      { command: "npm", args: ["run", "dev", "--", "--host", "0.0.0.0", "--port", "{port}"] },
      "/workspace/app",
    )
    expect(result).toEqual({
      ok: true,
      config: {
        command: "npm",
        args: ["run", "dev", "--", "--host", "0.0.0.0", "--port", "{port}"],
        cwd: null,
      },
    })
  })

  it("rejects shells and process-killing commands", () => {
    for (const command of ["bash", "/bin/sh", "pkill", "killall", "xargs", "sudo", "docker", "systemctl"]) {
      expect(validateRunConfig({ command, args: [] }, "/ws")).toMatchObject({
        ok: false,
        error: "command_not_allowed",
      })
    }
  })

  it("rejects malformed configs", () => {
    expect(validateRunConfig(null, "/ws")).toMatchObject({ ok: false, error: "invalid_config" })
    expect(validateRunConfig({}, "/ws")).toMatchObject({ ok: false, error: "invalid_command" })
    expect(validateRunConfig({ command: "npm", args: "dev" }, "/ws")).toMatchObject({
      ok: false,
      error: "invalid_args",
    })
    expect(validateRunConfig({ command: "npm", args: ["a".repeat(513)] }, "/ws")).toMatchObject({
      ok: false,
      error: "invalid_args",
    })
    expect(validateRunConfig({ command: "npm", args: Array(33).fill("x") }, "/ws")).toMatchObject({
      ok: false,
      error: "invalid_args",
    })
  })

  it("rejects control characters and malformed cwd values", () => {
    expect(validateRunConfig({ command: "np\nm" }, "/ws")).toMatchObject({ ok: false, error: "invalid_command" })
    expect(validateRunConfig({ command: "npm", args: ["a\nb"] }, "/ws")).toMatchObject({
      ok: false,
      error: "invalid_args",
    })
    expect(validateRunConfig({ command: "npm", args: [1] }, "/ws")).toMatchObject({
      ok: false,
      error: "invalid_args",
    })
    expect(validateRunConfig({ command: "npm", cwd: 42 }, "/ws")).toMatchObject({ ok: false, error: "invalid_cwd" })
    expect(validateRunConfig({ command: "npm", cwd: "" }, "/ws")).toMatchObject({
      ok: true,
      config: { cwd: null },
    })
  })

  it("keeps cwd inside the workspace", () => {
    expect(validateRunConfig({ command: "npm", cwd: "packages/web" }, "/workspace/app")).toMatchObject({
      ok: true,
      config: { cwd: "packages/web" },
    })
    expect(validateRunConfig({ command: "npm", cwd: "../other" }, "/workspace/app")).toMatchObject({
      ok: false,
      error: "cwd_outside_workspace",
    })
    expect(validateRunConfig({ command: "npm", cwd: "/etc" }, "/workspace/app")).toMatchObject({
      ok: false,
      error: "cwd_outside_workspace",
    })
  })
})

describe("renderRunArgs", () => {
  it("replaces every {port} token", () => {
    expect(renderRunArgs(["--port", "{port}", "--url={port}"], 3200)).toEqual(["--port", "3200", "--url=3200"])
  })
})

describe("isInsideOrEqual", () => {
  it("accepts the root itself and children, rejects escapes", () => {
    expect(isInsideOrEqual("/ws", "/ws")).toBe(true)
    expect(isInsideOrEqual("/ws", "/ws/app")).toBe(true)
    expect(isInsideOrEqual("/ws", "/ws/../etc")).toBe(false)
    expect(isInsideOrEqual("/ws", "/other")).toBe(false)
  })
})

describe("readRunFile", () => {
  it("returns null when the file does not exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "mh-run-"))
    try {
      expect(readRunFile(dir)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reads and validates .masterhand/run.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "mh-run-"))
    try {
      mkdirSync(join(dir, ".masterhand"))
      writeFileSync(join(dir, ".masterhand", "run.json"), JSON.stringify({ command: "npm", args: ["run", "dev"] }))
      expect(readRunFile(dir)).toEqual({ config: { command: "npm", args: ["run", "dev"], cwd: null } })

      writeFileSync(join(dir, ".masterhand", "run.json"), "{not json")
      expect(readRunFile(dir)).toEqual({ error: "invalid_json" })

      writeFileSync(join(dir, ".masterhand", "run.json"), JSON.stringify({ command: "pkill", args: ["-f", "vite"] }))
      expect(readRunFile(dir)).toEqual({ error: "command_not_allowed" })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

interface FakeOpencode extends RunOpencode {
  ptys: RunPty[]
  calls: Array<Record<string, unknown>>
}

function createFakeOpencode(): FakeOpencode {
  const ptys: RunPty[] = []
  const calls: Array<Record<string, unknown>> = []
  let counter = 0
  return {
    ptys,
    calls,
    async createPty(input) {
      counter += 1
      const pty: RunPty = { id: `pty_${counter}`, pid: 5000 + counter, status: "running", title: input.title }
      ptys.push(pty)
      calls.push({ op: "create", ...input })
      return pty
    },
    async listPtys() {
      return ptys.filter((pty) => pty.status === "running")
    },
    async removePty(_directory, ptyID) {
      calls.push({ op: "remove", ptyID })
      const index = ptys.findIndex((pty) => pty.id === ptyID)
      if (index >= 0) ptys.splice(index, 1)
    },
  }
}

describe("createRunManager", () => {
  const config = { command: "npm", args: ["run", "dev", "--", "--port", "{port}"], cwd: null }

  it("starts the run as argv with the reserved port and is idempotent", async () => {
    const opencode = createFakeOpencode()
    const manager = createRunManager({ opencode })

    const started = await manager.start("ses_1", "/ws", config, 3200)
    expect(started).toMatchObject({ status: "running", pid: 5001, port: 3200 })
    expect(opencode.calls[0]).toMatchObject({
      op: "create",
      command: "npm",
      args: ["run", "dev", "--", "--port", "3200"],
      cwd: "/ws",
      title: "masterhand:ses_1",
      env: { PORT: "3200" },
    })

    const again = await manager.start("ses_1", "/ws", config, 3200)
    expect(again.pid).toBe(5001)
    expect(opencode.calls.filter((call) => call.op === "create")).toHaveLength(1)

    expect(await manager.status("ses_1", "/ws", 3200)).toMatchObject({ status: "running", pid: 5001 })
    await manager.stop("ses_1", "/ws")
    expect(opencode.ptys).toHaveLength(0)
    expect(await manager.status("ses_1", "/ws", 3200)).toMatchObject({ status: "stopped", pid: null })
  })

  it("adopts a running PTY by its title after a BFF restart", async () => {
    const opencode = createFakeOpencode()
    opencode.ptys.push({ id: "pty_9", pid: 9000, status: "running", title: "masterhand:ses_2" })
    const manager = createRunManager({ opencode })

    expect(await manager.status("ses_2", "/ws", 3200)).toMatchObject({ status: "running", pid: 9000 })
    await manager.stop("ses_2", "/ws")
    expect(opencode.ptys).toHaveLength(0)
  })

  it("resolves a relative cwd against the session directory", async () => {
    const opencode = createFakeOpencode()
    const manager = createRunManager({ opencode })
    await manager.start("ses_3", "/ws/app", { ...config, cwd: "packages/web" }, 3210)
    expect(opencode.calls[0]).toMatchObject({ cwd: "/ws/app/packages/web" })
  })

  it("wraps a spawn failure in run_spawn_failed", async () => {
    const opencode: RunOpencode = {
      async createPty() {
        throw new Error("boom")
      },
      async listPtys() {
        return []
      },
      async removePty() {},
    }
    const manager = createRunManager({ opencode })
    await expect(manager.start("ses_1", "/ws", config, 3200)).rejects.toMatchObject({
      name: "RunError",
      code: "run_spawn_failed",
    })
  })

  it("forget stops the PTY it started", async () => {
    const opencode = createFakeOpencode()
    const manager = createRunManager({ opencode })
    await manager.start("ses_1", "/ws", config, 3200)
    manager.forget("ses_1")
    await Promise.resolve()
    expect(opencode.ptys).toHaveLength(0)
  })

  it("reports stopped when listing PTYs fails and stop is a no-op without a run", async () => {
    const opencode = createFakeOpencode()
    opencode.listPtys = async () => {
      throw new Error("down")
    }
    const manager = createRunManager({ opencode })
    expect(await manager.status("ses_1", "/ws", 3200)).toMatchObject({ status: "stopped" })
    await expect(manager.stop("ses_1", "/ws")).resolves.toBeUndefined()
  })
})
