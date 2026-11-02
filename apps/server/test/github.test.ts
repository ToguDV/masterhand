import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createGithubIntegration, GithubError } from "../src/github.js"
import { createSqliteStore, type Store } from "../src/store.js"

const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"

let store: Store | null = null
let root = ""

afterEach(() => {
  store?.close()
  store = null
  if (root) rmSync(root, { recursive: true, force: true })
  root = ""
})

function setup(options: { configDir?: string | null; fetchImpl?: typeof fetch } = {}) {
  root = mkdtempSync(join(tmpdir(), "masterhand-github-"))
  store = createSqliteStore(join(root, "test.sqlite"))
  const configDir = options.configDir === undefined ? join(root, "agent-config") : options.configDir
  const github = createGithubIntegration({
    store,
    configDir,
    version: "9.9.9",
    fetchImpl: options.fetchImpl ?? userFetch(),
  })
  return { store, github, configDir }
}

function userFetch(body: unknown = { id: 123, login: "octocat", name: "Octo Cat", avatar_url: "https://example/avatar.png" }, status = 200): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "x-oauth-scopes": "repo, workflow" },
    }),
  ) as unknown as typeof fetch
}

describe("github integration", () => {
  it("rejects malformed tokens before contacting GitHub", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const { github } = setup({ fetchImpl })
    await expect(github.connect("not a token")).rejects.toMatchObject({ code: "invalid_token" })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(store?.getGithubAuth()).toBeNull()
  })

  it("does not persist a token GitHub rejects", async () => {
    const { github } = setup({ fetchImpl: userFetch({ message: "Bad credentials" }, 401) })
    await expect(github.connect(TOKEN)).rejects.toBeInstanceOf(GithubError)
    await expect(github.connect(TOKEN)).rejects.toMatchObject({ status: 400 })
    expect(store?.getGithubAuth()).toBeNull()
  })

  it("stores the account and writes group-readable agent config", async () => {
    const { github, configDir } = setup()
    const status = await github.connect(TOKEN)

    expect(status).toMatchObject({
      connected: true,
      login: "octocat",
      name: "Octo Cat",
      avatarUrl: "https://example/avatar.png",
      scopes: ["repo", "workflow"],
      injected: true,
      agentConfigError: null,
    })
    expect(JSON.stringify(status)).not.toContain(TOKEN)

    const gitConfig = readFileSync(join(configDir!, "git", "config"), "utf8")
    expect(gitConfig).toContain('helper = store --file /home/agent/.config/git/credentials')
    expect(gitConfig).toContain('email = "123+octocat@users.noreply.github.com"')
    const credentials = readFileSync(join(configDir!, "git", "credentials"), "utf8")
    expect(credentials).toContain(`x-access-token:${TOKEN}@github.com`)
    const hosts = readFileSync(join(configDir!, "gh", "hosts.yml"), "utf8")
    expect(hosts).toContain('user: "octocat"')
    expect(hosts).toContain(`oauth_token: "${TOKEN}"`)

    for (const path of ["git/config", "git/credentials", "gh/hosts.yml"]) {
      const mode = statSync(join(configDir!, path)).mode & 0o777
      expect(mode).toBe(0o640)
    }
    expect(statSync(join(configDir!, "git")).mode & 0o777).toBe(0o750)
  })

  it("re-materializes the stored token after a restart", async () => {
    const { github, configDir, store: current } = setup()
    await github.connect(TOKEN)
    rmSync(join(configDir!, "gh"), { recursive: true, force: true })

    const restarted = createGithubIntegration({
      store: current,
      configDir,
      fetchImpl: vi.fn() as unknown as typeof fetch,
    })
    expect(restarted.status().connected).toBe(true)
    await restarted.materialize()
    expect(readFileSync(join(configDir!, "gh", "hosts.yml"), "utf8")).toContain(TOKEN)
    expect(restarted.status().injected).toBe(true)
  })

  it("removes the row and files on disconnect", async () => {
    const { github, configDir } = setup()
    await github.connect(TOKEN)
    const status = await github.disconnect()
    expect(status.connected).toBe(false)
    expect(store?.getGithubAuth()).toBeNull()
    expect(() => readFileSync(join(configDir!, "gh", "hosts.yml"))).toThrow()
  })

  it("reports a failed disconnect instead of claiming a clean removal", async () => {
    const { github, configDir } = setup()
    await github.connect(TOKEN)
    rmSync(configDir!, { recursive: true, force: true })
    // Replace the volume path with a regular file: every unlink below it fails
    // with ENOTDIR, which must be surfaced rather than swallowed.
    await import("node:fs").then(({ writeFileSync }) => writeFileSync(configDir!, "not a directory"))
    const status = await github.disconnect()
    expect(status.connected).toBe(false)
    expect(status.agentConfigError).toContain("ENOTDIR")
    rmSync(configDir!, { force: true })
  })

  it("keeps the token when injection is unavailable and reports it", async () => {
    const { github } = setup({ configDir: null })
    const status = await github.connect(TOKEN)
    expect(status.connected).toBe(true)
    expect(status.injected).toBe(false)
    expect(status.agentConfigError).toContain("AGENT_CONFIG_DIR")
    expect(store?.getGithubAuth()?.login).toBe("octocat")
  })

  it("maps an unreachable GitHub to a retryable error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed")
    }) as unknown as typeof fetch
    const { github } = setup({ fetchImpl })
    await expect(github.connect(TOKEN)).rejects.toMatchObject({ code: "github_unreachable", status: 502 })
  })
})
