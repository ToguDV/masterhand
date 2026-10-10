import { describe, expect, it } from "vitest"
import { ApiError, RequestTimeoutError, createClient } from "../src/client"
import { websearchSaveErrorMessage, websearchTestErrorMessage } from "../src/errors"
import {
  KEYLESS_WEBSEARCH_PROVIDER,
  isKeylessWebsearchSource,
  normalizeWebsearchSelection,
  normalizeWebsearchSources,
  normalizeWebsearchTestResult,
} from "../src/websearch"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

type FetchCall = { url: string; init?: RequestInit }

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

describe("normalizeWebsearchSources ", () => {
  it("keeps valid entries, defaults the name and flags the keyless source", () => {
    expect(
      normalizeWebsearchSources([
        { id: "exa", name: "Exa" },
        { id: "tinyfish", name: "TinyFish" },
        { id: "firecrawl" },
      ]),
    ).toEqual([
      { id: "exa", name: "Exa", keyless: false },
      { id: "tinyfish", name: "TinyFish", keyless: true },
      { id: "firecrawl", name: "firecrawl", keyless: false },
    ])
  })

  it("drops malformed and duplicate entries", () => {
    expect(normalizeWebsearchSources([{ name: "no id" }, { id: "a" }, { id: "a" }, "nope", null])).toEqual([
      { id: "a", name: "a", keyless: false },
    ])
    expect(normalizeWebsearchSources(undefined)).toEqual([])
  })

  it("knows the keyless provider", () => {
    expect(KEYLESS_WEBSEARCH_PROVIDER).toBe("tinyfish")
    expect(isKeylessWebsearchSource("tinyfish")).toBe(true)
    expect(isKeylessWebsearchSource(" TinyFish ")).toBe(true)
    expect(isKeylessWebsearchSource("exa")).toBe(false)
  })
})

describe("normalizeWebsearchSelection ", () => {
  it("reads ids, `random`, disabled and unset states", () => {
    expect(normalizeWebsearchSelection({ provider: "tavily" })).toBe("tavily")
    expect(normalizeWebsearchSelection({ provider: "random" })).toBe("random")
    expect(normalizeWebsearchSelection({ provider: false })).toBe(false)
    expect(normalizeWebsearchSelection({ provider: null })).toBeNull()
    expect(normalizeWebsearchSelection({})).toBeNull()
    expect(normalizeWebsearchSelection({ provider: 42 })).toBeNull()
    expect(normalizeWebsearchSelection(undefined)).toBeNull()
  })
})

describe("normalizeWebsearchTestResult ", () => {
  it("keeps usable results and drops entries without a url", () => {
    expect(
      normalizeWebsearchTestResult({
        providerID: "tinyfish",
        results: [
          { url: "https://a.example", title: "A", content: "text", time: { published: 123 } },
          { url: "https://b.example" },
          { nope: true },
        ],
      }),
    ).toEqual({
      providerID: "tinyfish",
      results: [
        { url: "https://a.example", title: "A", content: "text", published: 123 },
        { url: "https://b.example" },
      ],
    })
  })

  it("returns null for unusable payloads", () => {
    expect(normalizeWebsearchTestResult(null)).toBeNull()
    expect(normalizeWebsearchTestResult({ results: "nope" })).toBeNull()
  })
})

describe("websearch error messages ", () => {
  it("frames a timeout as ambiguous, never a hard failure", () => {
    expect(websearchSaveErrorMessage(new RequestTimeoutError())).toMatch(/may have been saved/)
    expect(websearchSaveErrorMessage(new ApiError(500, "boom"))).toBe("Could not save the default source")
  })

  it("explains a missing selection, a disabled config and upstream failures", () => {
    expect(websearchTestErrorMessage(new ApiError(400, '{"error":"websearch_provider_required"}'))).toMatch(
      /no default source/i,
    )
    expect(websearchTestErrorMessage(new ApiError(400, '{"error":"websearch_disabled"}'))).toMatch(/disabled/i)
    expect(websearchTestErrorMessage(new ApiError(503, '{"error":"service_unavailable"}'))).toMatch(/rate/)
    expect(websearchTestErrorMessage(new RequestTimeoutError())).toMatch(/timed out/i)
    expect(websearchTestErrorMessage(new Error("x"))).toBe("Could not run the test search")
  })
})

describe("client websearch api ", () => {
  it("reads and saves the default selection through the BFF", async () => {
    const { calls, fetchImpl } = recordingFetch(
      () => jsonResponse({ provider: "tavily" }),
      () => jsonResponse({ provider: "random" }),
    )
    const client = createClient({ baseUrl: "https://mh.example", fetchImpl })

    expect(await client.api.websearchSettings()).toBe("tavily")
    expect(calls[0]?.url).toBe("https://mh.example/api/websearch")

    expect(await client.api.saveWebsearchSettings("random")).toBe("random")
    expect(calls[1]?.url).toBe("https://mh.example/api/websearch")
    expect(calls[1]?.init?.method).toBe("PUT")
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ provider: "random" })
  })

  it("lists sources and runs a test query through the opencode proxy", async () => {
    const { calls, fetchImpl } = recordingFetch(
      () => jsonResponse({ location: { directory: "/e2e" }, data: [{ id: "tinyfish", name: "TinyFish" }] }),
      () =>
        jsonResponse({
          location: { directory: "/e2e" },
          data: { providerID: "tinyfish", results: [{ url: "https://a.example", title: "A" }] },
        }),
    )
    const client = createClient({ baseUrl: "https://mh.example", fetchImpl })

    expect(await client.api.websearchSources()).toEqual([
      { id: "tinyfish", name: "TinyFish", keyless: true },
    ])
    expect(calls[0]?.url).toBe("https://mh.example/api/oc/api/websearch/provider")

    expect(await client.api.testWebsearch("effect typescript")).toEqual({
      providerID: "tinyfish",
      results: [{ url: "https://a.example", title: "A" }],
    })
    expect(calls[1]?.url).toBe("https://mh.example/api/oc/api/websearch")
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ query: "effect typescript" })
  })
})
