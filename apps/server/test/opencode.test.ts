import { describe, expect, it, vi } from "vitest"
import { createGoalOpencode, createSchedulerOpencode, type OpencodeCall } from "../src/opencode.js"
import { UpstreamStatusError } from "../src/retry.js"

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), { status, headers: { "content-type": "application/json" } })
}

type CallOptions = NonNullable<Parameters<OpencodeCall>[1]>

function stubTransport(
  handler: (path: string, options: CallOptions) => Response,
): OpencodeCall & { calls: Array<{ path: string; options: CallOptions }> } {
  const calls: Array<{ path: string; options: CallOptions }> = []
  const call = (async (path: string, options: CallOptions = {}) => {
    calls.push({ path, options })
    return handler(path, options)
  }) as OpencodeCall & { calls: Array<{ path: string; options: CallOptions }> }
  call.calls = calls
  return call
}

function adapterDeps(call: OpencodeCall): { call: OpencodeCall; invalidateSessionsCache: () => void } {
  return { call, invalidateSessionsCache: vi.fn() }
}

describe("goal opencode adapter", () => {
  it("finds a session by its marker, scoped by directory", async () => {
    const call = stubTransport((path) => {
      expect(path).toBe("/api/session?directory=%2Fworkspace%2Fapp&limit=200")
      return json([
        { id: "ses_old", metadata: { "masterhand.goal.role": "other" } },
        { id: "ses_new", metadata: { "masterhand.goal.role": "critic_tok_1_0" } },
      ])
    })
    const adapter = createGoalOpencode(adapterDeps(call))
    await expect(adapter.findSessionByMarker("/workspace/app", "critic_tok_1_0")).resolves.toEqual({
      id: "ses_new",
    })
    expect(call.calls[0]?.options).toMatchObject({ retry: false })
    await expect(adapter.findSessionByMarker("/workspace/app", "missing")).resolves.toBeNull()
  })

  it("prompts with the delivery marker and checks the landing", async () => {
    const call = stubTransport((path) => {
      if (path.endsWith("/prompt")) return json({})
      return json([
        { type: "assistant", metadata: {} },
        { type: "user", metadata: { "masterhand.goal.delivery": "goal_tok_3" } },
      ])
    })
    const adapter = createGoalOpencode(adapterDeps(call))
    await adapter.prompt("ses_1", "work the goal", "goal_tok_3")
    expect(call.calls[0]).toMatchObject({
      path: "/api/session/ses_1/prompt",
      options: {
        method: "POST",
        body: { text: "work the goal", metadata: { "masterhand.goal.delivery": "goal_tok_3" } },
      },
    })
    await expect(adapter.promptLanded("ses_1", "goal_tok_3")).resolves.toBe(true)
    await expect(adapter.promptLanded("ses_1", "other")).resolves.toBe(false)
  })

  it("switches models with and without a variant", async () => {
    const call = stubTransport(() => json({}))
    const adapter = createGoalOpencode(adapterDeps(call))
    await adapter.switchModel("ses_1", { providerID: "prov", id: "model-a", variant: null })
    expect(call.calls[0]?.options.body).toEqual({ model: { id: "model-a", providerID: "prov" } })
    await adapter.switchModel("ses_1", { providerID: "prov", id: "model-a", variant: "high" })
    expect(call.calls[1]?.options.body).toEqual({ model: { id: "model-a", providerID: "prov", variant: "high" } })
  })

  it("creates sessions with parentID plus both metadata keys and invalidates the cache", async () => {
    const invalidateSessionsCache = vi.fn()
    const call = stubTransport(() => json({ id: "ses_critic" }))
    const adapter = createGoalOpencode({ call, invalidateSessionsCache })
    await expect(
      adapter.createSession({
        directory: "/workspace/app",
        parentID: "ses_main",
        title: "Goal critic",
        marker: "critic_tok_1_0",
        role: "critic",
      }),
    ).resolves.toEqual({ id: "ses_critic" })
    // The parentID quirk is load-bearing: the pinned opencode drops it, and
    // the retry reconciles by directory instead — but the adapter still sends
    // it for forward compatibility. Never drop either metadata key.
    expect(call.calls[0]?.options.body).toEqual({
      location: { directory: "/workspace/app" },
      parentID: "ses_main",
      title: "Goal critic",
      metadata: { "masterhand.goal.role": "critic_tok_1_0", "masterhand.goal.internal": "critic" },
    })
    expect(invalidateSessionsCache).toHaveBeenCalledTimes(1)
  })

  it("translates HTTP outcomes into typed errors", async () => {
    const adapter = createGoalOpencode(
      adapterDeps(
        stubTransport((path) => {
          if (path === "/api/session/ses_gone" || path.startsWith("/api/session/ses_gone/")) {
            return json({}, 404)
          }
          if (path === "/api/session/ses_broken" || path.startsWith("/api/session/ses_broken/")) {
            return json({}, 500)
          }
          if (path === "/api/session") return json({})
          return json({}, 500)
        }),
      ),
    )
    await expect(adapter.sessionInfo("ses_gone")).resolves.toBeNull()
    await expect(adapter.sessionInfo("ses_broken")).rejects.toBeInstanceOf(UpstreamStatusError)
    await expect(
      adapter.createSession({ directory: "/w", parentID: "p", title: "t", marker: "m", role: "judge" }),
    ).rejects.toThrow("opencode did not return a session id")
    await expect(adapter.removeSession("ses_gone")).resolves.toBeUndefined()
    await expect(adapter.removeSession("ses_broken")).rejects.toBeInstanceOf(UpstreamStatusError)
    await expect(adapter.lastAssistant("ses_gone")).resolves.toBeNull()
  })

  it("reads session info and the last assistant reply", async () => {
    const call = stubTransport((path) => {
      if (path === "/api/session/ses_1") {
        return json({
          location: { directory: "/workspace/app" },
          parentID: "ses_main",
          agent: "build",
          model: { id: "model-a", providerID: "prov", variant: "high" },
        })
      }
      return json([
        { id: "msg_2", type: "assistant", content: [{ type: "text", text: "second" }] },
        { id: "msg_1", type: "assistant", content: [{ type: "text", text: "first" }, { type: "tool", text: "x" }] },
      ])
    })
    const adapter = createGoalOpencode(adapterDeps(call))
    await expect(adapter.sessionInfo("ses_1")).resolves.toEqual({
      directory: "/workspace/app",
      parentID: "ses_main",
      model: { providerID: "prov", id: "model-a", variant: "high" },
      agent: "build",
    })
    await expect(adapter.sessionInfo("ses_empty")).resolves.toBeNull()
    await expect(adapter.lastAssistant("ses_1")).resolves.toEqual({ id: "msg_2", text: "second" })
  })

  it("lists active sessions and the model catalog", async () => {
    const call = stubTransport((path) => {
      if (path === "/api/session/active") return json({ ses_1: {}, ses_2: {} })
      return json([
        { id: "model-a", providerID: "prov" },
        { id: null, providerID: "prov" },
      ])
    })
    const adapter = createGoalOpencode(adapterDeps(call))
    await expect(adapter.activeSessions()).resolves.toEqual(["ses_1", "ses_2"])
    await expect(adapter.models()).resolves.toEqual(["prov/model-a"])
  })
})

describe("scheduler opencode adapter", () => {
  it("creates sessions positionally with the single scheduler key", async () => {
    const invalidateSessionsCache = vi.fn()
    const call = stubTransport(() => json({ id: "ses_fire" }))
    const adapter = createSchedulerOpencode({ call, invalidateSessionsCache })
    await expect(adapter.createSession("/workspace/app", "task_1#run_1#create", "Nightly check")).resolves.toEqual({
      id: "ses_fire",
    })
    // No parentID, no role metadata: the scheduler fire is a root session
    // reconciled by directory, like the goal lookup.
    expect(call.calls[0]?.options.body).toEqual({
      location: { directory: "/workspace/app" },
      title: "Nightly check",
      metadata: { "masterhand.scheduler": "task_1#run_1#create" },
    })
    expect(invalidateSessionsCache).toHaveBeenCalledTimes(1)
  })

  it("shares the marker lookup, prompt, landed check and model switch", async () => {
    const call = stubTransport((path) => {
      if (path.startsWith("/api/session?directory=")) {
        return json([{ id: "ses_fire", metadata: { "masterhand.scheduler": "task_1#run_1#create" } }])
      }
      if (path === "/api/session/active") return json({})
      if (path.endsWith("/prompt")) return json({})
      if (path.endsWith("/model")) return json({})
      return json([{ type: "user", metadata: { "masterhand.scheduler": "task_1#run_1#prompt" } }])
    })
    const adapter = createSchedulerOpencode(adapterDeps(call))
    await expect(adapter.findSessionByMarker("/workspace/app", "task_1#run_1#create")).resolves.toEqual({
      id: "ses_fire",
    })
    await adapter.prompt("ses_fire", "check the build", "task_1#run_1#prompt")
    expect(call.calls[1]?.options.body).toEqual({
      text: "check the build",
      metadata: { "masterhand.scheduler": "task_1#run_1#prompt" },
    })
    await expect(adapter.promptLanded("ses_fire", "task_1#run_1#prompt")).resolves.toBe(true)
    await adapter.switchModel("ses_fire", { providerID: "prov", id: "model-a" })
    expect(call.calls[3]?.options.body).toEqual({ model: { id: "model-a", providerID: "prov" } })
    await expect(adapter.activeSessions()).resolves.toEqual([])
  })

  it("deletes sessions tolerating 404 and checks the catalog", async () => {
    const invalidateSessionsCache = vi.fn()
    const call = stubTransport((path) => {
      if (path === "/api/session/ses_gone") return json({}, 404)
      if (path === "/api/session/ses_broken") return json({}, 500)
      return json([
        { id: "model-a", providerID: "prov" },
        { id: "other", providerID: "prov" },
      ])
    })
    const adapter = createSchedulerOpencode({ call, invalidateSessionsCache })
    await expect(adapter.deleteSession!("ses_gone")).resolves.toBeUndefined()
    expect(invalidateSessionsCache).toHaveBeenCalledTimes(1)
    await expect(adapter.deleteSession!("ses_broken")).rejects.toBeInstanceOf(UpstreamStatusError)
    await expect(adapter.modelExists!({ providerID: "prov", id: "model-a" })).resolves.toBe(true)
    await expect(adapter.modelExists!({ providerID: "prov", id: "missing" })).resolves.toBe(false)
  })
})
