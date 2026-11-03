import { describe, expect, it, vi } from "vitest"
import { createSupervisorClient, parseSupervisorStatus } from "../src/supervisor.js"

describe("supervisor client", () => {
  it("parses a status snapshot defensively", () => {
    const parsed = parseSupervisorStatus({
      ok: true,
      services: {
        opencode: {
          service: "opencode",
          state: "running",
          health: "healthy",
          memory: { usedBytes: 1024, limitBytes: 4096 },
          attempts: 1,
          maxAttempts: 3,
          circuitOpen: false,
          restarting: true,
          lastIncident: { at: 10, service: "opencode", reason: "oom", attempt: 1, memory: null },
        },
      },
    })
    expect(parsed?.services.opencode).toMatchObject({
      state: "running",
      health: "healthy",
      attempts: 1,
      restarting: true,
      memory: { usedBytes: 1024, limitBytes: 4096 },
    })
    expect(parsed?.services.opencode?.lastIncident?.reason).toBe("oom")
  })

  it("returns null for malformed or missing status payloads", () => {
    expect(parseSupervisorStatus(null)).toBeNull()
    expect(parseSupervisorStatus({})).toBeNull()
    expect(parseSupervisorStatus({ services: [] })).toBeNull()
    expect(parseSupervisorStatus({ services: { opencode: "nope" } })?.services).toEqual({})
  })

  it("is disabled without a URL/token and never calls fetch", async () => {
    const fetchImpl = vi.fn()
    const client = createSupervisorClient({ url: null, token: null, fetchImpl })
    expect(client.enabled).toBe(false)
    expect(await client.status()).toBeNull()
    expect(await client.restart("opencode")).toEqual({ ok: false, error: "supervisor_unavailable" })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("sends the bearer token and maps a status response", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ services: { opencode: { state: "running", health: "healthy" } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
    const client = createSupervisorClient({ url: "http://watchdog:8080/", token: "secret", fetchImpl })
    const status = await client.status()
    expect(status?.services.opencode?.state).toBe("running")
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://watchdog:8080/status",
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        headers: expect.objectContaining({ authorization: "Bearer secret" }),
      }),
    )
  })

  it("never throws when the sidecar is unreachable or slow", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("connection refused")
    })
    const client = createSupervisorClient({ url: "http://watchdog:8080", token: "secret", fetchImpl })
    expect(await client.status()).toBeNull()
    expect(await client.restart("opencode")).toEqual({ ok: false, error: "supervisor_unavailable" })
  })

  it("aborts a slow status request at its deadline", async () => {
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
          })
        }),
    )
    const client = createSupervisorClient({
      url: "http://watchdog:8080",
      token: "secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      statusTimeoutMs: 10,
    })
    expect(await client.status()).toBeNull()
  })

  it("maps action errors without retrying", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: "action_in_progress" }), { status: 409 }),
    )
    const client = createSupervisorClient({ url: "http://watchdog:8080", token: "secret", fetchImpl })
    expect(await client.restart("opencode")).toEqual({
      ok: false,
      error: "action_in_progress",
      status: 409,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
