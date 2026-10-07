/**
 * Minimal circuit breaker + bounded concurrency (spec 03 §12, spec 08 §6).
 *
 * Every external dependency gets: explicit timeout, bounded retries with
 * jitter, an independent circuit breaker, and a concurrency cap — a slow
 * Ola outage must not consume the API process or exhaust sockets.
 *
 * States: CLOSED (normal) → OPEN (failing fast) → HALF_OPEN (probing).
 */

const STATE = { CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' }

export class CircuitBreaker {
  /**
   * @param {string} name provider label for logs/metrics
   * @param {object} [opts]
   * @param {number} [opts.failureThreshold=5] consecutive failures before opening
   * @param {number} [opts.resetTimeoutMs=30000] OPEN → HALF_OPEN after this
   * @param {number} [opts.halfOpenSuccesses=2] successful probes to close
   */
  constructor(name, opts = {}) {
    this.name = name
    this.failureThreshold = opts.failureThreshold ?? 5
    this.resetTimeoutMs = opts.resetTimeoutMs ?? 30000
    this.halfOpenSuccesses = opts.halfOpenSuccesses ?? 2
    this.state = STATE.CLOSED
    this.consecutiveFailures = 0
    this.halfOpenSuccessCount = 0
    this.openedAt = 0
  }

  canAttempt() {
    if (this.state === STATE.CLOSED) return true
    if (this.state === STATE.OPEN) {
      if (Date.now() - this.openedAt >= this.resetTimeoutMs) {
        this.state = STATE.HALF_OPEN
        this.halfOpenSuccessCount = 0
        return true
      }
      return false
    }
    // HALF_OPEN: allow limited probing
    return this.halfOpenSuccessCount < this.halfOpenSuccesses
  }

  recordSuccess() {
    if (this.state === STATE.HALF_OPEN) {
      this.halfOpenSuccessCount += 1
      if (this.halfOpenSuccessCount >= this.halfOpenSuccesses) {
        this.state = STATE.CLOSED
        this.consecutiveFailures = 0
      }
    } else {
      this.consecutiveFailures = 0
    }
  }

  recordFailure() {
    if (this.state === STATE.HALF_OPEN) {
      this.state = STATE.OPEN
      this.openedAt = Date.now()
      return
    }
    this.consecutiveFailures += 1
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.state = STATE.OPEN
      this.openedAt = Date.now()
    }
  }

  snapshot() {
    return {
      name: this.name,
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
    }
  }
}

/**
 * Bounded-concurrency semaphore. When full, callers get a fast retryable
 * rejection instead of thousands of queued promises eating memory
 * (spec 06 §9).
 */
export class ConcurrencyLimiter {
  constructor(max) {
    this.max = max
    this.inFlight = 0
    this.waiters = []
  }

  async acquire({ timeoutMs = 5000 } = {}) {
    if (this.inFlight < this.max) {
      this.inFlight += 1
      return
    }
    // Queue with timeout — never unbounded (spec 06 §9).
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== resolve)
        const err = new Error(`${this.name}: concurrency queue timeout`)
        err.code = 'CONCURRENCY_TIMEOUT'
        reject(err)
      }, timeoutMs)
      this.waiters.push({
        resolve: () => {
          clearTimeout(timer)
          this.inFlight += 1
          resolve()
        },
      })
    })
  }

  release() {
    const next = this.waiters.shift()
    if (next) {
      next.resolve()
      return
    }
    this.inFlight = Math.max(0, this.inFlight - 1)
  }

  snapshot() {
    return { max: this.max, inFlight: this.inFlight, queued: this.waiters.length }
  }
}

/**
 * Wrap an async operation with the breaker + limiter + timeout + bounded
 * jittered retries.
 *
 * @param {object} cfg
 * @param {CircuitBreaker} cfg.breaker
 * @param {ConcurrencyLimiter} [cfg.limiter]
 * @param {number} [cfg.timeoutMs] per-attempt timeout
 * @param {number} [cfg.retries=0] additional attempts after the first
 * @param {(err: Error) => boolean} [cfg.isRetryable] classify errors
 * @param {string} [cfg.name]
 */
export async function withProviderProtection(cfg, operation) {
  const { breaker, limiter, timeoutMs = 5000, retries = 0, isRetryable = () => false, name = 'provider' } = cfg

  if (!breaker.canAttempt()) {
    const err = new Error(`${name}: circuit open — failing fast`)
    err.code = 'CIRCUIT_OPEN'
    throw err
  }

  let attempt = 0
  for (;;) {
    let release
    try {
      if (limiter) {
        await limiter.acquire({ timeoutMs: 5000 })
        release = true
      }
      const result = await Promise.race([
        operation(),
        new Promise((_, reject) =>
          setTimeout(() => {
            const err = new Error(`${name}: timeout after ${timeoutMs}ms`)
            err.code = 'PROVIDER_TIMEOUT'
            reject(err)
          }, timeoutMs),
        ),
      ])
      breaker.recordSuccess()
      return result
    } catch (err) {
      breaker.recordFailure()
      const retryable = (isRetryable(err) || err.code === 'PROVIDER_TIMEOUT') && attempt < retries
      if (!retryable) throw err
      attempt += 1
      // Exponential backoff with full jitter (spec 08 §5).
      const base = Math.min(1000, 100 * 2 ** attempt)
      const delay = Math.random() * base
      await new Promise((resolve) => setTimeout(resolve, delay))
    } finally {
      if (release && limiter) limiter.release()
    }
  }
}
