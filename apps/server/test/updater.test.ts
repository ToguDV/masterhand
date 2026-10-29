import { describe, expect, it, vi } from "vitest"
import { createUpdateApplier, type UpdateApplierOptions } from "../src/updater.js"
import type { VersionRelease } from "../src/update.js"

const latest: VersionRelease = {
  version: "0.2.0",
  tag: "v0.2.0",
  publishedAt: null,
  notes: null,
}

function options(overrides: Partial<UpdateApplierOptions> = {}): UpdateApplierOptions {
  return {
    url: "http://updater:8080",
    token: "0123456789abcdef0123456789abcdef",
    track: "latest",
    currentVersion: "0.1.0",
    check: async () => latest,
    backup: async () => {},
    fetchImpl: (async () => new Response(null, { status: 202 })) as typeof fetch,
    ...overrides,
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe("createUpdateApplier (#134)", () => {
  it("is disabled without both the sidecar URL and token", async () => {
    for (const config of [{ url: null, token: null }, { url: "http://updater:8080", token: null }]) {
      const applier = createUpdateApplier(options(config))
      expect(applier.enabled).toBe(false)
      await expect(applier.apply()).resolves.toEqual({
        ok: false,
        error: "updater_disabled",
        status: 409,
      })
    }
  })

  it("disables one-click updates for a pinned image tag", async () => {
    const applier = createUpdateApplier(options({ track: "0.1.0" }))
    expect(applier.enabled).toBe(true)
    expect(applier.tracksLatest).toBe(false)
    await expect(applier.apply()).resolves.toEqual({ ok: false, error: "updater_pinned", status: 409 })
  })

  it("refuses when the manifest has no strictly newer release", async () => {
    const fetchImpl = vi.fn()
    const applier = createUpdateApplier(options({ check: async () => null, fetchImpl }))
    await expect(applier.apply()).resolves.toEqual({
      ok: false,
      error: "update_not_available",
      status: 409,
    })

    const sameVersion = createUpdateApplier(
      options({ check: async () => ({ ...latest, version: "0.1.0" }), fetchImpl }),
    )
    await expect(sameVersion.apply()).resolves.toEqual({
      ok: false,
      error: "update_not_available",
      status: 409,
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("backs up first, then asks the sidecar with the shared token", async () => {
    const order: string[] = []
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      order.push("fetch")
      expect(String(input)).toBe("http://updater:8080/update")
      expect(init?.method).toBe("POST")
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer 0123456789abcdef0123456789abcdef",
      )
      expect(JSON.parse(String(init?.body))).toEqual({ version: "0.2.0" })
      return new Response(null, { status: 202 })
    })
    const applier = createUpdateApplier(
      options({
        backup: async () => {
          order.push("backup")
        },
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    )

    await expect(applier.apply()).resolves.toEqual({ ok: true, target: "0.2.0" })
    expect(order).toEqual(["backup", "fetch"])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("blocks the update when the pre-update backup fails", async () => {
    const fetchImpl = vi.fn()
    const applier = createUpdateApplier(
      options({
        backup: async () => {
          throw new Error("disk full")
        },
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    )
    await expect(applier.apply()).resolves.toEqual({ ok: false, error: "backup_failed", status: 503 })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("maps a rejecting sidecar and a network failure without leaking the token", async () => {
    const rejected = createUpdateApplier(
      options({
        fetchImpl: (async () =>
          new Response(JSON.stringify({ error: "pull_failed" }), { status: 502 })) as typeof fetch,
      }),
    )
    await expect(rejected.apply()).resolves.toEqual({
      ok: false,
      error: "updater_rejected",
      status: 502,
    })

    const unreachable = createUpdateApplier(
      options({
        fetchImpl: (async () => {
          throw new Error("ECONNREFUSED")
        }) as typeof fetch,
      }),
    )
    await expect(unreachable.apply()).resolves.toEqual({
      ok: false,
      error: "updater_unreachable",
      status: 502,
    })
  })

  it("keeps a single update in flight after success", async () => {
    const gate = deferred<VersionRelease | null>()
    let fetchCalls = 0
    const applier = createUpdateApplier(
      options({
        check: () => gate.promise,
        fetchImpl: (async () => {
          fetchCalls += 1
          return new Response(null, { status: 202 })
        }) as typeof fetch,
      }),
    )

    const first = applier.apply()
    await Promise.resolve()
    await expect(applier.apply()).resolves.toEqual({
      ok: false,
      error: "update_in_progress",
      status: 409,
    })

    gate.resolve(latest)
    await expect(first).resolves.toEqual({ ok: true, target: "0.2.0" })
    expect(fetchCalls).toBe(1)

    // The process is about to restart: a second success must not start a
    // competing pull.
    await expect(applier.apply()).resolves.toEqual({
      ok: false,
      error: "update_in_progress",
      status: 409,
    })
    expect(fetchCalls).toBe(1)
  })

  it("allows a retry after a failed sidecar request", async () => {
    let calls = 0
    const applier = createUpdateApplier(
      options({
        fetchImpl: (async () => {
          calls += 1
          if (calls === 1) throw new Error("temporary")
          return new Response(null, { status: 202 })
        }) as typeof fetch,
      }),
    )
    await expect(applier.apply()).resolves.toMatchObject({ ok: false, error: "updater_unreachable" })
    await expect(applier.apply()).resolves.toEqual({ ok: true, target: "0.2.0" })
    expect(calls).toBe(2)
  })
})
