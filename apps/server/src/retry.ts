/**
 * Bounded retry with incremental backoff for every BFF → opencode call.
 *
 * This is shared infrastructure, not a per-feature helper: idempotent calls
 * retry transient failures (network resets, rate limits, upstream outages) on
 * their own, and non-idempotent mutations pass a `reconcile` callback so the
 * outcome is proven through a server-persisted marker before a retry can
 * duplicate it (see `docs/past-mistakes.md`, rule 4/10 exception).
 *
 * Timeouts are ambiguous by default (`isTransientFailure` excludes them):
 * only callers that can reconcile the outcome opt in with
 * `{ includeTimeouts: true }`.
 */

/** An internal opencode call exceeded `OPENCODE_TIMEOUT_MS`. */
export class OpencodeTimeoutError extends Error {
  constructor() {
    super("opencode call timed out")
    this.name = "OpencodeTimeoutError"
  }
}

/** opencode answered with an HTTP status the caller may want to retry. */
export class UpstreamStatusError extends Error {
  constructor(
    readonly status: number,
    readonly response?: Response,
  ) {
    super(`opencode responded ${status}`)
    this.name = "UpstreamStatusError"
  }
}

/** The attempt budget ran out; `lastError` carries the final failure. */
export class RetryExhaustedError extends Error {
  constructor(
    readonly attempts: number,
    readonly lastError: unknown,
  ) {
    super(`retry exhausted after ${attempts} attempts (${describeError(lastError)})`)
    this.name = "RetryExhaustedError"
  }
}

/**
 * A non-idempotent mutation failed and its reconciliation could not prove
 * whether it landed (marker lookup unreachable). The operation is NEVER
 * replayed in this state: the caller must surface an ambiguity and let the
 * user decide (rule 4). `cause` is the original mutation failure.
 */
export class AmbiguousMutationError extends Error {
  constructor(
    override readonly cause: unknown,
    readonly reconcileError: unknown,
  ) {
    super(`cannot confirm whether the mutation landed (${describeError(reconcileError)})`)
    this.name = "AmbiguousMutationError"
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504])

/** True for statuses where retrying is the expected recovery (rate limit, outage). */
export function isTransientStatus(status: number): boolean {
  return TRANSIENT_STATUSES.has(status)
}

/**
 * Default retry classification: transient statuses and quick network failures.
 * Timeouts are only retried when the caller can reconcile first, because a
 * timeout means the mutation may have applied and a blind retry duplicates it.
 */
export function isTransientFailure(error: unknown, options: { includeTimeouts?: boolean } = {}): boolean {
  if (error instanceof UpstreamStatusError) return isTransientStatus(error.status)
  const name = (error as { name?: unknown } | null)?.name
  if (error instanceof OpencodeTimeoutError || name === "TimeoutError") {
    return options.includeTimeouts === true
  }
  // fetch network failures (connection refused/reset) surface as TypeError.
  return error instanceof TypeError
}

export interface RetryInfo {
  attempt: number
  delayMs: number
  error: unknown
}

export interface RetryOptions<T> {
  /** Total attempts, including the first one. Default 4. */
  attempts?: number
  /** First backoff delay. Default 250 ms. */
  baseDelayMs?: number
  /** Backoff multiplier. Default 2. */
  factor?: number
  /** Backoff ceiling. Default 30 s. */
  maxDelayMs?: number
  /** Randomize each delay up to ±25% so parallel callers do not sync. Default true. */
  jitter?: boolean
  /** Injectable sleeper (tests record delays instead of waiting). */
  sleep?: (ms: number) => Promise<void>
  shouldRetry?: (error: unknown) => boolean
  /**
   * Proves whether a failed non-idempotent mutation already landed (marker
   * lookup in opencode). A defined result resolves the operation; `undefined`
   * lets the retry continue — but ONLY when the lookup itself succeeded.
   * A throwing lookup means the outcome is unknown: the retry aborts with
   * `AmbiguousMutationError` instead of risking a duplicate (rule 4).
   */
  reconcile?: (error: unknown) => Promise<T | undefined> | T | undefined
  onRetry?: (info: RetryInfo) => void
}

function backoffDelay(
  baseDelayMs: number,
  factor: number,
  maxDelayMs: number,
  attempt: number,
  jitter: boolean,
): number {
  const raw = Math.min(maxDelayMs, baseDelayMs * factor ** (attempt - 1))
  if (!jitter) return raw
  return Math.round(raw * (0.75 + Math.random() * 0.5))
}

/**
 * Runs `operation` with bounded retries. On a non-retryable failure the
 * original error is thrown; when the attempt budget runs out the last failure
 * is wrapped in `RetryExhaustedError` (callers can read `lastError`, e.g. to
 * relay the final upstream response).
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions<T> = {},
): Promise<T> {
  const attempts = Math.max(1, Math.trunc(options.attempts ?? 4))
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 250)
  const factor = Math.max(1, options.factor ?? 2)
  const maxDelayMs = Math.max(0, options.maxDelayMs ?? 30_000)
  const jitter = options.jitter ?? true
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const shouldRetry = options.shouldRetry ?? isTransientFailure

  let lastError: unknown
  let exhausted = true

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt)
    } catch (error) {
      lastError = error

      if (options.reconcile) {
        let landed: T | undefined
        try {
          landed = await options.reconcile(error)
        } catch (reconcileError) {
          // The outcome is unknown. Replaying now could duplicate a mutation
          // that actually landed; abort instead and let the caller surface it.
          throw new AmbiguousMutationError(error, reconcileError)
        }
        if (landed !== undefined) return landed
      }

      if (attempt >= attempts || !shouldRetry(error)) {
        exhausted = attempt >= attempts && shouldRetry(error)
        break
      }

      const delayMs = backoffDelay(baseDelayMs, factor, maxDelayMs, attempt, jitter)
      options.onRetry?.({ attempt, delayMs, error })
      await sleep(delayMs)
    }
  }

  if (exhausted) throw new RetryExhaustedError(attempts, lastError)
  throw lastError
}
