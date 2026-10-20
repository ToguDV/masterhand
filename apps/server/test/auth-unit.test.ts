import { createHmac } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import {
  createDeviceToken,
  createRateLimiter,
  createSessionToken,
  passwordsMatch,
  verifyToken,
} from "../src/auth.js"

function sign(secret: string, payload: unknown): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url")
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url")
  return `${encoded}.${signature}`
}

describe("passwordsMatch", () => {
  it("compares equal and different strings", () => {
    expect(passwordsMatch("secret", "secret")).toBe(true)
    expect(passwordsMatch("secret", "other")).toBe(false)
    expect(passwordsMatch("", "")).toBe(true)
  })
})

describe("verifyToken", () => {
  const secret = "unit-secret"
  const now = 1_000_000

  it("verifies a session token", () => {
    const token = createSessionToken(secret, 60, now)
    expect(verifyToken(secret, token, now)).toMatchObject({ kind: "session", iat: now, exp: now + 60_000 })
  })

  it("verifies a device token", () => {
    const token = createDeviceToken(secret, "dev_1", 60, now)
    expect(verifyToken(secret, token, now)).toMatchObject({ kind: "device", deviceID: "dev_1" })
  })

  it("rejects expired tokens", () => {
    const token = createSessionToken(secret, 1, now)
    expect(verifyToken(secret, token, now + 2000)).toBeNull()
  })

  it("rejects a token signed with another secret", () => {
    const token = createSessionToken("other-secret", 60, now)
    expect(verifyToken(secret, token, now)).toBeNull()
  })

  it("rejects missing and malformed tokens", () => {
    expect(verifyToken(secret, undefined, now)).toBeNull()
    expect(verifyToken(secret, "no-dot", now)).toBeNull()
    expect(verifyToken(secret, "only.", now)).toBeNull()
  })

  it("rejects a signature of the wrong length", () => {
    const [encoded] = createSessionToken(secret, 60, now).split(".")
    expect(verifyToken(secret, `${encoded}.x`, now)).toBeNull()
  })

  it("rejects unknown token kinds", () => {
    expect(verifyToken(secret, sign(secret, { kind: "root", exp: now + 1000 }), now)).toBeNull()
  })

  it("rejects device tokens without a string id", () => {
    expect(verifyToken(secret, sign(secret, { kind: "device", deviceID: 42, exp: now + 1000 }), now)).toBeNull()
  })

  it("rejects payloads without a numeric expiry", () => {
    expect(verifyToken(secret, sign(secret, { kind: "session" }), now)).toBeNull()
  })

  it("rejects payloads that are not JSON", () => {
    const encoded = Buffer.from("not json").toString("base64url")
    const signature = createHmac("sha256", secret).update(encoded).digest("base64url")
    expect(verifyToken(secret, `${encoded}.${signature}`, now)).toBeNull()
  })

  it("rejects a token issued implausibly in the future (clock jump)", () => {
    const future = createSessionToken(secret, 3600, now + 10 * 60_000)
    expect(verifyToken(secret, future, now)).toBeNull()
    // A small skew (NTP correction) is still accepted.
    const skewed = createSessionToken(secret, 3600, now + 30_000)
    expect(verifyToken(secret, skewed, now)).toMatchObject({ kind: "session" })
  })
})

describe("createRateLimiter", () => {
  it("blocks only after the failure budget is exhausted", () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 2 })
    expect(limiter.isBlocked("ip", 0)).toBe(false)
    limiter.recordFailure("ip", 10)
    expect(limiter.isBlocked("ip", 20)).toBe(false)
    limiter.recordFailure("ip", 20)
    expect(limiter.isBlocked("ip", 30)).toBe(true)
  })

  it("frees the slot once the window slides", () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 1 })
    limiter.recordFailure("ip", 0)
    expect(limiter.isBlocked("ip", 500)).toBe(true)
    expect(limiter.isBlocked("ip", 1500)).toBe(false)
  })

  it("tracks keys independently and can reset them", () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 1 })
    limiter.recordFailure("a", 0)
    limiter.recordFailure("b", 0)
    expect(limiter.isBlocked("a", 0)).toBe(true)
    expect(limiter.isBlocked("b", 0)).toBe(true)
    limiter.reset("a")
    expect(limiter.isBlocked("a", 0)).toBe(false)
    expect(limiter.isBlocked("b", 0)).toBe(true)
  })

  it("bounds the key map, dropping the least recently failed key", () => {
    const limiter = createRateLimiter({ windowMs: 10_000, max: 1, maxKeys: 2 })
    limiter.recordFailure("a", 0)
    limiter.recordFailure("b", 1)
    limiter.recordFailure("a", 2) // refresh a; b is now the oldest
    limiter.recordFailure("c", 3) // evicts b
    expect(limiter.size()).toBe(2)
    expect(limiter.isBlocked("a", 4)).toBe(true)
    expect(limiter.isBlocked("b", 4)).toBe(false)
    expect(limiter.isBlocked("c", 4)).toBe(true)
  })

  it("evicts keys whose failures fell outside the window", () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 1 })
    limiter.recordFailure("a", 0)
    limiter.recordFailure("b", 10)
    expect(limiter.size()).toBe(2)
    // A failure far past the window triggers a sweep of stale keys.
    limiter.recordFailure("c", 5000)
    expect(limiter.size()).toBe(1)
  })

  it("bounds the number of tracked keys (LRU)", () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 5, maxKeys: 2 })
    limiter.recordFailure("a", 0)
    limiter.recordFailure("b", 1)
    limiter.recordFailure("c", 2)
    expect(limiter.size()).toBe(2)
    // "a" was the least recently seen and its budget was dropped.
    expect(limiter.isBlocked("a", 3)).toBe(false)
  })

  it("uses Date.now by default", () => {
    vi.useFakeTimers()
    try {
      const limiter = createRateLimiter({ windowMs: 1000, max: 1 })
      expect(limiter.isBlocked("ip")).toBe(false)
      limiter.recordFailure("ip")
      expect(limiter.isBlocked("ip")).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
