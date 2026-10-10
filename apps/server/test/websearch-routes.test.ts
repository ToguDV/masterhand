import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createCustomProviderStore } from "../src/providers.js"
import { login, startTestApp } from "./helpers.js"

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function setup(options: { contents?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "masterhand-websearch-routes-"))
  dirs.push(dir)
  const file = join(dir, "providers.json")
  if (options.contents !== undefined) await writeFile(file, options.contents, "utf8")
  const providers = createCustomProviderStore({ file })
  const app = await startTestApp({ providers })
  const cookie = await login(app.url)
  return { app, file, providers, headers: { cookie, "content-type": "application/json" } }
}

describe("/api/websearch ", () => {
  it("seeds the keyless default on first read and stores later selections", async () => {
    const { app, file, headers } = await setup()
    try {
      // The keyless source is seeded when no selection exists, so agent web
      // searches work without opening settings first.
      const initial = await fetch(`${app.url}/api/websearch`, { headers })
      expect(initial.status).toBe(200)
      expect(await initial.json()).toEqual({ provider: "tinyfish" })
      const seeded = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>
      expect(seeded.websearch).toEqual({ provider: "tinyfish" })

      const saved = await fetch(`${app.url}/api/websearch`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ provider: "tavily" }),
      })
      expect(saved.status).toBe(200)
      expect(await saved.json()).toEqual({ provider: "tavily" })

      const reread = await fetch(`${app.url}/api/websearch`, { headers })
      expect(await reread.json()).toEqual({ provider: "tavily" })

      const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>
      expect(raw.websearch).toEqual({ provider: "tavily" })
    } finally {
      await app.close()
    }
  })

  it("never overwrites a present but unrecognized value", async () => {
    const { app, file, headers } = await setup({
      contents: JSON.stringify({ providers: {}, websearch: "not-an-object" }),
    })
    try {
      const response = await fetch(`${app.url}/api/websearch`, { headers })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ provider: null })
      const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>
      expect(raw.websearch).toBe("not-an-object")
    } finally {
      await app.close()
    }
  })

  it("accepts `random` and `false`, and rejects malformed payloads", async () => {
    const { app, headers } = await setup()
    try {
      for (const provider of ["random", false] as const) {
        const response = await fetch(`${app.url}/api/websearch`, {
          method: "PUT",
          headers,
          body: JSON.stringify({ provider }),
        })
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ provider })
      }

      const invalid = await fetch(`${app.url}/api/websearch`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ provider: "not a provider" }),
      })
      expect(invalid.status).toBe(400)
      expect(await invalid.json()).toEqual({ error: "invalid_provider" })

      const missing = await fetch(`${app.url}/api/websearch`, {
        method: "PUT",
        headers,
        body: JSON.stringify({}),
      })
      expect(missing.status).toBe(400)
      expect(await missing.json()).toEqual({ error: "invalid_provider" })

      const malformed = await fetch(`${app.url}/api/websearch`, {
        method: "PUT",
        headers,
        body: "not json",
      })
      expect(malformed.status).toBe(400)
      expect(await malformed.json()).toEqual({ error: "invalid_body" })
    } finally {
      await app.close()
    }
  })

  it("answers a corrupt file without overwriting it", async () => {
    const { app, file, headers } = await setup({ contents: "{ not json" })
    try {
      const read = await fetch(`${app.url}/api/websearch`, { headers })
      expect(read.status).toBe(500)
      expect(await read.json()).toEqual({ error: "websearch_corrupt" })

      const write = await fetch(`${app.url}/api/websearch`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ provider: "exa" }),
      })
      expect(write.status).toBe(500)
      expect(await write.json()).toEqual({ error: "websearch_corrupt" })

      expect(await readFile(file, "utf8")).toBe("{ not json")
    } finally {
      await app.close()
    }
  })
})
