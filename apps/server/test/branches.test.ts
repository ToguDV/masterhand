import { describe, expect, it } from "vitest"
import { createFakeGitManager, login, startTestApp } from "./helpers.js"

async function startWorkspace(git: ReturnType<typeof createFakeGitManager>) {
  const app = await startTestApp({ git })
  const cookie = await login(app.url)
  const headers = { cookie, "content-type": "application/json" }
  const created = await fetch(`${app.url}/api/workspaces`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "app" }),
  })
  const { workspace } = (await created.json()) as { workspace: { id: string; path: string } }
  return { app, headers, workspace }
}

const BRANCHES = { current: "main", branches: ["main", "dev"] }

describe("/api/workspaces/:id/branches", () => {
  it("lists local branches for the workspace", async () => {
    const git = createFakeGitManager({ branches: async () => BRANCHES })
    const { app, headers, workspace } = await startWorkspace(git)
    try {
      const response = await fetch(`${app.url}/api/workspaces/${workspace.id}/branches`, { headers })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(BRANCHES)
    } finally {
      await app.close()
    }
  })

  it("answers 404 for an unknown workspace and 502 when git fails", async () => {
    const git = createFakeGitManager({
      branches: async () => {
        throw new Error("fatal: not a git repository")
      },
    })
    const { app, headers, workspace } = await startWorkspace(git)
    try {
      expect((await fetch(`${app.url}/api/workspaces/missing/branches`, { headers })).status).toBe(404)
      const failed = await fetch(`${app.url}/api/workspaces/${workspace.id}/branches`, { headers })
      expect(failed.status).toBe(502)
      expect(await failed.json()).toMatchObject({ error: "git_failed" })
    } finally {
      await app.close()
    }
  })

  it("maps a git deadline to an ambiguous 504", async () => {
    const git = createFakeGitManager({
      branches: async () => {
        throw new Error("git timed out after 60000ms")
      },
    })
    const { app, headers, workspace } = await startWorkspace(git)
    try {
      const timedOut = await fetch(`${app.url}/api/workspaces/${workspace.id}/branches`, { headers })
      expect(timedOut.status).toBe(504)
      expect(await timedOut.json()).toMatchObject({ error: "git_timeout" })
    } finally {
      await app.close()
    }
  })
})
