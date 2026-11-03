import { describe, expect, it, vi } from "vitest"
import { createTurnOpencode } from "../src/opencode.js"
import { TURN_RESUME_MARKER_KEY } from "../src/journal.js"

function callStub(handler: (path: string, options?: { method?: string; body?: unknown }) => Response | Promise<Response>) {
  return vi.fn(async (path: string, options?: { method?: string; body?: unknown }) => handler(path, options))
}

describe("turn opencode adapter", () => {
  it("lists active sessions", async () => {
    const call = callStub((path) => {
      expect(path).toBe("/api/session/active")
      return new Response(JSON.stringify({ data: { ses_1: { type: "running" }, ses_2: {} } }), { status: 200 })
    })
    const adapter = createTurnOpencode({ call, invalidateSessionsCache: () => {} })
    expect(await adapter.activeSessions()).toEqual(["ses_1", "ses_2"])
  })

  it("throws on a non-ok active-session listing", async () => {
    const call = callStub(() => new Response("nope", { status: 503 }))
    const adapter = createTurnOpencode({ call, invalidateSessionsCache: () => {} })
    await expect(adapter.activeSessions()).rejects.toMatchObject({ status: 503 })
  })

  it("returns the session directory, parent and metadata", async () => {
    const call = callStub((path) => {
      expect(path).toBe("/api/session/ses_1")
      return new Response(
        JSON.stringify({
          data: {
            location: { directory: "/workspace/app" },
            parentID: "ses_parent",
            metadata: { "masterhand.scheduler": "x" },
          },
        }),
        { status: 200 },
      )
    })
    const adapter = createTurnOpencode({ call, invalidateSessionsCache: () => {} })
    expect(await adapter.sessionInfo("ses_1")).toEqual({
      directory: "/workspace/app",
      parentID: "ses_parent",
      metadata: { "masterhand.scheduler": "x" },
    })
  })

  it("treats a missing session or directory as null", async () => {
    const missing = createTurnOpencode({
      call: callStub(() => new Response("nope", { status: 404 })),
      invalidateSessionsCache: () => {},
    })
    expect(await missing.sessionInfo("ses_1")).toBeNull()
    const noDirectory = createTurnOpencode({
      call: callStub(() => new Response(JSON.stringify({ data: {} }), { status: 200 })),
      invalidateSessionsCache: () => {},
    })
    expect(await noDirectory.sessionInfo("ses_1")).toBeNull()
  })

  it("returns the last assistant with its completion metadata", async () => {
    const call = callStub((path) => {
      expect(path).toContain("/api/session/ses_1/message")
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "msg_1",
              type: "assistant",
              content: [{ type: "text", text: "done" }],
              time: { created: 1_500, completed: 1_600 },
            },
            { id: "msg_0", type: "user", content: [] },
          ],
        }),
        { status: 200 },
      )
    })
    const adapter = createTurnOpencode({ call, invalidateSessionsCache: () => {} })
    expect(await adapter.lastAssistant("ses_1")).toEqual({
      id: "msg_1",
      text: "done",
      completed: true,
      createdAt: 1_500,
    })
  })

  it("returns null when the session has no assistant message or is gone", async () => {
    const empty = createTurnOpencode({
      call: callStub(() => new Response(JSON.stringify({ data: [{ id: "msg_0", type: "user", content: [] }] }), { status: 200 })),
      invalidateSessionsCache: () => {},
    })
    expect(await empty.lastAssistant("ses_1")).toBeNull()
    const gone = createTurnOpencode({
      call: callStub(() => new Response("nope", { status: 404 })),
      invalidateSessionsCache: () => {},
    })
    expect(await gone.lastAssistant("ses_1")).toBeNull()
  })

  it("sends the continuation with the resume marker and reconciles it", async () => {
    const call = callStub((path, options) => {
      if (path.endsWith("/prompt")) {
        expect(options?.method).toBe("POST")
        expect(options?.body).toEqual({ text: "continue", metadata: { [TURN_RESUME_MARKER_KEY]: "resume_1" } })
        return new Response("{}", { status: 200 })
      }
      expect(path).toContain("/message")
      return new Response(
        JSON.stringify({
          data: [{ id: "msg_1", type: "user", metadata: { [TURN_RESUME_MARKER_KEY]: "resume_1" } }],
        }),
        { status: 200 },
      )
    })
    const adapter = createTurnOpencode({ call, invalidateSessionsCache: () => {} })
    await adapter.prompt("ses_1", "continue", "resume_1")
    expect(await adapter.promptLanded("ses_1", "resume_1")).toBe(true)
  })

  it("throws on a failed prompt or a failed landed lookup", async () => {
    const failed = createTurnOpencode({
      call: callStub(() => new Response("nope", { status: 500 })),
      invalidateSessionsCache: () => {},
    })
    await expect(failed.prompt("ses_1", "x", "m")).rejects.toMatchObject({ status: 500 })
    await expect(failed.promptLanded("ses_1", "m")).rejects.toMatchObject({ status: 500 })
  })
})
