import { describe, expect, it } from "vitest"
import { ApiError, createClient } from "../src/client"
import { createEventStream } from "../src/events"
import type { SessionMessageInfo, SessionMessageUser } from "../src/types"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

type FetchCall = { url: string; init?: RequestInit }

/** Fetch stub that records calls and serves one factory per call (reusing the last one). */
function recordingFetch(...responses: Array<() => Response>): { calls: FetchCall[]; fetchImpl: typeof fetch } {
  const calls: FetchCall[] = []
  let index = 0
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const factory = responses[Math.min(index, responses.length - 1)]
    index++
    return factory ? factory() : jsonResponse({})
  }) as typeof fetch
  return { calls, fetchImpl }
}

function userV2(id: string, text = "hi"): SessionMessageUser {
  return { type: "user", id, time: { created: 1 }, text }
}

function idleV2(id: string): SessionMessageInfo {
  return { type: "idle", id, time: { created: 1 }, outcome: "succeeded" } as SessionMessageInfo
}

function messagesPage(data: SessionMessageInfo[], next: string | null): Response {
  return jsonResponse({ data, cursor: { previous: null, next } })
}

const universalBody = (): Response =>
  jsonResponse({
    data: [],
    cursor: { previous: null, next: null },
    sessions: [{ id: "ses_1" }],
    devices: [{ id: "dev_1" }],
    workspaces: [{ id: "ws_1" }],
    token: "tok",
    device: { id: "dev_1", name: "Phone" },
    directories: ["/workspace/app"],
    interrupted: true,
    preview: { status: "running", url: "https://x.trycloudflare.com", port: 3200, error: null },
    session: { id: "ses_1" },
    workspace: { id: "ws_1" },
    committed: true,
    pushed: false,
    prUrl: null,
    branch: "b",
    path: "/p",
    error: null,
  })

describe("createClient", () => {
  it("joins the base URL with the BFF session prefix", async () => {
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse({ sessions: [{ id: "ses_1" }] }))
    const client = createClient({ baseUrl: "https://mh.example/", fetchImpl })

    const sessions = await client.api.sessions.list("ws_1")
    expect(sessions).toEqual([{ id: "ses_1" }])
    expect(client.baseUrl).toBe("https://mh.example")
    expect(calls[0]?.url).toBe("https://mh.example/api/workspaces/ws_1/sessions")
    expect(calls[0]?.init?.credentials).toBe("same-origin")
  })

  it("sends a Bearer token when getToken returns one", async () => {
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse({ ok: true }))
    const client = createClient({ baseUrl: "", getToken: () => "tok_123", fetchImpl })

    await client.auth.status()
    const headers = new Headers(calls[0]?.init?.headers)
    expect(headers.get("authorization")).toBe("Bearer tok_123")
    expect(calls[0]?.url).toBe("/api/status")
  })

  it("sets a JSON content-type for bodies", async () => {
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse({ workspace: { id: "ws_1" } }))
    const client = createClient({ baseUrl: "", fetchImpl })

    await client.workspaces.create({ name: "app" })
    const headers = new Headers(calls[0]?.init?.headers)
    expect(headers.get("content-type")).toBe("application/json")
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ name: "app" }))
  })

  it("returns undefined for 204 responses", async () => {
    const { fetchImpl } = recordingFetch(() => new Response(null, { status: 204 }))
    const client = createClient({ fetchImpl })
    expect(await client.workspaces.remove("ws_1")).toBeUndefined()
  })

  it("throws ApiError and reports 401s", async () => {
    let unauthorized = 0
    const { fetchImpl } = recordingFetch(() => new Response("unauthorized", { status: 401 }))
    const client = createClient({ onUnauthorized: () => unauthorized++, fetchImpl })

    await expect(client.api.sessions.list("ws_1")).rejects.toBeInstanceOf(ApiError)
    expect(unauthorized).toBe(1)
  })

  it("creates device tokens through the BFF", async () => {
    const { calls, fetchImpl } = recordingFetch(() =>
      jsonResponse({ token: "tok", device: { id: "dev_1", name: "Phone" } }, 201),
    )
    const client = createClient({ baseUrl: "https://mh.example", fetchImpl })

    const result = await client.auth.loginDevice("secret", "Phone")
    expect(result.token).toBe("tok")
    expect(calls[0]?.url).toBe("https://mh.example/api/devices")
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ password: "secret", name: "Phone" })
  })

  it("targets the expected BFF and opencode endpoints", async () => {
    // Every call but the permission reply (a 204 mutation) answers with the universal JSON body.
    const { calls, fetchImpl } = recordingFetch(
      ...Array.from({ length: 16 }, () => universalBody),
      () => new Response(null, { status: 204 }),
      universalBody,
    )
    const client = createClient({ baseUrl: "https://mh.example", fetchImpl })

    await client.auth.login("pw")
    await client.auth.logout()
    await client.auth.loginDevice("pw", "Phone")
    await client.auth.status()
    await client.auth.devices()
    await client.auth.revokeDevice("dev/1")
    await client.api.sessions.list("ws_1")
    await client.api.sessions.create("ws_1", { isolated: true })
    await client.api.sessions.remove("ws_1", "ses_1")
    await client.api.sessions.finish("ses_1")
    await client.api.sessions.directories("ws_1")
    await client.api.messages("ses_1")
    await client.api.prompt("ses_1", { text: "hi" })
    await client.api.abortSession("ses_1")
    await client.api.permissions()
    await client.api.permissions("/workspace/my app")
    await client.api.respondPermission("ses_1", "per_1", "once")
    await client.api.agents()
    await client.api.models()
    await client.api.statuses()
    await client.api.preview("ses/1")
    await client.api.startPreview("ses/1")
    await client.api.stopPreview("ses/1")
    await client.workspaces.list()
    await client.workspaces.create({ name: "app" })
    await client.workspaces.remove("ws/1", { deleteFiles: true })

    const routes = calls.map((call) => `${call.init?.method ?? "GET"} ${call.url}`)
    expect(routes).toEqual([
      "POST https://mh.example/api/login",
      "POST https://mh.example/api/logout",
      "POST https://mh.example/api/devices",
      "GET https://mh.example/api/status",
      "GET https://mh.example/api/devices",
      "DELETE https://mh.example/api/devices/dev%2F1",
      "GET https://mh.example/api/workspaces/ws_1/sessions",
      "POST https://mh.example/api/workspaces/ws_1/sessions",
      "DELETE https://mh.example/api/workspaces/ws_1/sessions/ses_1",
      "POST https://mh.example/api/isolated-sessions/ses_1/finish",
      "GET https://mh.example/api/workspaces/ws_1/directories",
      "GET https://mh.example/api/oc/api/session/ses_1/message?limit=200&order=desc",
      "POST https://mh.example/api/oc/api/session/ses_1/prompt",
      "POST https://mh.example/api/oc/api/session/ses_1/interrupt",
      "GET https://mh.example/api/oc/api/permission/request",
      "GET https://mh.example/api/oc/api/permission/request?location%5Bdirectory%5D=%2Fworkspace%2Fmy+app",
      "POST https://mh.example/api/oc/api/session/ses_1/permission/per_1/reply",
      "GET https://mh.example/api/oc/api/agent",
      "GET https://mh.example/api/oc/api/model",
      "GET https://mh.example/api/oc/api/provider",
      "GET https://mh.example/api/oc/api/model/default",
      "GET https://mh.example/api/oc/api/session/active",
      "GET https://mh.example/api/sessions/ses%2F1/preview",
      "POST https://mh.example/api/sessions/ses%2F1/preview",
      "DELETE https://mh.example/api/sessions/ses%2F1/preview",
      "GET https://mh.example/api/workspaces",
      "POST https://mh.example/api/workspaces",
      "DELETE https://mh.example/api/workspaces/ws%2F1?deleteFiles=1",
    ])
  })

  it("unwraps the device list", async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse({ devices: [{ id: "dev_1" }] }))
    const client = createClient({ fetchImpl })
    expect(await client.auth.devices()).toEqual([{ id: "dev_1" }])
  })

  it("preserves a caller-provided content-type", async () => {
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse({}))
    const client = createClient({ fetchImpl })
    await client.auth.login("pw")
    const headers = new Headers(calls[0]?.init?.headers)
    expect(headers.get("content-type")).toBe("application/json")
  })
})

describe("messages", () => {
  it("walks the v2 cursor pages newest-first without combining order and cursor", async () => {
    const { calls, fetchImpl } = recordingFetch(
      () => messagesPage([userV2("msg_2", "newest")], "cur_1"),
      () => messagesPage([userV2("msg_1"), idleV2("msg_ignored")], null),
    )
    const client = createClient({ baseUrl: "https://mh.example", fetchImpl })

    const messages = await client.api.messages("ses_1")
    expect(messages.map((message) => message.info.id)).toEqual(["msg_1", "msg_2"])
    expect(messages[1]?.parts[0]).toMatchObject({ type: "text", text: "newest" })
    expect(calls).toHaveLength(2)
    expect(calls[0]?.url).toBe("https://mh.example/api/oc/api/session/ses_1/message?limit=200&order=desc")
    expect(calls[1]?.url).toBe("https://mh.example/api/oc/api/session/ses_1/message?limit=200&cursor=cur_1")
    expect(calls[1]?.url).not.toContain("order=")
  })

  it("stops after the maximum number of pages", async () => {
    const { calls, fetchImpl } = recordingFetch(() => messagesPage([userV2("msg_1")], "cur_next"))
    const client = createClient({ baseUrl: "https://mh.example", fetchImpl })

    const messages = await client.api.messages("ses_1")
    expect(calls).toHaveLength(50)
    expect(messages).toHaveLength(50)
  })
})

describe("prompt", () => {
  it("sends only the prompt when the agent and model already match", async () => {
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse({ data: {} }))
    const client = createClient({ baseUrl: "https://mh.example", fetchImpl })

    await client.api.prompt(
      "ses_1",
      { text: "hi", agent: "build", model: { id: "m1", providerID: "p" } },
      { agent: "build", model: { id: "m1", providerID: "p" } },
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe("https://mh.example/api/oc/api/session/ses_1/prompt")
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ text: "hi" })
  })

  it("switches the agent before prompting only when it changed", async () => {
    const { calls, fetchImpl } = recordingFetch(
      () => new Response(null, { status: 204 }),
      () => jsonResponse({ data: {} }),
    )
    const client = createClient({ baseUrl: "https://mh.example", fetchImpl })

    await client.api.prompt("ses_1", { text: "hi", agent: "plan" }, { agent: "build" })

    expect(calls.map((call) => call.url)).toEqual([
      "https://mh.example/api/oc/api/session/ses_1/agent",
      "https://mh.example/api/oc/api/session/ses_1/prompt",
    ])
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ agent: "plan" })
  })

  it("switches the model when it or its variant changed", async () => {
    const { calls, fetchImpl } = recordingFetch(
      () => new Response(null, { status: 204 }),
      () => jsonResponse({ data: {} }),
    )
    const client = createClient({ baseUrl: "https://mh.example", fetchImpl })

    await client.api.prompt(
      "ses_1",
      { text: "hi", model: { id: "m1", providerID: "p", variant: "high" } },
      { model: { id: "m1", providerID: "p" } },
    )

    expect(calls.map((call) => call.url)).toEqual([
      "https://mh.example/api/oc/api/session/ses_1/model",
      "https://mh.example/api/oc/api/session/ses_1/prompt",
    ])
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      model: { id: "m1", providerID: "p", variant: "high" },
    })
  })

  it("keeps the model when id, provider and variant match", async () => {
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse({ data: {} }))
    const client = createClient({ baseUrl: "https://mh.example", fetchImpl })

    await client.api.prompt(
      "ses_1",
      { text: "hi", model: { id: "m1", providerID: "p", variant: "high" } },
      { model: { id: "m1", providerID: "p", variant: "high" } },
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toContain("/prompt")
  })

  it("switches both when there is no current context", async () => {
    const { calls, fetchImpl } = recordingFetch(
      () => new Response(null, { status: 204 }),
      () => new Response(null, { status: 204 }),
      () => jsonResponse({ data: {} }),
    )
    const client = createClient({ baseUrl: "https://mh.example", fetchImpl })

    await client.api.prompt("ses_1", {
      text: "hi",
      agent: "plan",
      model: { id: "m2", providerID: "p" },
    })

    expect(calls.map((call) => call.url)).toEqual([
      "https://mh.example/api/oc/api/session/ses_1/agent",
      "https://mh.example/api/oc/api/session/ses_1/model",
      "https://mh.example/api/oc/api/session/ses_1/prompt",
    ])
  })

  it("does not switch anything without agent or model input", async () => {
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse({ data: {} }))
    const client = createClient({ baseUrl: "https://mh.example", fetchImpl })

    await client.api.prompt("ses_1", { text: "hi" }, { agent: "plan", model: { id: "m1", providerID: "p" } })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toContain("/prompt")
  })

  it("forwards subagent mentions with the prompt", async () => {
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse({ data: {} }))
    const client = createClient({ baseUrl: "https://mh.example", fetchImpl })

    await client.api.prompt("ses_1", {
      text: "@general hi",
      agents: [{ name: "general", mention: { start: 0, end: 8, text: "@general" } }],
    })

    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      text: "@general hi",
      agents: [{ name: "general", mention: { start: 0, end: 8, text: "@general" } }],
    })
  })
})

describe("commands", () => {
  it("fetches the command catalog for a location", async () => {
    const command = { name: "review", description: "review changes", arguments: [] }
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse({ commands: [command] }))
    const client = createClient({ baseUrl: "https://mh.example", fetchImpl })

    expect(await client.api.commands("/workspace/my app")).toEqual([command])
    expect(calls[0]?.url).toBe("https://mh.example/api/commands?directory=%2Fworkspace%2Fmy%20app")
  })

  it("fetches the catalog without a location when none is given", async () => {
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse({ commands: [] }))
    const client = createClient({ baseUrl: "https://mh.example", fetchImpl })

    expect(await client.api.commands()).toEqual([])
    expect(calls[0]?.url).toBe("https://mh.example/api/commands")
  })

  it("runs a command with its argument text after switching context", async () => {
    const { calls, fetchImpl } = recordingFetch(
      () => new Response(null, { status: 204 }),
      () => new Response(null, { status: 204 }),
      () => new Response(null, { status: 204 }),
    )
    const client = createClient({ baseUrl: "https://mh.example", fetchImpl })

    await client.api.runCommand(
      "ses_1",
      { name: "create-file", text: "config.json src", agent: "plan", model: { id: "m2", providerID: "p" } },
      { agent: "build" },
    )

    expect(calls.map((call) => call.url)).toEqual([
      "https://mh.example/api/oc/api/session/ses_1/agent",
      "https://mh.example/api/oc/api/session/ses_1/model",
      "https://mh.example/api/oc/api/session/ses_1/command",
    ])
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({ name: "create-file", text: "config.json src" })
  })

  it("forwards subagent mentions with the command", async () => {
    const { calls, fetchImpl } = recordingFetch(() => new Response(null, { status: 204 }))
    const client = createClient({ baseUrl: "https://mh.example", fetchImpl })

    await client.api.runCommand("ses_1", {
      name: "review",
      text: "@general main",
      agents: [{ name: "general", mention: { start: 0, end: 8, text: "@general" } }],
    })

    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      name: "review",
      text: "@general main",
      agents: [{ name: "general", mention: { start: 0, end: 8, text: "@general" } }],
    })
  })
})

describe("side question forks", () => {
  it("forks a session and returns the new session", async () => {
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse({ data: { id: "ses_fork" } }))
    const client = createClient({ baseUrl: "https://mh.example", fetchImpl })

    expect(await client.api.forkSession("ses_1")).toEqual({ id: "ses_fork" })
    expect(calls[0]?.url).toBe("https://mh.example/api/oc/api/session/ses_1/fork")
  })

  it("forks before a message when asked", async () => {
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse({ data: { id: "ses_fork" } }))
    const client = createClient({ baseUrl: "https://mh.example", fetchImpl })

    await client.api.forkSession("ses_1", "msg_1")
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ before: "msg_1" })
  })

  it("deletes a session to discard the fork", async () => {
    const { calls, fetchImpl } = recordingFetch(() => new Response(null, { status: 204 }))
    const client = createClient({ baseUrl: "https://mh.example", fetchImpl })

    await client.api.removeSession("ses_fork")
    expect(calls[0]?.init?.method).toBe("DELETE")
    expect(calls[0]?.url).toBe("https://mh.example/api/oc/api/session/ses_fork")
  })
})

describe("opencode session operations", () => {
  it("aborts a session and unwraps the interrupted flag", async () => {
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse({ interrupted: true }))
    const client = createClient({ baseUrl: "https://mh.example", fetchImpl })

    expect(await client.api.abortSession("ses_1")).toBe(true)
    expect(calls[0]?.url).toBe("https://mh.example/api/oc/api/session/ses_1/interrupt")
  })

  it("lists pending permissions with and without a location", async () => {
    const permission = { id: "per_1", sessionID: "ses_1", action: "bash", resources: ["ls"] }
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse({ data: [permission] }))
    const client = createClient({ baseUrl: "https://mh.example", fetchImpl })

    expect(await client.api.permissions()).toEqual([permission])
    expect(await client.api.permissions("/workspace/app")).toEqual([permission])
    expect(calls.map((call) => call.url)).toEqual([
      "https://mh.example/api/oc/api/permission/request",
      "https://mh.example/api/oc/api/permission/request?location%5Bdirectory%5D=%2Fworkspace%2Fapp",
    ])
  })

  it("replies to a permission request with the chosen decision", async () => {
    const { calls, fetchImpl } = recordingFetch(() => new Response(null, { status: 204 }))
    const client = createClient({ baseUrl: "https://mh.example", fetchImpl })

    await client.api.respondPermission("ses_1", "per/1", "reject")
    expect(calls[0]?.url).toBe("https://mh.example/api/oc/api/session/ses_1/permission/per%2F1/reply")
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ decision: "reject" })
  })

  it("lists the forms of a session and the pending forms of a location", async () => {
    const form = { id: "frm_1", sessionID: "ses_1", title: "Questions", fields: [{ key: "a", type: "string" }] }
    const { calls, fetchImpl } = recordingFetch(
      () => jsonResponse({ data: [form] }),
      () => jsonResponse({ location: { directory: "/workspace/app" }, data: [form] }),
    )
    const client = createClient({ baseUrl: "https://mh.example", fetchImpl })

    expect(await client.api.forms("ses_1")).toEqual([form])
    expect(await client.api.pendingForms("/workspace/app")).toEqual([form])
    expect(calls.map((call) => call.url)).toEqual([
      "https://mh.example/api/oc/api/session/ses_1/form",
      "https://mh.example/api/oc/api/form?location%5Bdirectory%5D=%2Fworkspace%2Fapp",
    ])
  })

  it("lists pending forms without a location", async () => {
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse({ location: {}, data: [] }))
    const client = createClient({ baseUrl: "https://mh.example", fetchImpl })

    expect(await client.api.pendingForms()).toEqual([])
    expect(calls[0]?.url).toBe("https://mh.example/api/oc/api/form")
  })

  it("gets a form with its state", async () => {
    const detail = {
      id: "frm_1",
      sessionID: "ses_1",
      title: "Questions",
      fields: [{ key: "a", type: "string" }],
      state: { status: "pending" },
    }
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse({ data: detail }))
    const client = createClient({ baseUrl: "https://mh.example", fetchImpl })

    expect(await client.api.form("ses_1", "frm_1")).toEqual(detail)
    expect(calls[0]?.url).toBe("https://mh.example/api/oc/api/session/ses_1/form/frm_1")
  })

  it("replies to and cancels a form", async () => {
    const { calls, fetchImpl } = recordingFetch(
      () => new Response(null, { status: 204 }),
      () => new Response(null, { status: 204 }),
    )
    const client = createClient({ baseUrl: "https://mh.example", fetchImpl })

    await client.api.respondForm("ses_1", "frm/1", { a: "x" })
    await client.api.cancelForm("ses_1", "frm/1")
    expect(calls.map((call) => call.url)).toEqual([
      "https://mh.example/api/oc/api/session/ses_1/form/frm%2F1/reply",
      "https://mh.example/api/oc/api/session/ses_1/form/frm%2F1",
    ])
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ answer: { a: "x" } })
    expect(calls[1]?.init?.method).toBe("DELETE")
  })

  it("unwraps the agent catalog", async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse({ data: [{ id: "build", name: "build" }] }))
    const client = createClient({ baseUrl: "https://mh.example", fetchImpl })
    expect(await client.api.agents()).toEqual([{ id: "build", name: "build" }])
  })

  it("assembles the models, providers and default model catalog", async () => {
    const model = { id: "m1", providerID: "p", name: "M1" }
    const provider = { id: "p", name: "Provider" }
    const { calls, fetchImpl } = recordingFetch(
      () => jsonResponse({ data: [model] }),
      () => jsonResponse({ data: [provider] }),
      () => jsonResponse({ data: model }),
    )
    const client = createClient({ baseUrl: "https://mh.example", fetchImpl })

    expect(await client.api.models()).toEqual({ models: [model], providers: [provider], defaultModel: model })
    expect(calls.map((call) => call.url)).toEqual([
      "https://mh.example/api/oc/api/model",
      "https://mh.example/api/oc/api/provider",
      "https://mh.example/api/oc/api/model/default",
    ])
  })

  it("requests the active-session map", async () => {
    const { calls, fetchImpl } = recordingFetch(() =>
      jsonResponse({ data: { ses_1: { type: "running" }, ses_2: { type: "running" } } }),
    )
    const client = createClient({ baseUrl: "https://mh.example", fetchImpl })

    // `session.active()` already unwraps `{ data }`, so the client maps the
    // running sessions to the `busy` status itself.
    expect(await client.api.statuses()).toEqual({
      ses_1: { type: "busy" },
      ses_2: { type: "busy" },
    })
    expect(calls[0]?.url).toBe("https://mh.example/api/oc/api/session/active")
  })

  it("tolerates an empty active-session response", async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse({ data: {} }))
    const client = createClient({ baseUrl: "https://mh.example", fetchImpl })
    expect(await client.api.statuses()).toEqual({})
  })

  it("falls back to a localhost origin when no base URL is configured", async () => {
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse({ data: {} }))
    const client = createClient({ fetchImpl })

    await client.api.statuses()
    expect(calls[0]?.url).toBe("http://localhost/api/oc/api/session/active")
  })
})

describe("workspace routing", () => {
  it("creates an isolated session with the flag in the body", async () => {
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse({ session: { id: "ses_1" } }, 201))
    const client = createClient({ baseUrl: "https://mh.example", fetchImpl })

    const session = await client.api.sessions.create("ws_1", { isolated: true })
    expect(session).toEqual({ id: "ses_1" })
    expect(calls[0]?.url).toBe("https://mh.example/api/workspaces/ws_1/sessions")
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ isolated: true })
  })

  it("finishes an isolated session and unwraps directories", async () => {
    const { calls, fetchImpl } = recordingFetch(
      () =>
        jsonResponse({ committed: true, pushed: false, prUrl: null, branch: "b", path: "/p", error: null }),
      () => jsonResponse({ directories: ["/workspace/app", "/workspace/.worktrees/app/abc"] }),
    )
    const client = createClient({ baseUrl: "https://mh.example", fetchImpl })

    const result = await client.api.sessions.finish("ses_1")
    expect(result).toMatchObject({ committed: true, prUrl: null })
    expect(calls[0]?.url).toBe("https://mh.example/api/isolated-sessions/ses_1/finish")

    const directories = await client.api.sessions.directories("ws_1")
    expect(directories).toHaveLength(2)
    expect(calls[1]?.url).toBe("https://mh.example/api/workspaces/ws_1/directories")
  })
})

describe("workspaces", () => {
  it("unwraps the workspace list", async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse({ workspaces: [{ id: "ws_1" }] }))
    const client = createClient({ fetchImpl })
    expect(await client.workspaces.list()).toEqual([{ id: "ws_1" }])
  })

  it("adds the deleteFiles flag when removing a workspace", async () => {
    const { calls, fetchImpl } = recordingFetch(() => new Response(null, { status: 204 }))
    const client = createClient({ baseUrl: "https://mh.example", fetchImpl })
    await client.workspaces.remove("ws_1", { deleteFiles: true })
    expect(calls[0]?.url).toBe("https://mh.example/api/workspaces/ws_1?deleteFiles=1")
  })

  it("removes a workspace without the flag by default", async () => {
    const { calls, fetchImpl } = recordingFetch(() => new Response(null, { status: 204 }))
    const client = createClient({ baseUrl: "https://mh.example", fetchImpl })
    await client.workspaces.remove("ws_1")
    expect(calls[0]?.url).toBe("https://mh.example/api/workspaces/ws_1")
  })
})

describe("previews", () => {
  it("reads, starts and stops a session preview", async () => {
    const preview = { status: "running", url: "https://x.trycloudflare.com", port: 3200, error: null }
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse({ preview }))
    const client = createClient({ baseUrl: "https://mh.example", fetchImpl })

    expect(await client.api.preview("ses/1")).toEqual(preview)
    expect(await client.api.startPreview("ses/1")).toEqual(preview)
    await client.api.stopPreview("ses/1")

    const routes = calls.map((call) => `${call.init?.method ?? "GET"} ${call.url}`)
    expect(routes).toEqual([
      "GET https://mh.example/api/sessions/ses%2F1/preview",
      "POST https://mh.example/api/sessions/ses%2F1/preview",
      "DELETE https://mh.example/api/sessions/ses%2F1/preview",
    ])
  })
})

describe("audit", () => {
  it("reads the denied-command log and clears it", async () => {
    const event = {
      id: 1,
      at: 10,
      sessionID: "ses_1",
      workspaceID: null,
      kind: "permission_denied",
      command: "pkill -f node",
      reason: "Permission denied: shell",
      source: "opencode",
    }
    const { calls, fetchImpl } = recordingFetch(
      () => jsonResponse({ events: [event] }),
      () => new Response(null, { status: 204 }),
    )
    const client = createClient({ baseUrl: "https://mh.example", fetchImpl })

    expect(await client.api.audit(50)).toEqual([event])
    await client.api.clearAudit()

    expect(calls.map((call) => `${call.init?.method ?? "GET"} ${call.url}`)).toEqual([
      "GET https://mh.example/api/audit?limit=50",
      "DELETE https://mh.example/api/audit",
    ])
  })
})

describe("client error handling", () => {
  it("falls back to the HTTP status when the error body is empty", async () => {
    const { fetchImpl } = recordingFetch(() => new Response("", { status: 500 }))
    const client = createClient({ fetchImpl })
    await expect(client.api.sessions.list("ws_1")).rejects.toMatchObject({
      name: "ApiError",
      status: 500,
      message: "HTTP 500",
    })
  })

  it("uses the response body as the error message", async () => {
    const { fetchImpl } = recordingFetch(() => new Response("nope", { status: 403 }))
    const client = createClient({ fetchImpl })
    await expect(client.api.sessions.list("ws_1")).rejects.toMatchObject({ status: 403, message: "nope" })
  })

  it("does not report 401 for other error codes", async () => {
    let unauthorized = 0
    const { fetchImpl } = recordingFetch(() => new Response("boom", { status: 500 }))
    const client = createClient({ onUnauthorized: () => unauthorized++, fetchImpl })
    await expect(client.api.sessions.list("ws_1")).rejects.toBeInstanceOf(ApiError)
    expect(unauthorized).toBe(0)
  })

  it("propagates network failures untouched", async () => {
    const failure = new TypeError("fetch failed")
    const fetchImpl = (async () => {
      throw failure
    }) as typeof fetch
    const client = createClient({ fetchImpl })
    await expect(client.api.sessions.list("ws_1")).rejects.toBe(failure)
  })

  it("omits the Authorization header when no token is available", async () => {
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse({}))
    const client = createClient({ getToken: async () => null, fetchImpl })
    await client.auth.status()
    expect(new Headers(calls[0]?.init?.headers).has("authorization")).toBe(false)
  })

  it("falls back to the HTTP status when reading the error body throws", async () => {
    const response = {
      ok: false,
      status: 503,
      text: () => Promise.reject(new Error("stream failed")),
    } as unknown as Response
    const client = createClient({ fetchImpl: (async () => response) as typeof fetch })
    await expect(client.api.sessions.list("ws_1")).rejects.toMatchObject({ status: 503, message: "HTTP 503" })
  })

  it("reports 401s from opencode endpoints", async () => {
    let unauthorized = 0
    const { calls, fetchImpl } = recordingFetch(
      () => new Response("expired", { status: 401 }),
      () => new Response("", { status: 500 }),
    )
    const client = createClient({
      baseUrl: "https://mh.example",
      getToken: () => "tok_123",
      onUnauthorized: () => unauthorized++,
      fetchImpl,
    })

    // The generated client wraps fetch failures, but client-core unwraps its
    // own `ApiError` so callers keep the same contract as the BFF calls.
    const unauthorizedError = await client.api.agents().catch((error: unknown) => error)
    expect(unauthorizedError).toBeInstanceOf(ApiError)
    expect((unauthorizedError as ApiError).status).toBe(401)
    expect((unauthorizedError as ApiError).message).toBe("expired")

    const serverError = await client.api.agents().catch((error: unknown) => error)
    expect(serverError).toBeInstanceOf(ApiError)
    expect((serverError as ApiError).message).toBe("HTTP 500")

    expect(unauthorized).toBe(1)
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer tok_123")
  })

  it("exposes an event stream bound to the client", () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse({}))
    const client = createClient({ fetchImpl })
    const stream = client.eventStream({ onEvent: () => {} })
    expect(typeof stream.start).toBe("function")
    expect(typeof stream.stop).toBe("function")
    expect(stream.connected).toBe(false)
  })
})

describe("createEventStream", () => {
  it("parses server-sent events and reports connection changes", async () => {
    const events: unknown[] = []
    const states: boolean[] = []
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(': comment\n\ndata: {"type":"session.idle","data":{"sessionID":"ses_1"}}\n\n'),
        )
        controller.close()
      },
    })
    const fetchImpl = (async () =>
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch

    const stream = createEventStream({
      baseUrl: "https://mh.example",
      fetchImpl,
      getToken: () => "tok",
      onEvent: (event) => events.push(event),
      onConnectionChange: (connected) => states.push(connected),
    })
    stream.start()
    await new Promise((resolve) => setTimeout(resolve, 50))
    stream.stop()

    expect(events).toEqual([{ type: "session.idle", data: { sessionID: "ses_1" } }])
    expect(states).toEqual([true, false])
  })

  it("ignores SSE blocks without data and only starts once", async () => {
    let calls = 0
    const events: unknown[] = []
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: ping\n\ndata: {"type":"session.idle"}\n\n'))
        controller.close()
      },
    })
    const fetchImpl = (async () => {
      calls++
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
    }) as typeof fetch

    const stream = createEventStream({
      baseUrl: "https://mh.example",
      fetchImpl,
      onEvent: (event) => events.push(event),
    })
    stream.start()
    stream.start()
    await new Promise((resolve) => setTimeout(resolve, 30))
    stream.stop()

    expect(calls).toBe(1)
    expect(events).toEqual([{ type: "session.idle" }])
  })
})

describe("event stream resilience", () => {
  function sseResponse(chunks: string[]): Response {
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    })
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
  }

  it("reconnects after the upstream closes and reports connection changes", async () => {
    const states: boolean[] = []
    const connects: number[] = []
    const fetchImpl = (async () =>
      sseResponse([`data: ${JSON.stringify({ type: "server.connected" })}\n\n`])) as typeof fetch

    const stream = createEventStream({
      baseUrl: "https://mh.example",
      fetchImpl,
      reconnectBaseMs: 5,
      reconnectMaxMs: 10,
      onEvent: () => {},
      onConnectionChange: (connected) => states.push(connected),
      onConnect: () => connects.push(Date.now()),
    })
    stream.start()
    await new Promise((resolve) => setTimeout(resolve, 60))
    stream.stop()

    expect(states).toContain(true)
    expect(states).toContain(false)
    expect(connects.length).toBeGreaterThan(1)
  })

  it("attaches the bearer token and ignores non-JSON events", async () => {
    let authorization: string | undefined
    const events: unknown[] = []
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get("authorization") ?? undefined
      return sseResponse([": comment\n\ndata: not-json\n\ndata: {\"type\":\"session.idle\"}\n\n"])
    }) as typeof fetch

    const stream = createEventStream({
      baseUrl: "https://mh.example",
      fetchImpl,
      getToken: () => "tok_123",
      onEvent: (event) => events.push(event),
    })
    stream.start()
    await new Promise((resolve) => setTimeout(resolve, 30))
    stream.stop()

    expect(authorization).toBe("Bearer tok_123")
    expect(events).toEqual([{ type: "session.idle" }])
  })

  it("reports the connected state and reacts to forceReconnect", async () => {
    let calls = 0
    const states: boolean[] = []
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls++
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")))
        },
      })
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
    }) as typeof fetch

    const stream = createEventStream({
      baseUrl: "https://mh.example",
      fetchImpl,
      reconnectBaseMs: 5,
      reconnectMaxMs: 10,
      onEvent: () => {},
      onConnectionChange: (connected) => states.push(connected),
    })
    stream.start()
    await new Promise((resolve) => setTimeout(resolve, 10))
    stream.forceReconnect()
    await new Promise((resolve) => setTimeout(resolve, 30))
    stream.stop()

    expect(states).toContain(true)
    expect(states).toContain(false)
    expect(calls).toBeGreaterThan(1)
  })

  it("does not retry after stop", async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      return new Response(null, { status: 502 })
    }) as typeof fetch

    const stream = createEventStream({ baseUrl: "https://mh.example", fetchImpl, reconnectBaseMs: 5, onEvent: () => {} })
    stream.start()
    await new Promise((resolve) => setTimeout(resolve, 20))
    stream.stop()
    const callsAfterStop = calls
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(calls).toBe(callsAfterStop)
  })

  it("forceReconnect retries now instead of waiting out the grown backoff", async () => {
    let calls = 0
    // A permanently failing upstream grows the ladder: retries at 50, 100, 200…
    const fetchImpl = (async () => {
      calls++
      return new Response(null, { status: 502 })
    }) as typeof fetch

    const stream = createEventStream({
      baseUrl: "https://mh.example",
      fetchImpl,
      reconnectBaseMs: 50,
      reconnectMaxMs: 10_000,
      onEvent: () => {},
    })
    stream.start()
    // After ~260ms three attempts happened and the next one is ~90ms away.
    await new Promise((resolve) => setTimeout(resolve, 260))
    const before = calls
    stream.forceReconnect()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(calls).toBe(before + 1)

    // Once stopped the handle is inert (no zombie fetch).
    stream.stop()
    const afterStop = calls
    stream.forceReconnect()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(calls).toBe(afterStop)
  })

  it("aborts a stale connection through the watchdog", async () => {
    const states: boolean[] = []
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")))
        },
      })
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
    }) as typeof fetch

    const stream = createEventStream({
      baseUrl: "https://mh.example",
      fetchImpl,
      watchdogMs: 5,
      staleMs: 1,
      reconnectBaseMs: 1000,
      onEvent: () => {},
      onConnectionChange: (connected) => states.push(connected),
    })
    stream.start()
    await new Promise((resolve) => setTimeout(resolve, 40))
    stream.stop()

    expect(states).toContain(true)
    expect(states).toContain(false)
  })
})
