import { describe, expect, it } from "vitest"
import {
  AmbiguousMutationError,
  OpencodeTimeoutError,
  RetryExhaustedError,
  UpstreamStatusError,
  isTransientFailure,
  isTransientStatus,
  withRetry,
} from "../src/retry.js"

/** Records every sleep instead of waiting, so backoff is assertable. */
function fakeSleep(): { delays: number[]; sleep: (ms: number) => Promise<void> } {
  const delays: number[] = []
  return {
    delays,
    sleep: async (ms) => {
      delays.push(ms)
    },
  }
}

describe("isTransientStatus", () => {
  it("classifies rate limits, timeouts and upstream outages as transient", () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504]) {
      expect(isTransientStatus(status), `status ${status}`).toBe(true)
    }
  })

  it("leaves other 4xx and success statuses alone", () => {
    for (const status of [200, 201, 204, 400, 401, 403, 404, 409, 422]) {
      expect(isTransientStatus(status), `status ${status}`).toBe(false)
    }
  })
})

describe("isTransientFailure", () => {
  it("retries transient statuses and network failures", () => {
    expect(isTransientFailure(new UpstreamStatusError(429))).toBe(true)
    expect(isTransientFailure(new UpstreamStatusError(503))).toBe(true)
    expect(isTransientFailure(new TypeError("fetch failed"))).toBe(true)
  })

  it("does not retry defined client errors", () => {
    expect(isTransientFailure(new UpstreamStatusError(400))).toBe(false)
    expect(isTransientFailure(new UpstreamStatusError(404))).toBe(false)
    expect(isTransientFailure(new Error("boom"))).toBe(false)
  })

  it("leaves timeouts out unless the caller can reconcile", () => {
    expect(isTransientFailure(new OpencodeTimeoutError())).toBe(false)
    expect(isTransientFailure(new OpencodeTimeoutError(), { includeTimeouts: true })).toBe(true)
    const abort = new Error("The operation was aborted due to timeout")
    abort.name = "TimeoutError"
    expect(isTransientFailure(abort)).toBe(false)
    expect(isTransientFailure(abort, { includeTimeouts: true })).toBe(true)
  })
})

describe("withRetry", () => {
  it("retries transient failures with incremental backoff and returns the success", async () => {
    const { delays, sleep } = fakeSleep()
    let calls = 0
    const result = await withRetry(
      async () => {
        calls += 1
        if (calls < 3) throw new UpstreamStatusError(429)
        return "ok"
      },
      { sleep, jitter: false, baseDelayMs: 250, attempts: 5 },
    )

    expect(result).toBe("ok")
    expect(calls).toBe(3)
    expect(delays).toEqual([250, 500])
  })

  it("caps the backoff delay", async () => {
    const { delays, sleep } = fakeSleep()
    let calls = 0
    await expect(
      withRetry(
        async () => {
          calls += 1
          throw new UpstreamStatusError(503)
        },
        { sleep, jitter: false, baseDelayMs: 100, factor: 2, maxDelayMs: 250, attempts: 5 },
      ),
    ).rejects.toBeInstanceOf(RetryExhaustedError)
    expect(delays).toEqual([100, 200, 250, 250])
  })

  it("gives up after the attempt budget with a typed error carrying the last failure", async () => {
    const { sleep } = fakeSleep()
    let calls = 0
    const failure = await withRetry(
      async () => {
        calls += 1
        throw new UpstreamStatusError(429, new Response("rate limited", { status: 429 }))
      },
      { sleep, jitter: false, attempts: 3 },
    ).catch((error: unknown) => error)

    expect(calls).toBe(3)
    expect(failure).toBeInstanceOf(RetryExhaustedError)
    const exhausted = failure as RetryExhaustedError
    expect(exhausted.attempts).toBe(3)
    expect(exhausted.lastError).toBeInstanceOf(UpstreamStatusError)
    expect((exhausted.lastError as UpstreamStatusError).response?.status).toBe(429)
  })

  it("throws the original error immediately when it is not retryable", async () => {
    const { delays, sleep } = fakeSleep()
    const original = new UpstreamStatusError(400)
    let calls = 0
    const failure = await withRetry(
      async () => {
        calls += 1
        throw original
      },
      { sleep, jitter: false, attempts: 5 },
    ).catch((error: unknown) => error)

    expect(failure).toBe(original)
    expect(calls).toBe(1)
    expect(delays).toEqual([])
  })

  it("resolves through reconcile when the mutation already landed", async () => {
    const { delays, sleep } = fakeSleep()
    let calls = 0
    let reconciles = 0
    const result = await withRetry(
      async () => {
        calls += 1
        throw new OpencodeTimeoutError()
      },
      {
        sleep,
        jitter: false,
        attempts: 4,
        shouldRetry: (error) => isTransientFailure(error, { includeTimeouts: true }),
        reconcile: async () => {
          reconciles += 1
          return "landed"
        },
      },
    )

    expect(result).toBe("landed")
    expect(calls).toBe(1)
    expect(reconciles).toBe(1)
    expect(delays).toEqual([])
  })

  it("retries when reconcile proves the mutation did not land", async () => {
    const { delays, sleep } = fakeSleep()
    let calls = 0
    const result = await withRetry(
      async () => {
        calls += 1
        if (calls === 1) throw new OpencodeTimeoutError()
        return "ok"
      },
      {
        sleep,
        jitter: false,
        attempts: 3,
        shouldRetry: (error) => isTransientFailure(error, { includeTimeouts: true }),
        reconcile: async () => undefined,
      },
    )

    expect(result).toBe("ok")
    expect(calls).toBe(2)
    expect(delays).toEqual([250])
  })

  it("aborts without replaying when reconciliation itself fails (unknown outcome)", async () => {
    const { delays, sleep } = fakeSleep()
    let calls = 0
    const original = new TypeError("fetch failed")
    const failure = await withRetry(
      async () => {
        calls += 1
        throw original
      },
      {
        sleep,
        jitter: false,
        attempts: 3,
        reconcile: async () => {
          throw new Error("the marker lookup is down too")
        },
      },
    ).catch((error: unknown) => error)

    expect(calls).toBe(1)
    expect(failure).toBeInstanceOf(AmbiguousMutationError)
    expect((failure as AmbiguousMutationError).cause).toBe(original)
    expect(delays).toEqual([])
  })

  it("reports every retry for observability", async () => {
    const { sleep } = fakeSleep()
    const retries: Array<{ attempt: number; delayMs: number }> = []
    await withRetry(
      async (attempt) => {
        if (attempt < 3) throw new UpstreamStatusError(429)
        return "ok"
      },
      {
        sleep,
        jitter: false,
        baseDelayMs: 100,
        attempts: 4,
        onRetry: (info) => retries.push({ attempt: info.attempt, delayMs: info.delayMs }),
      },
    )

    expect(retries).toEqual([
      { attempt: 1, delayMs: 100 },
      { attempt: 2, delayMs: 200 },
    ])
  })

  it("never sleeps when attempts is 1", async () => {
    const { delays, sleep } = fakeSleep()
    await expect(
      withRetry(async () => {
        throw new TypeError("fetch failed")
      }, { sleep, attempts: 1 }),
    ).rejects.toBeInstanceOf(RetryExhaustedError)
    expect(delays).toEqual([])
  })
})
