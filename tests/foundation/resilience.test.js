import { describe, it, expect, vi } from 'vitest'
import { CircuitBreaker, ConcurrencyLimiter, withProviderProtection } from '../../src/utils/resilience.js'

describe('circuit breaker (spec 03 §12, spec 08 §6)', () => {
  it('opens after N consecutive failures and fails fast', async () => {
    const breaker = new CircuitBreaker('test', { failureThreshold: 3, resetTimeoutMs: 60000 })
    const failing = async () => {
      throw new Error('boom')
    }
    for (let i = 0; i < 3; i++) {
      await expect(withProviderProtection({ breaker, name: 'test' }, failing)).rejects.toThrow('boom')
    }
    expect(breaker.state).toBe('OPEN')
    // Next attempt fails fast WITHOUT calling the operation.
    let called = false
    await expect(
      withProviderProtection({ breaker, name: 'test' }, async () => {
        called = true
        return 1
      }),
    ).rejects.toThrow('circuit open')
    expect(called).toBe(false)
  })

  it('half-open probes close the breaker after successes', async () => {
    const breaker = new CircuitBreaker('test2', { failureThreshold: 1, resetTimeoutMs: 0, halfOpenSuccesses: 2 })
    await expect(
      withProviderProtection({ breaker, name: 't2' }, async () => Promise.reject(new Error('x'))),
    ).rejects.toThrow('x')
    expect(breaker.state).toBe('OPEN')
    // resetTimeoutMs=0 → immediate half-open probe
    await withProviderProtection({ breaker, name: 't2' }, async () => 1)
    await withProviderProtection({ breaker, name: 't2' }, async () => 1)
    expect(breaker.state).toBe('CLOSED')
  })

  it('successful calls reset the consecutive failure count', async () => {
    const breaker = new CircuitBreaker('test3', { failureThreshold: 2 })
    await expect(
      withProviderProtection({ breaker, name: 't3' }, async () => Promise.reject(new Error('x'))),
    ).rejects.toThrow()
    await withProviderProtection({ breaker, name: 't3' }, async () => 1)
    await expect(
      withProviderProtection({ breaker, name: 't3' }, async () => Promise.reject(new Error('x'))),
    ).rejects.toThrow()
    expect(breaker.state).toBe('CLOSED') // 1 < 2
  })
})

describe('bounded retries with jitter', () => {
  it('retries retryable errors up to the limit then succeeds', async () => {
    const breaker = new CircuitBreaker('t4', { failureThreshold: 10 })
    let calls = 0
    const result = await withProviderProtection(
      { breaker, name: 't4', retries: 3, isRetryable: () => true },
      async () => {
        calls += 1
        if (calls < 3) throw new Error('transient')
        return 'ok'
      },
    )
    expect(result).toBe('ok')
    expect(calls).toBe(3)
  })

  it('does not retry non-retryable errors', async () => {
    const breaker = new CircuitBreaker('t5', { failureThreshold: 10 })
    let calls = 0
    await expect(
      withProviderProtection(
        { breaker, name: 't5', retries: 5, isRetryable: () => false },
        async () => {
          calls += 1
          throw new Error('permanent')
        },
      ),
    ).rejects.toThrow('permanent')
    expect(calls).toBe(1)
  })

  it('enforces per-attempt timeout', async () => {
    const breaker = new CircuitBreaker('t6', { failureThreshold: 10 })
    await expect(
      withProviderProtection(
        { breaker, name: 't6', timeoutMs: 50, retries: 0 },
        () => new Promise((resolve) => setTimeout(resolve, 5000)),
      ),
    ).rejects.toThrow('timeout')
  })
})

describe('concurrency limiter (spec 06 §9)', () => {
  it('caps concurrent operations and queues the rest', async () => {
    const limiter = new ConcurrencyLimiter(2)
    let running = 0
    let peak = 0
    const job = async () => {
      await limiter.acquire()
      running += 1
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 20))
      running -= 1
      limiter.release()
    }
    await Promise.all(Array.from({ length: 8 }, job))
    expect(peak).toBe(2)
  })

  it('queue waiters time out instead of waiting forever', async () => {
    const limiter = new ConcurrencyLimiter(1)
    await limiter.acquire() // hold the single slot
    const queued = limiter.acquire({ timeoutMs: 50 }).catch((e) => e)
    const err = await queued
    expect(err.code).toBe('CONCURRENCY_TIMEOUT')
    limiter.release()
  })
})
