import { describe, it, expect } from 'vitest'
import {
  redisApi,
  redisCache,
  redisRateLimit,
  redisGeo,
  redisPub,
  redisSub,
  redisBull,
  redisClients,
} from '../../src/config/redis.js'
import { dispatchWaves } from '../../src/config/env.js'

describe('purpose-split Redis clients (spec 03 §9)', () => {
  it('exports exactly the seven spec clients', () => {
    expect(Object.keys(redisClients).sort()).toEqual(
      [
        'redisApi',
        'redisBull',
        'redisCache',
        'redisGeo',
        'redisPub',
        'redisRateLimit',
        'redisSub',
      ].sort(),
    )
  })

  it('API client has finite retries + command timeout (no BullMQ-style blocking)', () => {
    expect(redisApi.options.maxRetriesPerRequest).toBe(3)
    expect(redisApi.options.commandTimeout).toBeGreaterThan(0)
  })

  it('BullMQ client keeps maxRetriesPerRequest: null (BullMQ requirement)', () => {
    expect(redisBull.options.maxRetriesPerRequest).toBe(null)
  })

  it('base clients connect eagerly (readiness honesty) while BullMQ stays lazy', () => {
    for (const [name, client] of Object.entries(redisClients)) {
      if (name === 'redisBull') continue
      expect(client.options.lazyConnect, name).toBe(false)
    }
    expect(redisBull.options.lazyConnect).toBe(true)
  })

  it('clients are distinct ioredis instances, not shared duplicates of one', () => {
    const set = new Set(Object.values(redisClients))
    expect(set.size).toBe(7)
  })

  it('pub/sub clients allow unlimited retries per request (adapter requirement)', () => {
    expect(redisPub.options.maxRetriesPerRequest).toBe(null)
    expect(redisSub.options.maxRetriesPerRequest).toBe(null)
  })
})

describe('dispatch wave parsing (spec 04 §13)', () => {
  it('parses env-configured radius/size pairs', () => {
    const waves = dispatchWaves()
    expect(waves.length).toBeGreaterThanOrEqual(3)
    expect(waves[0]).toEqual({ radiusM: 1500, size: 8 })
    expect(waves[1]).toEqual({ radiusM: 3000, size: 16 })
    expect(waves[2]).toEqual({ radiusM: 6000, size: 32 })
  })

  it('radii are non-decreasing (waves expand, spec 04 §13)', () => {
    const waves = dispatchWaves()
    for (let i = 1; i < waves.length; i++) {
      expect(waves[i].radiusM).toBeGreaterThanOrEqual(waves[i - 1].radiusM)
    }
  })
})
