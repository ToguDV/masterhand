import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import type { Context, MiddlewareHandler } from "hono"
import { deleteCookie, getCookie, setCookie } from "hono/cookie"
import type { Config } from "./config.js"
import type { Store } from "./store.js"

export const SESSION_COOKIE = "mh_session"

/**
 * Tokens whose `iat` lies further in the future than this are rejected: the
 * host clock jumped backwards after signing, so the token's intended lifetime
 * can no longer be trusted (issue #91). Small NTP corrections are tolerated.
 */
export const TOKEN_CLOCK_SKEW_MS = 60_000

export interface SessionTokenPayload {
  kind: "session"
  iat: number
  exp: number
}

export interface DeviceTokenPayload {
  kind: "device"
  deviceID: string
  iat: number
  exp: number
}

export type TokenPayload = SessionTokenPayload | DeviceTokenPayload

export function passwordsMatch(candidate: string, expected: string): boolean {
  const candidateHash = createHash("sha256").update(candidate).digest()
  const expectedHash = createHash("sha256").update(expected).digest()
  return timingSafeEqual(candidateHash, expectedHash)
}

function signToken(secret: string, payload: TokenPayload): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url")
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url")
  return `${encoded}.${signature}`
}

export function createSessionToken(secret: string, ttlSeconds: number, now = Date.now()): string {
  return signToken(secret, { kind: "session", iat: now, exp: now + ttlSeconds * 1000 })
}

export function createDeviceToken(
  secret: string,
  deviceID: string,
  ttlSeconds: number,
  now = Date.now(),
): string {
  return signToken(secret, { kind: "device", deviceID, iat: now, exp: now + ttlSeconds * 1000 })
}

export function verifyToken(secret: string, token: string | undefined, now = Date.now()): TokenPayload | null {
  if (!token) return null
  const [encoded, signature] = token.split(".")
  if (!encoded || !signature) return null

  const expected = createHmac("sha256", secret).update(encoded).digest("base64url")
  const providedBuffer = Buffer.from(signature)
  const expectedBuffer = Buffer.from(expected)
  if (providedBuffer.length !== expectedBuffer.length || !timingSafeEqual(providedBuffer, expectedBuffer)) {
    return null
  }

  try {
    const data = JSON.parse(Buffer.from(encoded, "base64url").toString()) as {
      kind?: unknown
      deviceID?: unknown
      iat?: unknown
      exp?: unknown
    }
    if (typeof data.exp !== "number" || data.exp <= now) return null
    const iat = typeof data.iat === "number" ? data.iat : 0
    // A token issued "in the future" means the host clock jumped backwards
    // after signing; accepting it would keep it valid past its intended life
    // (issue #91). Allow a small skew for NTP corrections.
    if (iat > now + TOKEN_CLOCK_SKEW_MS) return null
    if (data.kind === "session") return { kind: "session", iat, exp: data.exp }
    if (data.kind === "device" && typeof data.deviceID === "string") {
      return { kind: "device", deviceID: data.deviceID, iat, exp: data.exp }
    }
    return null
  } catch {
    return null
  }
}

export interface RateLimiter {
  check(key: string, now?: number): boolean
  reset(key: string): void
}

export function createRateLimiter(options: { windowMs: number; max: number }): RateLimiter {
  const attempts = new Map<string, number[]>()

  return {
    check(key, now = Date.now()) {
      const recent = (attempts.get(key) ?? []).filter((timestamp) => now - timestamp < options.windowMs)
      if (recent.length >= options.max) {
        attempts.set(key, recent)
        return false
      }
      recent.push(now)
      attempts.set(key, recent)
      return true
    },
    reset(key) {
      attempts.delete(key)
    },
  }
}

export function setSessionCookie(c: Context, token: string, config: Config): void {
  setCookie(c, SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "Strict",
    maxAge: config.sessionTtlHours * 3600,
  })
}

export function clearSessionCookie(c: Context, config: Config): void {
  deleteCookie(c, SESSION_COOKIE, {
    path: "/",
    secure: config.cookieSecure,
    sameSite: "Strict",
  })
}

function bearerToken(header: string | undefined): string | null {
  if (!header) return null
  const [scheme, value] = header.split(" ")
  if (scheme?.toLowerCase() !== "bearer" || !value) return null
  return value.trim() || null
}

/** Only the first advisory-write failure is logged, to avoid a log flood. */
let warnedTouchFailure = false

export function requireAuth(config: Config, store: Store): MiddlewareHandler {
  return async (c, next) => {
    const token = bearerToken(c.req.header("authorization"))
    if (token) {
      const payload = verifyToken(config.sessionSecret, token)
      if (!payload || payload.kind !== "device" || !store.get(payload.deviceID)) {
        return c.json({ error: "unauthorized" }, 401)
      }
      // Advisory write: a read-only/full disk must not 500 an authenticated
      // read (issue #86). Logged once; the request proceeds.
      try {
        store.touch(payload.deviceID)
      } catch (error) {
        if (!warnedTouchFailure) {
          warnedTouchFailure = true
          console.warn("[masterhand] device last-used update failed (continuing):", error)
        }
      }
      await next()
      return
    }

    const payload = verifyToken(config.sessionSecret, getCookie(c, SESSION_COOKIE))
    if (!payload || payload.kind !== "session") {
      return c.json({ error: "unauthorized" }, 401)
    }
    await next()
  }
}

export function requireSameOrigin(config: Config): MiddlewareHandler {
  const allowedHosts = new Set(
    config.allowedOrigins.map((origin) => {
      try {
        return new URL(origin).host
      } catch {
        return origin
      }
    }),
  )

  return async (c, next) => {
    const method = c.req.method
    if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
      // Bearer tokens are never attached automatically by browsers, so they are CSRF-safe.
      if (bearerToken(c.req.header("authorization"))) {
        await next()
        return
      }
      const origin = c.req.header("origin")
      if (origin) {
        let originHost: string | null = null
        try {
          originHost = new URL(origin).host
        } catch {
          originHost = null
        }
        const matchesHost = originHost !== null && originHost === c.req.header("host")
        const matchesAllowlist = originHost !== null && allowedHosts.has(originHost)
        if (!matchesHost && !matchesAllowlist) {
          return c.json({ error: "forbidden" }, 403)
        }
      }
    }
    await next()
  }
}
